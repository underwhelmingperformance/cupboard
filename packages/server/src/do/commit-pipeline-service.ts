import { type Logger } from '@cupboard/logger';
import { narFingerprint } from '@cupboard/nix-store/narinfo';
import { type NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type NarInfoGeneration,
	narInfoGenerationSchema,
	type NixSha256HashString,
	type RootName,
	signingKeyGenerationSchema,
	type StorePathHash,
	type StorePathString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { type TenantStatus } from '@cupboard/protocol/tenants';
import {
	type CommitResponse,
	type SessionId,
	type UploadGraceFact,
	type UploadId,
	type UploadPathNegotiation
} from '@cupboard/protocol/upload';
import {
	and,
	eq,
	exists,
	gte,
	inArray,
	isNull,
	ne,
	notExists,
	or,
	sql
} from 'drizzle-orm';
import { type BatchItem } from 'drizzle-orm/batch';

import { signNixFingerprint } from '../crypto/crypto.ts';
import {
	cacheIdentityColumns,
	cacheIdentityCondition,
	type ResolvedCache
} from '../db/cache.ts';
import { currentCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	NarTooLargeError,
	QuotaExceededError,
	TenantWritesStoppedError,
	UploadCacheMismatchError,
	UploadedObjectNotFoundError,
	UploadExpiredError,
	UploadNotFoundError
} from '../errors.ts';
import {
	narObjectKey,
	type R2ObjectKey,
	verifiableMaxBytes
} from '../http/http.ts';
import type { MaintenanceQueueMessage } from '../routing/scheduled.ts';

import { armAlarmNoLaterThan } from './alarm.ts';
import { batchNonEmpty, chunk, maxInClauseValues } from './bulk.ts';
import { sendCommitSessionFrame } from './commit-socket.ts';
import {
	type MaterialiseOutcome,
	type ReserveOutcome,
	type ServerContext
} from './context.ts';
import {
	capturedGraceFact,
	confirmGrace,
	type GraceDecision,
	parseStoredGraceDecision,
	storedGraceDeadlines,
	storedGraceFact
} from './grace-decision.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type RetentionService } from './retention-service.ts';
import { maxRootTargetInsertRows } from './roots-service.ts';
import { type SigningKeysService } from './signing-keys-service.ts';
import { affordableOperations } from './statement-scope.ts';
import { parseStoredUploadPathMetadata } from './upload-metadata.ts';
import { type UploadStateService } from './upload-state-service.ts';

// Keep this shorter than `verifyBackstopDelayMs`. When the alarm backstop
// fires, the previous queue request must be stale so the alarm can send again.
export const verifyRequestStaleMs = 45_000;

// Every deferral stores this deadline. The alarm reissues verification when a
// queue message is lost, dead-lettered, or forgotten after instance eviction.
export const verifyBackstopKey = 'maintenance:verify-pending';
export const verifyBackstopDelayMs = 60_000;

/**
 * Reports a final commit response immediately, or tells the caller to wait for
 * the verification pass.
 */
// Include `grace` only when the client negotiated grace facts. Older clients
// must receive the original frame shape.
export type CommitOutcome =
	| {
			readonly kind: 'settled';
			readonly response: CommitResponse;
			readonly grace?: UploadGraceFact;
	  }
	| {
			readonly kind: 'deferred';
			readonly storePathHash: StorePathHash;
			readonly narHash: NixSha256HashString;
			readonly grace?: UploadGraceFact;
	  };

export interface TenantAccount {
	readonly status: (typeof d1Schema.tenant.$inferSelect)['status'];
	readonly bytes: number | null;
	readonly casBytes: number | null;
	readonly quotaBytes: number | null;
}

interface CanonicalBlobFacts {
	readonly fileHash: NixSha256HashString;
	readonly fileSize: number;
	readonly compression: (typeof d1Schema.blobState.$inferSelect)['compression'];
	readonly incarnation: number;
}

export interface MaterialiseRequest {
	readonly cache: ResolvedCache;
	readonly metadata: UploadPathNegotiation;
	readonly generation: NarInfoGeneration;
	readonly probe: MaterialisationProbe;
	readonly mustOwnBlob: boolean;
	/**
	 * Apply this negotiated decision in the same gate as materialisation.
	 * `undefined` identifies a legacy row and grants no grace.
	 */
	readonly graceDecision: GraceDecision | undefined;
	/**
	 * Attach the path to the run root selected at negotiation while the
	 * materialised generation is still protected by the gate. `undefined` means
	 * that the push selected no run root.
	 */
	readonly attachRootName: RootName | undefined;
	/**
	 * Return false to report `gone` without charging. This runs inside the flush
	 * gate and must stay synchronous so no event can change the row between this
	 * check and the generation fence.
	 */
	readonly isStillSettleable?: () => boolean;
}

export type BatchedMaterialiseOutcome =
	| MaterialiseOutcome
	| { readonly kind: 'gone' }
	// The invocation's allowance cannot cover this request. The caller leaves the
	// upload pending so a later verification pass can settle it.
	| { readonly kind: 'deferred' };

type ChargeOutcome =
	| { readonly kind: 'charged' }
	| { readonly kind: 'over-quota' }
	| {
			readonly kind: 'tenant-inactive';
			readonly tenantStatus: TenantStatus | undefined;
	  };

type BatchChargeOutcome =
	| Exclude<ChargeOutcome, { kind: 'over-quota' }>
	| { readonly kind: 'retry-individually' };

interface PendingMaterialise {
	readonly request: MaterialiseRequest;
	readonly resolve: (outcome: BatchedMaterialiseOutcome) => void;
	readonly reject: (error: unknown) => void;
}

// Each materialisation adds five statements, and the charge batch adds one for
// the tenant status read. A flush also reads the tenant account before it takes
// the gate.
const statementsPerMaterialise = 5;
const materialiseFlushOverheadStatements = 2;

// A flush handles at most this many requests to stay below D1's parameter
// limit. The remaining statement allowance can reduce the batch further.
const materialiseFlushCap = 32;

// Bound winner re-resolution so repeated recommits cannot pin one request.
const concedeAttemptLimit = 3;

class MaterialiseFlushOutcomeMissingError extends Error {
	constructor() {
		super('materialise flush produced no outcome for a request');
		this.name = 'MaterialiseFlushOutcomeMissingError';
	}
}

/**
 * Facts read before materialisation enters the input gate. The gate rechecks
 * the generation and offboarding state, and the charge batch makes the final
 * tenant-status and quota decisions. Callers recover from stale ownership in
 * the same way as a concurrent deletion.
 */
export interface MaterialisationProbe {
	readonly blob: CanonicalBlobFacts | undefined;
	readonly isCanonicalPresent: boolean;
	readonly isOwned: boolean;
}

export interface PrefetchedMaterialisationFacts {
	readonly blob: CanonicalBlobFacts | undefined;
	readonly isOwned: boolean;
}

function isOverQuota(
	account: TenantAccount,
	isOwned: boolean,
	fileSize: number
): boolean {
	if (isOwned || account.quotaBytes === null) {
		return false;
	}

	return (
		(account.bytes ?? 0) + (account.casBytes ?? 0) + fileSize >
		account.quotaBytes
	);
}

export class CommitPipelineService {
	// A pending row is durable before this timestamp is set, so one recent queue
	// request covers later deferrals until verification takes its snapshot. Use a
	// timestamp rather than a boolean so a lost request cannot suppress retries.
	private verifyRequestedAt: number | undefined;

	private readonly materialiseQueue: PendingMaterialise[] = [];
	private materialiseDrain: Promise<void> | undefined;

	constructor(
		private readonly context: ServerContext,
		private readonly signingKeysService: SigningKeysService,
		private readonly uploadState: UploadStateService,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly retention: RetentionService
	) {}

	// Read the session ID at notification time so a reconnect receives the
	// verdict. Exclude the committing session because it receives the result as
	// the response to its commit frame.
	private notifyUploadWaiters(
		uploadId: UploadId,
		excludeSessionId: SessionId | null | undefined
	): void {
		const row = this.context.db
			.select({
				sessionId: schema.pendingUploads.sessionId,
				cache: schema.pendingUploads.cacheId,
				metadataJson: schema.pendingUploads.metadataJson,
				graceDecisionJson: schema.pendingUploads.graceDecisionJson
			})
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();
		const sessionId = row?.sessionId;

		if (row === undefined || sessionId === undefined || sessionId === null) {
			return;
		}

		if (sessionId === excludeSessionId) {
			return;
		}

		// Do not add grace fields to a legacy session. Read the stored deadline
		// after the caller has applied the captured decision.
		const graceDecision = parseStoredGraceDecision(row.graceDecisionJson);
		const grace =
			graceDecision?.reportsGrace === true
				? storedGraceFact(
						this.context.db,
						this.context.cacheRepository.resolvedForId(row.cache),
						parseStoredUploadPathMetadata(uploadId, row.metadataJson)
							.storePathHash
					)
				: undefined;

		for (const socket of this.context.ctx.getWebSockets(sessionId)) {
			sendCommitSessionFrame(socket, {
				ev: 'verdict',
				uploadId,
				status: 'servable',
				...(grace !== undefined && { grace })
			});
		}
	}

	private async commitReusedBlob(
		logger: Logger,
		cache: ResolvedCache,
		uploadId: UploadId,
		metadata: UploadPathNegotiation,
		graceDecision: GraceDecision | undefined,
		attachRootName: RootName | undefined,
		probe: MaterialisationProbe,
		committingSessionId: SessionId | null | undefined,
		isProbeFromPrefetch: boolean
	): Promise<CommitOutcome> {
		const canonicalKey = narObjectKey(metadata.narHash);
		const reserved = await this.reserveNarInfoRow(cache, metadata);

		if (reserved.kind === 'lost') {
			return this.concedeToWinner(
				logger,
				cache,
				uploadId,
				metadata,
				canonicalKey,
				graceDecision,
				attachRootName
			);
		}

		// `mine` includes a replay of this upload. Reuse its generation; conceding
		// would incorrectly treat this upload as a competing winner.
		const generation = reserved.generation;

		let outcome = await this.materialiseBatched(logger, {
			cache,
			metadata,
			generation,
			probe,
			mustOwnBlob: true,
			graceDecision,
			attachRootName
		});

		// A sibling in the same batch may have established ownership after the
		// prefetch. Re-probe once before treating this result as over quota.
		if (isProbeFromPrefetch && outcome.kind === 'over-quota') {
			const freshProbe = await this.probeMaterialisation(metadata);
			outcome = await this.materialiseBatched(logger, {
				cache,
				metadata,
				generation,
				probe: freshProbe,
				mustOwnBlob: true,
				graceDecision,
				attachRootName
			});
		}

		if (outcome.kind === 'deferred') {
			// This invocation's D1 allowance cannot charge the commit. Keep the
			// upload pending, request verification, and return the protocol's
			// existing deferred outcome.
			this.uploadState.markUploadPending(uploadId);
			await this.requestVerification(logger, this.context.requireTenant());

			return {
				kind: 'deferred',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				...(graceDecision?.reportsGrace === true && {
					grace: capturedGraceFact(graceDecision)
				})
			};
		}

		if (outcome.kind === 'materialised') {
			// Publish the narinfo object before clearing the saga marker. A crash
			// between those operations must leave the commit available for recovery.
			await this.narInfoObjects.publishNarInfoObject(
				cache,
				metadata.storePathHash,
				generation,
				metadata.narHash,
				outcome.narInfo
			);

			this.notifyUploadWaiters(uploadId, committingSessionId);
			this.uploadState.clearPendingUpload(uploadId);

			return {
				kind: 'settled',
				response: {
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'committed'
				},
				...(graceDecision?.reportsGrace === true && {
					grace:
						outcome.graceRetainUntil === undefined
							? {}
							: { retainUntil: outcome.graceRetainUntil }
				})
			};
		}

		if (outcome.kind === 'superseded') {
			return this.concedeToWinner(
				logger,
				cache,
				uploadId,
				metadata,
				canonicalKey,
				graceDecision,
				attachRootName
			);
		}

		if (outcome.kind === 'tenant-inactive') {
			await this.context.criticalSection(() =>
				this.reclaimReservedRow(
					cache,
					metadata.storePathHash,
					generation,
					metadata.narHash
				)
			);
			this.uploadState.clearPendingUpload(uploadId);

			throw new TenantWritesStoppedError(
				this.context.requireTenant(),
				outcome.tenantStatus
			);
		}

		// The probe can report a missing canonical NAR after another saga has already
		// committed this generation. Check the current generation before reclaiming
		// it, and apply grace and root retention before releasing the same gate.
		const confirmed = await this.context.criticalSection(async () => {
			const reclaim = await this.reclaimReservedRow(
				cache,
				metadata.storePathHash,
				generation,
				metadata.narHash
			);

			if (reclaim !== 'committed-current') {
				return;
			}

			// This upload's captured retention decisions have not run. Apply them
			// while the winning generation is still protected by the identity check.
			this.attachRootTarget(
				cache,
				attachRootName,
				metadata.storePathHash,
				metadata.storePath
			);

			return confirmGrace(
				this.context,
				this.retention,
				cache,
				metadata.storePathHash,
				generation,
				metadata.narHash,
				graceDecision?.graceSeconds
			);
		});

		if (confirmed !== undefined) {
			this.notifyUploadWaiters(uploadId, committingSessionId);
			this.uploadState.clearPendingUpload(uploadId);

			return {
				kind: 'settled',
				response: {
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'committed'
				},
				...(graceDecision?.reportsGrace === true && {
					grace: confirmed.matched ? confirmed.fact : {}
				})
			};
		}

		this.uploadState.clearPendingUpload(uploadId);

		throw new UploadedObjectNotFoundError(canonicalKey);
	}

	// This read is advisory. The charge batch rechecks tenant status and quota
	// after any await; a missing tenant fails closed there.
	private async tenantAccount(
		tenant: TenantId
	): Promise<TenantAccount | undefined> {
		return this.context.d1
			.select({
				status: d1Schema.tenant.status,
				bytes: d1Schema.tenantUsage.bytes,
				casBytes: d1Schema.tenantUsage.casBytes,
				quotaBytes: d1Schema.tenantUsage.quotaBytes
			})
			.from(d1Schema.tenant)
			.leftJoin(
				d1Schema.tenantUsage,
				eq(d1Schema.tenantUsage.tenant, d1Schema.tenant.id)
			)
			.where(eq(d1Schema.tenant.id, tenant))
			.get();
	}

	// Only an unexpired upload can keep a competing reservation alive. Otherwise
	// a retry must reclaim the abandoned row instead of waiting for verification.
	private hasLiveRival(
		cache: ResolvedCache,
		narHash: NixSha256HashString,
		uploadId: UploadId,
		nowIso: IsoTimestamp
	): boolean {
		const awaitingVerdict = or(
			isNull(schema.pendingUploads.verdict),
			inArray(schema.pendingUploads.verdict, ['committing', 'pending'])
		);
		const rivalFilter = and(
			eq(schema.pendingUploads.cacheId, cache.id),
			eq(schema.pendingUploads.narHash, narHash),
			ne(schema.pendingUploads.id, uploadId),
			gte(schema.pendingUploads.expiresAt, nowIso),
			awaitingVerdict
		);
		const rival = this.context.db
			.select({ id: schema.pendingUploads.id })
			.from(schema.pendingUploads)
			.where(rivalFilter)
			.get();

		return rival !== undefined;
	}

	private async ownsHash(
		tenant: TenantId,
		narHash: NixSha256HashString
	): Promise<boolean> {
		const owned = await this.context.d1
			.select({ narHash: d1Schema.tenantBlob.narHash })
			.from(d1Schema.tenantBlob)
			.where(
				and(
					eq(d1Schema.tenantBlob.tenant, tenant),
					eq(d1Schema.tenantBlob.narHash, narHash)
				)
			)
			.get();

		return owned !== undefined;
	}

	// Keep the usage updates, reference and ownership inserts, and reaper disarm
	// in one batch. Their predicates make a replay idempotent and refuse every
	// write unless the tenant is still active.
	private chargeStatements(
		tenant: TenantId,
		cache: ResolvedCache,
		metadata: UploadPathNegotiation,
		generation: NarInfoGeneration,
		blob: { readonly fileSize: number },
		now: IsoTimestamp
	): BatchItem<'sqlite'>[] {
		const activeTenantFilter = and(
			eq(d1Schema.tenant.id, tenant),
			eq(d1Schema.tenant.status, 'active')
		);
		const tenantActive = exists(
			this.context.d1
				.select({ one: d1Schema.tenant.id })
				.from(d1Schema.tenant)
				.where(activeTenantFilter)
		);
		const edgeFilter = and(
			eq(d1Schema.blobReference.tenant, tenant),
			cacheIdentityCondition(
				d1Schema.blobReference.cacheKind,
				d1Schema.blobReference.cacheName,
				cache.scope
			),
			eq(d1Schema.blobReference.storePathHash, metadata.storePathHash),
			eq(d1Schema.blobReference.generation, generation)
		);
		const edgeMissing = notExists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.blobReference)
				.where(edgeFilter)
		);
		const presenceFilter = and(
			eq(d1Schema.tenantBlob.tenant, tenant),
			eq(d1Schema.tenantBlob.narHash, metadata.narHash)
		);
		const presenceMissing = notExists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.tenantBlob)
				.where(presenceFilter)
		);
		const creditNarInfoFilter = and(
			eq(d1Schema.tenantUsage.tenant, tenant),
			edgeMissing,
			tenantActive
		);
		const creditBytesFilter = and(
			eq(d1Schema.tenantUsage.tenant, tenant),
			presenceMissing,
			tenantActive
		);
		const graceClearFilter = and(
			eq(d1Schema.blobState.narHash, metadata.narHash),
			tenantActive
		);
		const cacheIdentity = cacheIdentityColumns(cache.scope);
		const edgeStatement = this.context.d1
			.insert(d1Schema.blobReference)
			.select((qb) =>
				qb
					.select({
						tenant: sql<TenantId>`${tenant}`.as('tenant'),
						cacheKind: sql<
							typeof cacheIdentity.cacheKind
						>`${cacheIdentity.cacheKind}`.as('cache_kind'),
						cacheName: sql<
							typeof cacheIdentity.cacheName
						>`${cacheIdentity.cacheName}`.as('cache_name'),
						storePathHash: sql<StorePathHash>`${metadata.storePathHash}`.as(
							'store_path_hash'
						),
						generation: sql<number>`${generation}`.as('generation'),
						narHash: sql<NixSha256HashString>`${metadata.narHash}`.as(
							'nar_hash'
						),
						cacheGeneration: currentCacheGeneration(tenant, cache.scope).as(
							'cache_generation'
						)
					})
					.from(d1Schema.tenant)
					.where(activeTenantFilter)
			)
			.onConflictDoNothing();

		return [
			this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					narinfos: sql`${d1Schema.tenantUsage.narinfos} + 1`,
					updatedAt: now
				})
				.where(creditNarInfoFilter),
			this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					bytes: sql`${d1Schema.tenantUsage.bytes} + ${blob.fileSize}`,
					blobs: sql`${d1Schema.tenantUsage.blobs} + 1`,
					updatedAt: now
				})
				.where(creditBytesFilter),
			edgeStatement,
			this.context.d1
				.insert(d1Schema.tenantBlob)
				.select((qb) =>
					qb
						.select({
							tenant: sql<TenantId>`${tenant}`.as('tenant'),
							narHash: sql<NixSha256HashString>`${metadata.narHash}`.as(
								'nar_hash'
							),
							fileSize: sql<number>`${blob.fileSize}`.as('file_size')
						})
						.from(d1Schema.tenant)
						.where(activeTenantFilter)
				)
				.onConflictDoNothing(),
			this.context.d1
				.update(d1Schema.blobState)
				.set({ deleteAfter: sql`null` })
				.where(graceClearFilter)
		];
	}

	private tenantStatusSelect(tenant: TenantId) {
		return this.context.d1
			.select({ status: d1Schema.tenant.status })
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, tenant));
	}

	// The database quota check rolls back the whole charge batch, so an edge
	// cannot be recorded without its corresponding usage charge.
	private async reserveEdgeAndCharge(
		tenant: TenantId,
		cache: ResolvedCache,
		metadata: UploadPathNegotiation,
		generation: NarInfoGeneration,
		blob: { readonly fileSize: number }
	): Promise<ChargeOutcome> {
		const now = isoTimestamp(new Date());

		let statusRows: { status: TenantAccount['status'] }[];

		try {
			const [status] = await this.context.d1.batch([
				this.tenantStatusSelect(tenant),
				...this.chargeStatements(tenant, cache, metadata, generation, blob, now)
			]);
			statusRows = status;
		} catch (error) {
			// Concurrent commits can both pass the advisory quota check. Re-read
			// after a failed charge to distinguish that race from a storage fault.
			const account = await this.tenantAccount(tenant);
			const isOwned = await this.ownsHash(tenant, metadata.narHash);

			if (
				account !== undefined &&
				isOverQuota(account, isOwned, blob.fileSize)
			) {
				return { kind: 'over-quota' };
			}

			throw error;
		}

		if (statusRows.at(0)?.status !== 'active') {
			return {
				kind: 'tenant-inactive',
				tenantStatus: statusRows.at(0)?.status
			};
		}

		return { kind: 'charged' };
	}

	// D1 executes these statements sequentially, so two requests for the same
	// hash charge the blob once. If one request exceeds quota, the batch rolls
	// back and the flush retries each request separately to isolate the failure.
	private async reserveEdgesAndCharge(
		tenant: TenantId,
		charges: readonly {
			readonly cache: ResolvedCache;
			readonly metadata: UploadPathNegotiation;
			readonly generation: NarInfoGeneration;
			readonly blob: CanonicalBlobFacts;
		}[]
	): Promise<BatchChargeOutcome> {
		const now = isoTimestamp(new Date());
		const statements = charges.flatMap((charge) =>
			this.chargeStatements(
				tenant,
				charge.cache,
				charge.metadata,
				charge.generation,
				charge.blob,
				now
			)
		);

		let statusRows: { status: TenantAccount['status'] }[];

		try {
			const [status] = await this.context.d1.batch([
				this.tenantStatusSelect(tenant),
				...statements
			]);
			statusRows = status;
		} catch {
			return { kind: 'retry-individually' };
		}

		if (statusRows.at(0)?.status !== 'active') {
			return {
				kind: 'tenant-inactive',
				tenantStatus: statusRows.at(0)?.status
			};
		}

		return { kind: 'charged' };
	}

	// Do not postpone an existing future deadline when more work is deferred.
	// Once a stored deadline is due, start a new backstop cycle.
	private async armVerifyBackstop(now: number): Promise<void> {
		const storage = this.context.ctx.storage;
		const dueAt = now + verifyBackstopDelayMs;
		const existing = await storage.get<number>(verifyBackstopKey);
		const effective =
			existing !== undefined && existing > now
				? Math.min(existing, dueAt)
				: dueAt;

		if (existing !== effective) {
			await storage.put(verifyBackstopKey, effective);
		}

		await armAlarmNoLaterThan(storage, effective);
	}

	private materialiseFence(
		request: MaterialiseRequest,
		account: TenantAccount | undefined
	):
		| {
				readonly outcome: Exclude<MaterialiseOutcome, { kind: 'materialised' }>;
		  }
		| { readonly narInfo: NarInfo; readonly blob: CanonicalBlobFacts } {
		const { cache, metadata, generation, probe } = request;

		// A tenant can stop accepting writes after the Worker admits this commit.
		// Recheck inside the gate so no new edge can land behind the offboarding
		// drain and keep a shared blob alive.
		if (this.context.offboarding || account?.status !== 'active') {
			return {
				outcome: {
					kind: 'tenant-inactive',
					tenantStatus: this.context.offboarding
						? 'offboarding'
						: account?.status
				}
			};
		}

		if (probe.blob === undefined || !probe.isCanonicalPresent) {
			return { outcome: { kind: 'blob-gone' } };
		}

		// Reuse depends on the tenant's existing ownership record. If deletion has
		// removed it and credited the bytes back, require a fresh upload.
		if (request.mustOwnBlob && !probe.isOwned) {
			return { outcome: { kind: 'blob-gone' } };
		}

		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, metadata.storePathHash)
				)
			)
			.get();

		// Fence on both generation and hash so a recommit cannot attach this edge
		// to a replacement narinfo row.
		if (row?.generation !== generation || row.narHash !== metadata.narHash) {
			return { outcome: { kind: 'superseded' } };
		}

		// Charge the canonical size. It can differ from the staged encoding size
		// used during negotiation; the charge batch checks quota again.
		if (isOverQuota(account, probe.isOwned, probe.blob.fileSize)) {
			return { outcome: { kind: 'over-quota' } };
		}

		return {
			narInfo: this.narInfoObjects.buildNarInfo(row, probe.blob),
			blob: probe.blob
		};
	}

	private async processMaterialiseFlushLocked(
		requests: readonly MaterialiseRequest[],
		account: TenantAccount | undefined
	): Promise<(BatchedMaterialiseOutcome | undefined)[]> {
		const outcomes: (BatchedMaterialiseOutcome | undefined)[] = Array.from({
			length: requests.length
		});
		const chargeable: {
			readonly index: number;
			readonly request: MaterialiseRequest;
			readonly narInfo: NarInfo;
			readonly blob: CanonicalBlobFacts;
		}[] = [];

		for (const [index, request] of requests.entries()) {
			if (
				request.isStillSettleable !== undefined &&
				!request.isStillSettleable()
			) {
				outcomes[index] = { kind: 'gone' };
				continue;
			}

			const fenced = this.materialiseFence(request, account);

			if ('outcome' in fenced) {
				outcomes[index] = fenced.outcome;
				continue;
			}

			chargeable.push({
				index,
				request,
				narInfo: fenced.narInfo,
				blob: fenced.blob
			});
		}

		if (chargeable.length === 0) {
			return outcomes;
		}

		const tenant = this.context.requireTenant();
		const charged = await this.reserveEdgesAndCharge(
			tenant,
			chargeable.map((charge) => ({
				cache: charge.request.cache,
				metadata: charge.request.metadata,
				generation: charge.request.generation,
				blob: charge.blob
			}))
		);

		if (charged.kind === 'retry-individually') {
			for (const charge of chargeable) {
				const single = await this.reserveEdgeAndCharge(
					tenant,
					charge.request.cache,
					charge.request.metadata,
					charge.request.generation,
					charge.blob
				);
				outcomes[charge.index] =
					single.kind === 'charged'
						? { kind: 'materialised', narInfo: charge.narInfo }
						: single;
			}
		} else {
			for (const charge of chargeable) {
				outcomes[charge.index] =
					charged.kind === 'charged'
						? { kind: 'materialised', narInfo: charge.narInfo }
						: charged;
			}
		}

		this.applyCapturedGrace(requests, outcomes);
		this.applyRootAttach(requests, outcomes);

		return outcomes;
	}

	// Apply the negotiated grace decision before releasing the generation fence.
	// This prevents collection from observing a committed path without its
	// deadline. A zero duration still marks the cache as grace-managed.
	private applyCapturedGrace(
		requests: readonly MaterialiseRequest[],
		outcomes: (BatchedMaterialiseOutcome | undefined)[]
	): void {
		const settledAt = Date.now();
		const managedCaches = new Map<ResolvedCache['id'], ResolvedCache>();
		const extensions = new Map<
			string,
			{
				readonly cache: ResolvedCache;
				readonly retainUntil: IsoTimestamp;
				readonly entries: {
					readonly index: number;
					readonly hash: StorePathHash;
				}[];
			}
		>();

		for (const [index, request] of requests.entries()) {
			const outcome = outcomes[index];

			if (outcome?.kind !== 'materialised') {
				continue;
			}

			const graceSeconds = request.graceDecision?.graceSeconds;

			if (graceSeconds === undefined) {
				continue;
			}

			managedCaches.set(request.cache.id, request.cache);

			if (graceSeconds === 0) {
				continue;
			}

			const retainUntil = isoTimestamp(
				new Date(settledAt + graceSeconds * 1000)
			);
			const key = `${String(request.cache.id)} ${retainUntil}`;
			const group = extensions.get(key) ?? {
				cache: request.cache,
				retainUntil,
				entries: []
			};

			group.entries.push({ index, hash: request.metadata.storePathHash });
			extensions.set(key, group);
		}

		for (const cache of managedCaches.values()) {
			this.retention.markCacheGraceManaged(cache);
		}

		for (const group of extensions.values()) {
			const hashes = group.entries.map((entry) => entry.hash);

			this.retention.extendGraceDeadlines(
				group.cache,
				hashes,
				group.retainUntil
			);

			// The upsert is monotonic. Report the stored maximum, which may come
			// from an earlier grace decision or a root transition.
			const stored = storedGraceDeadlines(this.context.db, group.cache, hashes);

			for (const entry of group.entries) {
				const outcome = outcomes[entry.index];
				const retainUntil = stored.get(entry.hash);

				if (retainUntil !== undefined && outcome?.kind === 'materialised') {
					outcomes[entry.index] = { ...outcome, graceRetainUntil: retainUntil };
				}
			}
		}
	}

	// Attach the negotiated run root before releasing the generation fence. A
	// replay is harmless because root targets are additive and idempotent. Do not
	// alter the root expiry or run a grace transition here. Chunk the insert
	// because one run can exceed the per-request root-write limit.
	private applyRootAttach(
		requests: readonly MaterialiseRequest[],
		outcomes: readonly (BatchedMaterialiseOutcome | undefined)[]
	): void {
		const targets = requests.flatMap((request, index) =>
			outcomes[index]?.kind === 'materialised' &&
			request.attachRootName !== undefined
				? [
						{
							cacheId: request.cache.id,
							rootName: request.attachRootName,
							storePathHash: request.metadata.storePathHash,
							storePath: request.metadata.storePath
						}
					]
				: []
		);

		for (const batch of chunk(targets, maxRootTargetInsertRows)) {
			this.context.db
				.insert(schema.retentionRootTargets)
				.values(batch)
				.onConflictDoNothing()
				.run();
		}
	}

	// Take the batch only after entering the gate. The wait for the gate collects
	// concurrent requests without a timer, and callers resume only after the gate
	// has released. If the flush fails, reject every request it took; their saga
	// markers remain available for recovery.
	private async flushMaterialiseQueue(logger: Logger): Promise<void> {
		let batch: PendingMaterialise[] = [];
		let outcomes: (BatchedMaterialiseOutcome | undefined)[] = [];

		try {
			// Page the flush from the invocation's remaining D1 allowance. A larger
			// allowance settles more of a burst in one invocation; an allowance
			// that covers the whole flush settles every request immediately.
			// Under a small allowance, the flush returns `deferred` for requests
			// that it cannot charge. The pending upload remains available for a
			// verification pass.
			const affordable = Math.min(
				materialiseFlushCap,
				affordableOperations(
					statementsPerMaterialise,
					materialiseFlushOverheadStatements
				)
			);

			if (affordable === 0) {
				this.deferQueuedMaterialisations();

				return;
			}

			// Read the account outside the gate. The charge batch rechecks any value
			// that becomes stale before this flush runs.
			const account = await this.tenantAccount(this.context.requireTenant());

			await this.context.criticalSection(async () => {
				batch = this.materialiseQueue.splice(0, affordable);
				outcomes = await this.processMaterialiseFlushLocked(
					batch.map((item) => item.request),
					account
				);
			});
		} catch (error) {
			// If the gate failed before taking a batch, every queued request was
			// waiting on this drain and must be rejected.
			const failed = batch.length > 0 ? batch : [...this.materialiseQueue];

			if (batch.length === 0) {
				this.materialiseQueue.length = 0;
			}

			logger.error('materialise flush failed', {
				settles: failed.length,
				error
			});

			for (const item of failed) {
				item.reject(error);
			}

			return;
		}

		for (const [index, item] of batch.entries()) {
			const outcome = outcomes[index];

			if (outcome === undefined) {
				item.reject(new MaterialiseFlushOutcomeMissingError());
				continue;
			}

			item.resolve(outcome);
		}
	}

	// Answer every request still queued. This queue contains callers waiting for
	// a response. The pending rows contain the durable work.
	private deferQueuedMaterialisations(): void {
		const queued = [...this.materialiseQueue];
		this.materialiseQueue.length = 0;

		for (const item of queued) {
			item.resolve({ kind: 'deferred' });
		}
	}

	private async drainMaterialiseQueue(logger: Logger): Promise<void> {
		try {
			while (this.materialiseQueue.length > 0) {
				await this.flushMaterialiseQueue(logger);
			}
		} catch (error) {
			// Nothing awaits this drain, so a request left queued here would leave
			// its caller waiting for a flush that will not run. Reject them instead.
			logger.error('materialise drain failed', {
				settles: this.materialiseQueue.length,
				error
			});

			const stranded = [...this.materialiseQueue];
			this.materialiseQueue.length = 0;

			for (const item of stranded) {
				item.reject(error);
			}
		} finally {
			this.materialiseDrain = undefined;
		}
	}

	/**
	 * Reads tenant-wide account facts once for a commit batch. The charge batch
	 * still makes the authoritative status and quota decision for each entry.
	 */
	async readTenantAccount(): Promise<TenantAccount | undefined> {
		return this.tenantAccount(this.context.requireTenant());
	}

	/**
	 * Attaches a committed path to the run root selected at negotiation. Call
	 * this only while the winning row's identity is proven; retries are
	 * idempotent by cache, root, and store-path hash.
	 */
	attachRootTarget(
		cache: ResolvedCache,
		rootName: RootName | null | undefined,
		storePathHash: StorePathHash,
		storePath: StorePathString
	): void {
		if (rootName === null || rootName === undefined) {
			return;
		}

		this.context.db
			.insert(schema.retentionRootTargets)
			.values({ cacheId: cache.id, rootName, storePathHash, storePath })
			.onConflictDoNothing()
			.run();
	}

	// Do not concede until the winning generation has both a committed edge and
	// a narinfo object. Until then, keep this upload available for verification.
	// The global reaper owns any promoted canonical blob left without an edge;
	// this path clears only the losing upload's private staging object.
	async concedeToWinner(
		logger: Logger,
		cache: ResolvedCache,
		uploadId: UploadId,
		metadata: UploadPathNegotiation,
		stagingKey: R2ObjectKey,
		graceDecision?: GraceDecision,
		attachRootName?: RootName
	): Promise<CommitOutcome> {
		// A recommit can replace the winner while its object is repaired. Retry a
		// bounded number of times, then leave the upload for verification so churn
		// cannot pin this request indefinitely.
		for (let attempt = 0; attempt < concedeAttemptLimit; attempt += 1) {
			const winner = await this.narInfoObjects.committedNarInfoRow(
				cache,
				metadata.storePathHash
			);

			if (winner === undefined) {
				// Keep the pending upload while the winning saga has no committed edge.
				// Verification will resolve both contenders.
				await this.requestVerification(logger, this.context.requireTenant());

				return {
					kind: 'deferred',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					...(graceDecision?.reportsGrace === true && {
						grace: capturedGraceFact(graceDecision)
					})
				};
			}

			await this.narInfoObjects.ensureNarInfoObject(
				cache,
				winner.storePathHash
			);

			// Apply this upload's retention decision to the winner before deleting
			// the pending row that stores the decision.
			const confirmed = confirmGrace(
				this.context,
				this.retention,
				cache,
				winner.storePathHash,
				winner.generation,
				winner.narHash,
				graceDecision?.graceSeconds
			);

			// The winner can change while its object is repaired. Confirm its
			// generation before applying retention or reporting success.
			if (!confirmed.matched) {
				continue;
			}

			this.attachRootTarget(
				cache,
				attachRootName,
				winner.storePathHash,
				winner.storePath
			);

			await this.uploadState.clearPendingUploadAndStaging(
				uploadId,
				stagingKey,
				metadata.narHash
			);

			return {
				kind: 'settled',
				response: {
					storePathHash: metadata.storePathHash,
					narHash: winner.narHash,
					status: 'already-present'
				},
				...(graceDecision?.reportsGrace === true && { grace: confirmed.fact })
			};
		}

		// Preserve the pending row and its retention decision after repeated
		// generation changes. Verification can arbitrate after the churn subsides.
		await this.requestVerification(logger, this.context.requireTenant());

		return {
			kind: 'deferred',
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			...(graceDecision?.reportsGrace === true && {
				grace: capturedGraceFact(graceDecision)
			})
		};
	}

	// Clear the guard before the pass takes its snapshot. A row deferred after
	// that snapshot needs a new queue request.
	onVerificationPassStarted(): void {
		this.verifyRequestedAt = undefined;
	}

	// Coalesce deferrals onto one recent queue request. A failed send clears the
	// guard immediately; an unclaimed request becomes eligible for retry after
	// `verifyRequestStaleMs`.
	async requestVerification(logger: Logger, tenant: TenantId): Promise<void> {
		const now = Date.now();

		// The backstop arms regardless of the single-flight guard: a deferral
		// that coalesces onto an outstanding message still needs the alarm to
		// cover that message being lost.
		await this.armVerifyBackstop(now);

		if (
			this.verifyRequestedAt !== undefined &&
			now - this.verifyRequestedAt < verifyRequestStaleMs
		) {
			return;
		}

		this.verifyRequestedAt = now;
		const message: MaintenanceQueueMessage = { kind: 'tenant-verify', tenant };

		try {
			await this.context.env.MAINTENANCE_QUEUE.send(message);
		} catch {
			this.verifyRequestedAt = undefined;
			logger.warn('verification request not enqueued', {
				kind: 'tenant-verify',
				reason: 'queue-send-failed'
			});
		}
	}

	async commit(
		logger: Logger,
		cache: ResolvedCache,
		uploadId: UploadId,
		// Batch callers may reuse these advisory reads. The charge batch still
		// makes the authoritative status and quota decision.
		advisory?: {
			readonly prefetched?: PrefetchedMaterialisationFacts;
			readonly account?: TenantAccount;
		}
	): Promise<CommitOutcome> {
		// Do not defer a commit after offboarding begins. It could otherwise be
		// restored after the drain has removed this tenant's references.
		if (this.context.offboarding) {
			throw new TenantWritesStoppedError(
				this.context.requireTenant(),
				'offboarding'
			);
		}

		const pending = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined) {
			throw new UploadNotFoundError(uploadId);
		}

		if (pending.cacheId !== cache.id) {
			throw new UploadCacheMismatchError(
				uploadId,
				this.context.cacheRepository.scopeForId(pending.cacheId),
				cache.scope
			);
		}

		const graceDecision = parseStoredGraceDecision(pending.graceDecisionJson);
		const nowIso = isoTimestamp(new Date());

		if (pending.expiresAt < nowIso) {
			await this.uploadState.clearPendingUploadAndStaging(
				uploadId,
				pending.r2Key,
				pending.narHash
			);

			throw new UploadExpiredError(uploadId);
		}

		const renewedExpiry = new Date(Date.now() + 15 * 60 * 1000);

		this.context.db
			.update(schema.pendingUploads)
			.set({ expiresAt: isoTimestamp(renewedExpiry) })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();

		const metadata = parseStoredUploadPathMetadata(
			uploadId,
			pending.metadataJson
		);
		const existingNarInfo = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, metadata.storePathHash)
				)
			)
			.get();

		if (existingNarInfo !== undefined) {
			// Preserve this upload's durable saga marker and staged bytes while
			// verification is still responsible for the reserved row.
			if (pending.verdict === 'committing' || pending.verdict === 'pending') {
				// A reuse commit can crash before its first queue request. A retry must
				// request verification instead of waiting for the scheduled backstop.
				await this.requestVerification(logger, this.context.requireTenant());

				return {
					kind: 'deferred',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					...(graceDecision?.reportsGrace === true && {
						grace: capturedGraceFact(graceDecision)
					})
				};
			}

			if (
				await this.narInfoObjects.hasCommittedReference(cache, existingNarInfo)
			) {
				await this.narInfoObjects.ensureNarInfoObject(
					cache,
					existingNarInfo.storePathHash
				);

				// Apply this upload's retention decision to the winner before
				// deleting the pending row that stores the decision.
				const confirmed = confirmGrace(
					this.context,
					this.retention,
					cache,
					existingNarInfo.storePathHash,
					existingNarInfo.generation,
					existingNarInfo.narHash,
					graceDecision?.graceSeconds
				);

				// The row can change during the reference check and object repair. If
				// its identity moved, keep the decision for verification to apply to
				// the current winner.
				if (!confirmed.matched) {
					this.uploadState.markUploadPending(uploadId);
					await this.requestVerification(logger, this.context.requireTenant());

					return {
						kind: 'deferred',
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash,
						...(graceDecision?.reportsGrace === true && {
							grace: capturedGraceFact(graceDecision)
						})
					};
				}

				this.attachRootTarget(
					cache,
					pending.attachRootName,
					existingNarInfo.storePathHash,
					existingNarInfo.storePath
				);

				await this.uploadState.clearPendingUploadAndStaging(
					uploadId,
					pending.r2Key,
					metadata.narHash
				);

				return {
					kind: 'settled',
					response: {
						storePathHash: metadata.storePathHash,
						narHash: existingNarInfo.narHash,
						status: 'already-present'
					},
					...(graceDecision?.reportsGrace === true && { grace: confirmed.fact })
				};
			}

			if (this.hasLiveRival(cache, existingNarInfo.narHash, uploadId, nowIso)) {
				// Keep this upload for verification while another live saga owns the
				// reservation. Verification will decide which version remains.
				this.uploadState.markUploadPending(uploadId);
				await this.requestVerification(logger, this.context.requireTenant());

				return {
					kind: 'deferred',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					...(graceDecision?.reportsGrace === true && {
						grace: capturedGraceFact(graceDecision)
					})
				};
			}

			// No upload can complete this reservation. Reclaim it here so retries
			// do not wait for the periodic recovery scan.
			await this.context.criticalSection(() =>
				this.reclaimReservedRow(
					cache,
					metadata.storePathHash,
					existingNarInfo.generation,
					existingNarInfo.narHash
				)
			);
		}

		const canonicalKey = narObjectKey(metadata.narHash);
		const tenant = this.context.requireTenant();

		const [probe, stagedObject, account] = await Promise.all([
			this.probeMaterialisation(metadata, advisory?.prefetched),
			pending.r2Key === canonicalKey
				? undefined
				: this.context.env.BLOBS.head(pending.r2Key),
			advisory?.account ?? this.tenantAccount(tenant)
		]);

		const stagedSize =
			pending.r2Key === canonicalKey
				? probe.isCanonicalPresent
					? (probe.blob?.fileSize ?? 0)
					: undefined
				: (stagedObject?.size ?? undefined);

		if (stagedSize === undefined) {
			throw new UploadedObjectNotFoundError(pending.r2Key);
		}

		// Avoid verification when the advisory facts already prove this charge
		// exceeds quota. An existing canonical encoding can have a different size,
		// so materialisation checks its size again.
		const estimate = probe.blob?.fileSize ?? stagedSize;

		if (
			account !== undefined &&
			isOverQuota(account, probe.isOwned, estimate)
		) {
			throw new QuotaExceededError(tenant);
		}

		// Store the saga marker before any reservation or handoff. After a crash,
		// verification can distinguish this work from an upload still receiving
		// bytes and resume it.
		this.uploadState.markUploadCommitting(uploadId);

		// The initiating session receives the returned commit result. Exclude it
		// from waiter notification so a verdict frame cannot arrive first.
		const committingRow = this.context.db
			.select({ sessionId: schema.pendingUploads.sessionId })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();
		const committingSessionId = committingRow?.sessionId;

		// Canonical bytes passed verification when they entered the CAS, so reuse
		// does not decode them again.
		if (pending.r2Key === canonicalKey) {
			return this.commitReusedBlob(
				logger,
				cache,
				uploadId,
				metadata,
				graceDecision,
				pending.attachRootName ?? undefined,
				probe,
				committingSessionId,
				advisory?.prefetched !== undefined
			);
		}

		// Fresh bytes cannot be served before verification. Reject a NAR above the
		// verifier's hard limit; defer every other fresh upload to the same queue.
		if (metadata.narSize > verifiableMaxBytes) {
			await this.uploadState.clearPendingUploadAndStaging(
				uploadId,
				pending.r2Key,
				metadata.narHash
			);

			throw new NarTooLargeError(metadata.narSize, verifiableMaxBytes);
		}

		// Reserve the row before verification so a root can retain it during the
		// verification window. The verification pass repeats this idempotently.
		await this.reserveNarInfoRow(cache, metadata);

		await this.requestVerification(logger, tenant);

		return {
			kind: 'deferred',
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			...(graceDecision?.reportsGrace === true && {
				grace: capturedGraceFact(graceDecision)
			})
		};
	}

	// Reserve the row before writing its committed edge. A reservation alone is
	// not servable. Generate its identity in the same transaction, and never
	// reuse a generation after deletion.
	async reserveNarInfoRow(
		cache: ResolvedCache,
		metadata: UploadPathNegotiation
	): Promise<ReserveOutcome>;
	async reserveNarInfoRow(
		cache: ResolvedCache,
		metadata: UploadPathNegotiation,
		isStillOwned: () => boolean
	): Promise<ReserveOutcome | undefined>;
	async reserveNarInfoRow(
		cache: ResolvedCache,
		metadata: UploadPathNegotiation,
		isStillOwned?: () => boolean
	): Promise<ReserveOutcome | undefined> {
		const now = isoTimestamp(new Date());
		const signingKeys = await this.signingKeysService.signingKeys();
		// Nix signatures cover the uncompressed NAR identity, not its compressed
		// encoding. The compressed file hash and size are therefore unnecessary here.
		const fingerprint = narFingerprint(
			new StorePath(metadata.storePath),
			metadata.narHash,
			metadata.narSize,
			metadata.references
		);
		const signatures = await Promise.all(
			signingKeys.map((key) =>
				signNixFingerprint(key.privateJwk, fingerprint, key.publicKey.name)
			)
		);
		if (isStillOwned?.() === false) {
			return;
		}

		const sigs = signatures.map((signature) => signature.value);
		const signatureGeneration = signingKeyGenerationSchema.parse(
			Math.max(0, ...signingKeys.map((key) => key.generation))
		);
		const referencesJson = JSON.stringify(metadata.references);

		// Read, stamp, and advance the generation atomically. The sequence survives
		// deletion, so a recommit cannot reuse an old edge identity.
		return this.context.db.transaction((tx) => {
			if (isStillOwned?.() === false) {
				return;
			}

			const seq = tx
				.select({ next: schema.generationSeq.nextGeneration })
				.from(schema.generationSeq)
				.where(
					and(
						cacheIdentityCondition(
							schema.generationSeq.cacheKind,
							schema.generationSeq.cacheName,
							cache.scope
						),
						eq(schema.generationSeq.storePathHash, metadata.storePathHash)
					)
				)
				.get();
			const generation = seq?.next ?? narInfoGenerationSchema.parse(0);
			const inserted = tx
				.insert(schema.narInfos)
				.values({
					cacheId: cache.id,
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					narHash: metadata.narHash,
					narSize: metadata.narSize,
					referencesJson,
					deriver: metadata.deriver,
					ca: metadata.ca,
					sigsJson: JSON.stringify(sigs),
					generation,
					signatureGeneration,
					createdAt: now
				} satisfies typeof schema.narInfos.$inferInsert)
				.onConflictDoNothing()
				.returning()
				.all();

			if (inserted.length > 0) {
				const nextGeneration = narInfoGenerationSchema.parse(generation + 1);

				const sequence = tx.insert(schema.generationSeq).values({
					...cacheIdentityColumns(cache.scope),
					storePathHash: metadata.storePathHash,
					nextGeneration
				});

				if (cache.scope.kind === 'default') {
					sequence
						.onConflictDoUpdate({
							target: schema.generationSeq.storePathHash,
							targetWhere: sql`${schema.generationSeq.cacheKind} = 'default'`,
							set: { nextGeneration }
						})
						.run();

					return { kind: 'reserved', generation };
				}

				sequence
					.onConflictDoUpdate({
						target: [
							schema.generationSeq.cacheName,
							schema.generationSeq.storePathHash
						],
						targetWhere: sql`${schema.generationSeq.cacheKind} = 'named'`,
						set: { nextGeneration }
					})
					.run();

				return { kind: 'reserved', generation };
			}

			const existing = tx
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						eq(schema.narInfos.storePathHash, metadata.storePathHash)
					)
				)
				.get();

			if (existing === undefined) {
				return { kind: 'lost', narHash: metadata.narHash };
			}

			// Treat the row as the same narinfo version only when its store path,
			// NAR identity, references, deriver, and content address match. Do not
			// compare signatures: key rotation can re-sign the same version.
			const isMine =
				existing.narHash === metadata.narHash &&
				existing.narSize === metadata.narSize &&
				existing.storePath === metadata.storePath &&
				existing.referencesJson === referencesJson &&
				(existing.deriver ?? undefined) === metadata.deriver &&
				(existing.ca ?? undefined) === metadata.ca;

			if (isMine) {
				return { kind: 'mine', generation: existing.generation };
			}

			return { kind: 'lost', narHash: existing.narHash };
		});
	}

	// Keep D1 and R2 probe reads outside the input gate. The returned facts are
	// advisory and may be stale by the time materialisation acquires the gate.
	async probeMaterialisation(
		metadata: UploadPathNegotiation,
		prefetched?: PrefetchedMaterialisationFacts
	): Promise<MaterialisationProbe> {
		// Promotion disarms the reaper before these prefetched facts are used. The
		// charge batch still fences status and quota, and a stale ownership result is
		// re-probed once if it would reject the commit.
		if (prefetched !== undefined) {
			const isCanonicalPresent =
				prefetched.blob !== undefined &&
				(await this.context.env.BLOBS.head(
					narObjectKey(metadata.narHash, prefetched.blob.incarnation)
				)) !== null;

			return {
				blob: prefetched.blob,
				isCanonicalPresent,
				isOwned: prefetched.isOwned
			};
		}

		const tenant = this.context.requireTenant();
		const canonicalFilter = eq(d1Schema.blobState.narHash, metadata.narHash);
		const ownedFilter = and(
			eq(d1Schema.tenantBlob.tenant, tenant),
			eq(d1Schema.tenantBlob.narHash, metadata.narHash)
		);

		// Read the shared blob row and tenant ownership edge in one D1 batch. The
		// persisted `incarnation` value identifies the object version to use in the
		// physical R2 key.
		const d1Rows = await this.context.d1.batch([
			this.context.d1
				.select({
					fileHash: d1Schema.blobState.fileHash,
					fileSize: d1Schema.blobState.fileSize,
					compression: d1Schema.blobState.compression,
					incarnation: d1Schema.blobState.incarnation
				})
				.from(d1Schema.blobState)
				.where(canonicalFilter),
			this.context.d1
				.select({ narHash: d1Schema.tenantBlob.narHash })
				.from(d1Schema.tenantBlob)
				.where(ownedFilter)
		]);

		const [blobRows, ownedRows] = d1Rows;
		const blob = blobRows[0];
		const isCanonicalPresent =
			blob !== undefined &&
			(await this.context.env.BLOBS.head(
				narObjectKey(metadata.narHash, blob.incarnation)
			)) !== null;

		return {
			blob,
			isCanonicalPresent,
			isOwned: ownedRows.length > 0
		};
	}

	// Prefetch canonical and ownership facts for a claimed set. These values can
	// become stale across the set, so callers must still use the authoritative
	// charge fence and the ownership retry.
	async prefetchMaterialisationFacts(
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<NixSha256HashString, PrefetchedMaterialisationFacts>> {
		const tenant = this.context.requireTenant();
		const unique = [...new Set(narHashes)];

		const blobByHash = new Map<NixSha256HashString, CanonicalBlobFacts>();
		const ownedHashes = new Set<NixSha256HashString>();

		const blobStateQueries = chunk(unique, maxInClauseValues).map((batch) =>
			this.context.d1
				.select({
					narHash: d1Schema.blobState.narHash,
					fileHash: d1Schema.blobState.fileHash,
					fileSize: d1Schema.blobState.fileSize,
					compression: d1Schema.blobState.compression,
					incarnation: d1Schema.blobState.incarnation
				})
				.from(d1Schema.blobState)
				.where(inArray(d1Schema.blobState.narHash, batch))
		);

		const tenantBlobQueries = chunk(unique, maxInClauseValues).map((batch) =>
			this.context.d1
				.select({ narHash: d1Schema.tenantBlob.narHash })
				.from(d1Schema.tenantBlob)
				.where(
					and(
						eq(d1Schema.tenantBlob.tenant, tenant),
						inArray(d1Schema.tenantBlob.narHash, batch)
					)
				)
		);

		const [blobResults, ownedResults] = await Promise.all([
			batchNonEmpty(this.context.d1, blobStateQueries),
			batchNonEmpty(this.context.d1, tenantBlobQueries)
		]);

		for (const rows of blobResults) {
			for (const row of rows) {
				blobByHash.set(row.narHash, {
					fileHash: row.fileHash,
					fileSize: row.fileSize,
					compression: row.compression,
					incarnation: row.incarnation
				});
			}
		}

		for (const rows of ownedResults) {
			for (const row of rows) {
				ownedHashes.add(row.narHash);
			}
		}

		const facts = unique.map(
			(narHash): [NixSha256HashString, PrefetchedMaterialisationFacts] => [
				narHash,
				{ blob: blobByHash.get(narHash), isOwned: ownedHashes.has(narHash) }
			]
		);

		return new Map(facts);
	}

	// A generation is committed only when its exact D1 edge and narinfo object
	// both exist. Shared blob presence cannot prove that a superseded generation
	// committed. A true result lets crash recovery finish marker and retention
	// bookkeeping without decoding the upload again. Keep these remote reads
	// outside the input gate.
	async isGenerationCommitted(
		cache: ResolvedCache,
		metadata: UploadPathNegotiation,
		generation: NarInfoGeneration
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const edgeFilter = and(
			eq(d1Schema.blobReference.tenant, tenant),
			cacheIdentityCondition(
				d1Schema.blobReference.cacheKind,
				d1Schema.blobReference.cacheName,
				cache.scope
			),
			eq(d1Schema.blobReference.storePathHash, metadata.storePathHash),
			eq(d1Schema.blobReference.generation, generation),
			eq(d1Schema.blobReference.narHash, metadata.narHash)
		);
		const [edge, isCurrentObject] = await Promise.all([
			this.context.d1
				.select({ narHash: d1Schema.blobReference.narHash })
				.from(d1Schema.blobReference)
				.where(edgeFilter)
				.get(),
			this.narInfoObjects.isCurrentPublishedVersion(
				cache,
				metadata.storePathHash,
				generation,
				metadata.narHash
			)
		]);

		return edge !== undefined && isCurrentObject;
	}

	// Share one input gate and charge batch across concurrent socket and
	// verification settlements. The charge batch validates the advisory probe;
	// callers publish the returned narinfo only after the gate has released.
	async materialiseBatched(
		logger: Logger,
		request: MaterialiseRequest
	): Promise<BatchedMaterialiseOutcome> {
		return new Promise<BatchedMaterialiseOutcome>((resolve, reject) => {
			this.materialiseQueue.push({ request, resolve, reject });
			this.materialiseDrain ??= this.drainMaterialiseQueue(logger);
		});
	}

	// Call only inside the input gate. Reclaim the row only if its generation and
	// hash still match and no committed edge exists for that identity. Old edges
	// can survive deletion and recommit until the deletion backlog drains.
	async reclaimReservedRow(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		narHash: NixSha256HashString,
		isStillSettleable?: () => boolean
	): Promise<'reclaimed' | 'committed-current' | 'superseded'> {
		const current = this.context.db
			.select({
				generation: schema.narInfos.generation,
				narHash: schema.narInfos.narHash
			})
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (current === undefined) {
			return 'reclaimed';
		}

		if (current.generation !== generation || current.narHash !== narHash) {
			return 'superseded';
		}

		const tenant = this.context.requireTenant();
		const materialised = await this.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, tenant),
					cacheIdentityCondition(
						d1Schema.blobReference.cacheKind,
						d1Schema.blobReference.cacheName,
						cache.scope
					),
					eq(d1Schema.blobReference.storePathHash, storePathHash),
					eq(d1Schema.blobReference.generation, generation),
					eq(d1Schema.blobReference.narHash, narHash)
				)
			)
			.get();

		if (isStillSettleable !== undefined && !isStillSettleable()) {
			return 'superseded';
		}

		if (materialised !== undefined) {
			return 'committed-current';
		}

		await this.narInfoObjects.deleteNarInfoObject(cache, storePathHash);

		if (isStillSettleable !== undefined && !isStillSettleable()) {
			return 'superseded';
		}

		// Delete the grace deadline with the reserved row. A dangling deadline could
		// otherwise retain a later generation of the same path.
		this.context.db.transaction((tx) => {
			tx.delete(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						eq(schema.narInfos.storePathHash, storePathHash),
						eq(schema.narInfos.generation, generation),
						eq(schema.narInfos.narHash, narHash)
					)
				)
				.run();

			tx.delete(schema.retentionGrace)
				.where(
					and(
						eq(schema.retentionGrace.cacheId, cache.id),
						eq(schema.retentionGrace.storePathHash, storePathHash)
					)
				)
				.run();
		});

		return 'reclaimed';
	}
}
