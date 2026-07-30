import { type Logger } from '@cupboard/logger';
import { narFingerprint } from '@cupboard/nix-store/narinfo';
import { type NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type NarInfoGeneration,
	narInfoGenerationSchema,
	type NixSha256HashString,
	type RootName,
	type StoredCache,
	type StorePathHash,
	type StorePathString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { type TenantStatus } from '@cupboard/protocol/tenants';
import {
	type CommitResponse,
	type ParsedUploadGraceFact,
	type ParsedUploadPathNegotiation,
	type SessionId,
	type UploadId
} from '@cupboard/protocol/upload';
import { withDeadline } from '@cupboard/shared/timeout';
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

import { type NarVerification } from '../blob/nar-verify.ts';
import { verifyDecompressedNar } from '../blob/nar-verify.ts';
import { signNixFingerprint } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	NarTooLargeError,
	QuotaExceededError,
	SubrequestTimeoutError,
	TenantWritesStoppedError,
	UploadCacheMismatchError,
	UploadedObjectNotFoundError,
	UploadExpiredError,
	UploadNotFoundError
} from '../errors.ts';
import {
	narInfoObjectKey,
	narObjectKey,
	type R2ObjectKey,
	verifiableMaxBytes
} from '../http/http.ts';
import type { MaintenanceQueueMessage } from '../routing/scheduled.ts';

import { armAlarmNoLaterThan } from './alarm.ts';
import { batchNonEmpty, chunk, maxInClauseValues } from './bulk.ts';
import { type CacheAdminService } from './cache-admin-service.ts';
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
import { parseStoredUploadPathMetadata } from './upload-metadata.ts';
import { type UploadStateService } from './upload-state-service.ts';

// How long a sent `tenant-verify` request suppresses further sends before it
// is presumed lost and a deferral may send again. Must stay below the verify
// alarm backstop's delay, so that when the backstop fires the previous request
// is already stale and its re-request is a real send.
export const verifyRequestStaleMs = 45_000;

// The verify backstop: a durable storage marker holding the epoch millisecond
// at which the alarm re-drives verification, armed by every deferral. The
// queue path settles work in seconds when healthy; the backstop bounds how
// long a lost message, a dead-lettered pass or an evicted instance can leave
// waiters parked. The delay sits above `verifyRequestStaleMs` (see there).
export const verifyBackstopKey = 'maintenance:verify-pending';
export const verifyBackstopDelayMs = 60_000;

// A stall guard for `verifyPendingNar`'s fetch-and-decode, which runs off the
// critical section and so carries no deadline scope of its own. Generous
// enough that a legitimately large NAR never hits it: the queue consumer does
// the routine decode off the DO, so this path is only the backstop for a
// stalled R2 body stream.
export const narVerifyBudgetMs = 5 * 60 * 1000;

/**
 * What a commit settled to at commit time: the path is served (`settled`,
 * committed by these bytes or already present from an earlier upload), or the
 * upload is stored pending verification (`deferred`) and the caller waits for
 * the verification pass's verdict. Failures are thrown.
 */
// The optional `grace` fact is populated only for an upload that accepted
// grace facts, mirroring the wire rule: a legacy upload's frames keep exactly
// the legacy shapes.
export type CommitOutcome =
	| {
			readonly kind: 'settled';
			readonly response: CommitResponse;
			readonly grace?: ParsedUploadGraceFact;
	  }
	| {
			readonly kind: 'deferred';
			readonly storePathHash: StorePathHash;
			readonly narHash: NixSha256HashString;
			readonly grace?: ParsedUploadGraceFact;
	  };

// The tenant's publish status and quota basis, read together by
// {@link CommitPipelineService.tenantAccount}. The usage columns are nullable
// because the left join may find no usage row.
export interface TenantAccount {
	readonly status: (typeof d1Schema.tenant.$inferSelect)['status'];
	readonly bytes: number | null;
	readonly casBytes: number | null;
	readonly quotaBytes: number | null;
}

// The canonical blob facts a materialisation renders and charges from.
interface CanonicalBlobFacts {
	readonly fileHash: NixSha256HashString;
	readonly fileSize: number;
	readonly compression: (typeof d1Schema.blobState.$inferSelect)['compression'];
}

/**
 * One settle awaiting the shared materialise flush; see
 * {@link CommitPipelineService.materialiseBatched}.
 */
export interface MaterialiseRequest {
	readonly cache: StoredCache;
	readonly metadata: ParsedUploadPathNegotiation;
	readonly generation: NarInfoGeneration;
	readonly probe: MaterialisationProbe;
	readonly mustOwnBlob: boolean;
	/**
	 * The retention grace decision captured when this upload was negotiated,
	 * applied atomically with the materialisation. `undefined` is a row from
	 * before the decision existed and grants nothing.
	 */
	readonly graceDecision: GraceDecision | undefined;
	/**
	 * The run root the push bound at negotiate, stamped on the pending row. A
	 * materialised outcome attaches the committed path to it inside the same
	 * gate; `undefined` is a push that named no root and attaches nothing.
	 */
	readonly attachRootName: RootName | undefined;
	/**
	 * Runs inside the flush gate before the fence; a false verdict settles the
	 * request as `gone` (its row's fate was decided elsewhere) without charging.
	 * Must be synchronous: the whole point of the shared gate is that nothing
	 * awaits inside it beyond the one combined charge batch.
	 */
	readonly isStillSettleable?: () => boolean;
}

/**
 * What a batched materialisation settles to: a {@link MaterialiseOutcome}, or
 * `gone` when the request's own settleable check found its row's fate already
 * decided.
 */
export type BatchedMaterialiseOutcome =
	MaterialiseOutcome | { readonly kind: 'gone' };

// What one charge settles to. `tenant-inactive` carries the status the charge
// batch's own select read, which is the authoritative fence for the decision.
type ChargeOutcome =
	| { readonly kind: 'charged' }
	| { readonly kind: 'over-quota' }
	| {
			readonly kind: 'tenant-inactive';
			readonly tenantStatus: TenantStatus | undefined;
	  };

// What a whole flush's combined charge batch settles to. `retry-individually`
// means the batch rolled back and each charge re-runs on its own.
type BatchChargeOutcome =
	| Exclude<ChargeOutcome, { kind: 'over-quota' }>
	| { readonly kind: 'retry-individually' };

interface PendingMaterialise {
	readonly request: MaterialiseRequest;
	readonly resolve: (outcome: BatchedMaterialiseOutcome) => void;
	readonly reject: (error: unknown) => void;
}

// How many settles one flush charges in a single D1 batch: five statements
// and a handful of bound parameters each, kept well inside D1's per-batch
// budgets. A larger burst drains over successive flushes.
const materialiseFlushCap = 32;

// How many times a concede re-resolves a winner that moved inside its await
// window before deferring to the verify pass. Each retry needs a fresh
// recommit to have landed inside the window, so real contention settles in
// one or two; the cap only stops sustained churn from pinning one request.
const concedeAttemptLimit = 3;

// A flush produced no outcome for a request it carried: a programming error
// (every fence and charge path assigns one). Surfacing it keeps the waiter
// from parking forever.
class MaterialiseFlushOutcomeMissingError extends Error {
	constructor() {
		super('materialise flush produced no outcome for a request');
		this.name = 'MaterialiseFlushOutcomeMissingError';
	}
}

/**
 * The per-path facts a materialisation decides on, probed outside the critical
 * section so their round-trips never hold the gate: the canonical blob's
 * compressed metadata and object presence, and whether the tenant already holds
 * the hash (no fresh charge). The tenant account (publish status and quota
 * basis) is not here: it is tenant-wide, so a flush reads it once for its whole
 * batch, not once per path. The gate re-checks only what the single
 * writer owns (the generation fence and the in-memory offboarding flag); a probe
 * going stale converges through the same paths a concurrent delete always could,
 * and the quota CHECK constraint remains the authoritative guard behind the
 * probed decision.
 */
export interface MaterialisationProbe {
	readonly blob: CanonicalBlobFacts | undefined;
	readonly isCanonicalPresent: boolean;
	readonly isOwned: boolean;
}

// The two D1 facts a probe reads for one narHash: its canonical `blob_state` and
// this tenant's presence. A batch read supplies these for a whole claimed set at
// once, so a per-path probe reads neither from D1; the R2 head that decides
// `isCanonicalPresent` has no batch form and stays per path.
export interface PrefetchedMaterialisationFacts {
	readonly blob: CanonicalBlobFacts | undefined;
	readonly isOwned: boolean;
}

// Whether charging this hash would take the tenant over its quota. A null
// quota or a hash the tenant already holds is within quota; null usage
// columns (no usage row) count as zero, matching an unset quota.
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

// A stalled body a verify has already piped through is locked, so calling
// `cancel` on it directly only rejects; it never reaches R2's underlying
// stream. Retaining the sole reader over `body` instead, and forwarding its
// chunks through a fresh stream for the verifier to pipe, means the returned
// `cancel` reaches the R2 stream regardless of what the verifier does with the
// stream it was handed.
function cancellableNarBody(body: ReadableStream<Uint8Array>): {
	readonly stream: ReadableStream<Uint8Array>;
	readonly cancel: (reason?: unknown) => Promise<void>;
} {
	const reader = body.getReader();
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();

			if (done) {
				controller.close();
				return;
			}

			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});

	return { stream, cancel: (reason) => reader.cancel(reason) };
}

export class CommitPipelineService {
	// Single-flight guard for the prompt verification request: when a
	// `tenant-verify` message was enqueued, cleared when the next pass starts
	// and claims the pending rows (`onVerificationPassStarted`). While a recent
	// send is outstanding, a deferral skips its own: the row is written before
	// the deferral requests, and an unclaimed send means that pass has not yet
	// taken its snapshot, so the pass already coming will observe the row. One
	// message thereby covers a whole push with no duplicate.
	//
	// The guard is a timestamp so a lost message cannot suppress requests
	// forever: past `verifyRequestStaleMs` a deferral sends again. Eviction
	// clearing it early is harmless, since the worst case is one duplicate
	// message whose claim is idempotent and chunk-bounded.
	private verifyRequestedAt: number | undefined;

	// The settles awaiting the next materialise flush, and the drain currently
	// flushing them; see {@link materialiseBatched}.
	private readonly materialiseQueue: PendingMaterialise[] = [];
	private materialiseDrain: Promise<void> | undefined;

	constructor(
		private readonly context: ServerContext,
		private readonly cacheAdmin: CacheAdminService,
		private readonly signingKeysService: SigningKeysService,
		private readonly uploadState: UploadStateService,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly retention: RetentionService
	) {}

	// Sends a `verdict/servable` frame to any commit session parked on this
	// upload. The row's session id is re-read at notify time, so a reconnect that
	// re-pointed the row via `attachSession` after the saga read it receives the
	// verdict. `excludeSessionId` is the session that initiated the commit; it
	// receives the result via the return value, so it is skipped even when the
	// row still names it.
	private notifyUploadWaiters(
		uploadId: UploadId,
		excludeSessionId: SessionId | null | undefined
	): void {
		const row = this.context.db
			.select({
				sessionId: schema.pendingUploads.sessionId,
				cache: schema.pendingUploads.cache,
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

		// The grace fact is sent only for an upload that accepted grace facts,
		// keeping a legacy upload's frames on the legacy shape. The
		// deadline is read afresh from storage, the same fact every other
		// servable verdict reports; the callers apply the captured grace before
		// notifying, so the row it reads is current.
		const graceDecision = parseStoredGraceDecision(row.graceDecisionJson);
		const grace =
			graceDecision?.reportsGrace === true
				? storedGraceFact(
						this.context.db,
						row.cache,
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

	// Commits a reuse of a blob already in the verified CAS: reserve the row, then
	// materialise from the existing canonical object and `blob_state`. If the shared
	// blob was reaped between negotiate and now, reclaim the row and report it gone:
	// a narinfo with no backing object must never be served.
	private async commitReusedBlob(
		logger: Logger,
		cache: StoredCache,
		uploadId: UploadId,
		metadata: ParsedUploadPathNegotiation,
		graceDecision: GraceDecision | undefined,
		attachRootName: RootName | undefined,
		// The caller's probe of the shared facts, taken alongside its advisory
		// checks. It may be stale by the gate below; the charge batch is the
		// authoritative guard.
		probe: MaterialisationProbe,
		committingSessionId: SessionId | null | undefined,
		// Whether the probe was supplied from a batch prefetch. An over-quota outcome
		// with a prefetched probe may reflect stale `isOwned`: a sibling entry in the
		// same batch charged the blob first, making the tenant its new owner. Re-probe
		// fresh and retry exactly once before treating it as terminal; the re-probe and
		// the retry are each idempotent.
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

		// `mine` means this same upload-id already holds the reservation, a
		// same-uploadId replay racing its original. Proceed through materialise with
		// the existing generation, mirroring how the verify path handles `mine`.
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

		// Over quota on a prefetched probe: the prefetched `isOwned` can be stale when
		// two entries in one batch share a narHash: the sibling that settled first
		// charged the blob and became the owner. Re-probe fresh and retry once; the
		// charge batch remains the authoritative fence. The same shape as
		// `materialiseVerified`'s over-quota retry.
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

		if (outcome.kind === 'materialised') {
			// The object publishes after the gate; the marker clears only once it
			// has landed, so an interruption in between stays re-drivable.
			await this.narInfoObjects.publishNarInfoObject(
				cache,
				metadata.storePathHash,
				generation,
				metadata.narHash,
				outcome.narInfo
			);

			// Notify any session parked behind this saga before clearing the row.
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

		// blob-gone: reclaim the reserved row only when it was not already committed
		// by a concurrent saga. A superseded row belongs to a replacement now, so
		// this upload settles as committed only for its own still-current row. The
		// grace confirmation runs inside the same gated callback as the identity
		// proof: the input gate reopens the moment that callback completes, so a
		// confirmation outside it could race a delete or recommit queued behind
		// the gate. Applied together they are atomic, and the returned fact is
		// the grant the winner's row actually holds.
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

			// A concurrent commit already materialised this generation; the
			// object serves. This upload lost the race, so its own captured
			// decision never ran; apply it against the winner's generation
			// before any waiter hears the verdict and before the row holding
			// the decision is cleared, or a positive policy would grant nothing.
			// The push's run root retains the path for the same reason, applied
			// with the same identity proof.
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

	// The tenant's publish gate and quota basis in one read. The status is the
	// advisory active check the probe carries: the Worker's write gate read it
	// before dispatch, but a commit can settle here after a suspend or offboard,
	// so the probe re-reads it, and the charge batch fences it authoritatively (a
	// write applies only while the tenant row is active, decided in the batch).
	// A missing row reads as not-active and fails closed. The usage columns come
	// from a left join, so the same read also answers the quota decision; an
	// absent usage row leaves them null, which {@link isOverQuota} reads as
	// within quota.
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

	// Whether another upload's live saga backs a reservation of this hash: a
	// row still awaiting its verdict and not yet expired. An expired or reaped
	// rival left its reservation dead, with nothing for the verification pass
	// to arbitrate.
	private hasLiveRival(
		cache: StoredCache,
		narHash: NixSha256HashString,
		uploadId: UploadId,
		nowIso: IsoTimestamp
	): boolean {
		// A null verdict is an inline commit mid-flight; `committing` and
		// `pending` are sagas the verification pass re-drives.
		const awaitingVerdict = or(
			isNull(schema.pendingUploads.verdict),
			inArray(schema.pendingUploads.verdict, ['committing', 'pending'])
		);
		const rivalFilter = and(
			eq(schema.pendingUploads.cache, cache),
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

	// Whether the tenant holds a presence edge for this hash; if so, charging it
	// would replay an existing ownership and must be skipped.
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

	// The five statements one charge contributes to an atomic D1 batch: credit
	// the usage counters (gated on the edge/presence rows not yet existing, so a
	// replay neither double-charges nor double-references), insert the edge and
	// presence rows, and clear the reaper grace timer so a re-referenced blob
	// stays alive. Every statement applies only while the tenant row is active,
	// so the batch that carries them is also the authoritative status fence.
	private chargeStatements(
		tenant: TenantId,
		cache: StoredCache,
		metadata: ParsedUploadPathNegotiation,
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
			eq(d1Schema.blobReference.cache, cache),
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
			this.context.d1
				.insert(d1Schema.blobReference)
				.select((qb) =>
					qb
						.select({
							tenant: sql<TenantId>`${tenant}`.as('tenant'),
							cache: sql<string>`${cache}`.as('cache'),
							storePathHash: sql<StorePathHash>`${metadata.storePathHash}`.as(
								'store_path_hash'
							),
							generation: sql<number>`${generation}`.as('generation'),
							narHash: sql<NixSha256HashString>`${metadata.narHash}`.as(
								'nar_hash'
							)
						})
						.from(d1Schema.tenant)
						.where(activeTenantFilter)
				)
				.onConflictDoNothing(),
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

	// The status read every charge batch carries: not-active (or a missing row)
	// means every conditional write in the batch was a no-op, telling a refused
	// charge apart from an applied one. Fails closed, matching the write gate.
	private tenantStatusSelect(tenant: TenantId) {
		return this.context.d1
			.select({ status: d1Schema.tenant.status })
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, tenant));
	}

	// Writes the reference edge and per-tenant presence and charges usage, all in one
	// atomic D1 batch that is also the authoritative status fence; see
	// {@link chargeStatements}. An over-quota bytes charge fails the
	// `tenant_usage` CHECK and rolls the whole batch back: no edge and no charge
	// are ever stranded over quota.
	private async reserveEdgeAndCharge(
		tenant: TenantId,
		cache: StoredCache,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration,
		blob: { readonly fileSize: number }
	): Promise<ChargeOutcome> {
		const now = isoTimestamp(new Date());

		// The probed pre-check is the clean over-quota rejection. The
		// `tenant_usage` CHECK constraint backs it as a database-level invariant.
		let statusRows: { status: TenantAccount['status'] }[];

		try {
			const [status] = await this.context.d1.batch([
				this.tenantStatusSelect(tenant),
				...this.chargeStatements(tenant, cache, metadata, generation, blob, now)
			]);
			statusRows = status;
		} catch (error) {
			// Two commits can both probe under quota and race to the charge; the
			// CHECK fails the loser's batch. An authoritative in-gate re-read tells
			// that loss apart from a fault: genuinely over quota reclaims cleanly,
			// anything else propagates.
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

	// The whole flush's charges in one atomic D1 batch, one status select plus
	// five conditional statements per settle. The statements run sequentially
	// inside the transaction, so two settles of the same hash in one flush see
	// each other's presence row and charge it once, exactly as two sequential
	// batches would. A thrown batch (one settle's charge tripping the quota
	// CHECK rolls all of them back) answers `retry-individually`, and the flush
	// re-runs each charge on its own so only the offenders refuse.
	private async reserveEdgesAndCharge(
		tenant: TenantId,
		charges: readonly {
			readonly cache: StoredCache;
			readonly metadata: ParsedUploadPathNegotiation;
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

	// Arms the durable verify backstop for `now + verifyBackstopDelayMs`. An
	// already-armed future deadline is never pushed later, so a stream of
	// deferrals cannot starve an imminent firing; a past-due marker (the
	// backstop is firing and re-requesting) starts the next cycle instead.
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

	// The synchronous half of a materialisation, run inside the shared flush
	// gate: the offboarding and probe checks, the generation fence against the
	// live row, and the advisory quota decision. A chargeable request comes back
	// with its narinfo rendered and the canonical facts its charge uses;
	// everything else settles with its outcome here, before any charge.
	private materialiseFence(
		request: MaterialiseRequest,
		account: TenantAccount | undefined
	):
		| {
				readonly outcome: Exclude<MaterialiseOutcome, { kind: 'materialised' }>;
		  }
		| { readonly narInfo: NarInfo; readonly blob: CanonicalBlobFacts } {
		const { cache, metadata, generation, probe } = request;

		// A commit that passed the Worker's write gate while the tenant was active
		// can still be settling here after the tenant was suspended or began
		// offboarding. Publishing its edge now would re-reference a shared blob
		// the drain is reclaiming, pinning it forever, so the caller reclaims the
		// reserved row instead. The in-memory flag is re-checked inside the gate:
		// the offboard drain runs its passes under the same gate on this instance
		// after setting it, so the flag and the gate together keep an edge write
		// from landing behind a drain pass. The single rule, publish only while
		// the tenant is active, covers suspended, offboarding, offboarded and a
		// missing row alike.
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

		// A reuse binds a narinfo to bytes this tenant never re-proved, on the
		// strength of its presence edge; with the edge gone (a delete credited it
		// back) the reuse fails towards re-upload: the presence edge is gone.
		if (request.mustOwnBlob && !probe.isOwned) {
			return { outcome: { kind: 'blob-gone' } };
		}

		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, metadata.storePathHash)
				)
			)
			.get();

		// A concurrent recommit may have replaced the row between reserve and now;
		// only materialise the version this commit reserved, so the edge and the
		// served object always describe the same narinfo version.
		if (row?.generation !== generation || row.narHash !== metadata.narHash) {
			return { outcome: { kind: 'superseded' } };
		}

		// Quota decision against the size that will actually be charged: the
		// canonical `blob_state` size, which the promote may have adopted from an
		// existing encoding and so can differ from the staged size the negotiate
		// pre-check used. Refusing here lets the caller reclaim the reserved row;
		// the charge batch re-fences the decision.
		if (isOverQuota(account, probe.isOwned, probe.blob.fileSize)) {
			return { outcome: { kind: 'over-quota' } };
		}

		// The blob was probed present, so the narinfo renders from the row and the
		// metadata already in hand.
		return {
			narInfo: this.narInfoObjects.buildNarInfo(row, probe.blob),
			blob: probe.blob
		};
	}

	// Settles one flush of materialisations inside the caller's gate: each
	// request's settleable check and synchronous fence run first, then every
	// surviving charge joins one combined D1 batch. A batch a quota race rolled
	// back re-runs each charge on its own, so only the offenders refuse.
	// Returns one outcome per request, in order.
	private async settleMaterialiseFlushLocked(
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

	// Applies each materialised request's captured grace decision inside the same
	// gate that finalised its generation, so the collector can never observe the
	// committed path without its deadline. A decision with no matching policy, or
	// a row from before decisions existed, grants nothing; a zero grace marks the
	// cache grace-managed without a lasting deadline. Grouped so one flush issues
	// one extension per distinct cache and deadline.
	private applyCapturedGrace(
		requests: readonly MaterialiseRequest[],
		outcomes: (BatchedMaterialiseOutcome | undefined)[]
	): void {
		const settledAt = Date.now();
		const managedCaches = new Set<StoredCache>();
		const extensions = new Map<
			string,
			{
				readonly cache: StoredCache;
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

			managedCaches.add(request.cache);

			if (graceSeconds === 0) {
				continue;
			}

			const retainUntil = isoTimestamp(
				new Date(settledAt + graceSeconds * 1000)
			);
			const key = `${request.cache} ${retainUntil}`;
			const group = extensions.get(key) ?? {
				cache: request.cache,
				retainUntil,
				entries: []
			};

			group.entries.push({ index, hash: request.metadata.storePathHash });
			extensions.set(key, group);
		}

		for (const cache of managedCaches) {
			this.retention.markCacheGraceManaged(cache);
		}

		for (const group of extensions.values()) {
			const hashes = group.entries.map((entry) => entry.hash);

			this.retention.extendGraceDeadlines(
				group.cache,
				hashes,
				group.retainUntil
			);

			// The upsert is monotonic, so storage may already hold a later
			// deadline than the candidate above (an earlier longer policy, or a
			// root transition); read it back so the reply and frames report the
			// stored maximum rather than what this settle alone computed.
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

	// Attaches each materialised request's committed path to the run root its
	// push bound at negotiate, inside the same gate that finalised the
	// generation, so the collector can never observe the committed path without
	// its retention row. Additive and monotonic, keyed by cache, root and
	// store-path hash: a replayed flush re-inserts nothing, and nothing is ever
	// released, so no grace transition runs and the root row's expiry is
	// untouched. The narinfo row exists by construction here, and the run
	// root's target list may grow past the per-request root-write cap, which
	// bounds request sizing only.
	private applyRootAttach(
		requests: readonly MaterialiseRequest[],
		outcomes: readonly (BatchedMaterialiseOutcome | undefined)[]
	): void {
		const targets = requests.flatMap((request, index) =>
			outcomes[index]?.kind === 'materialised' &&
			request.attachRootName !== undefined
				? [
						{
							cache: request.cache,
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

	// One flush: a single gate settles a whole batch, taken from the queue
	// inside the gate callback itself. The wait for the gate is the collection
	// window: every settle whose own turn in the gate queue (its reserve, a
	// competing flush) came up while this flush waited has enqueued by the time
	// the callback runs, so a concurrent burst lands in one batch with no timer
	// involved. The waiters resume once the gate has released, so their
	// publishes and replies never run under it. A flush that fails as a whole
	// (a D1 fault surviving the individual retries) rejects every waiter it
	// carried; each caller's own error handling answers its client, and the
	// saga markers keep the settles re-drivable.
	private async flushMaterialiseQueue(logger: Logger): Promise<void> {
		let batch: PendingMaterialise[] = [];
		let outcomes: (BatchedMaterialiseOutcome | undefined)[] = [];

		// The tenant account is tenant-wide, so one read outside the gate serves
		// every settle this flush collects; the charge batch is the authoritative
		// quota fence, so a value made stale by a prior flush's charges only softens
		// this advisory check.
		const account = await this.tenantAccount(this.context.requireTenant());

		try {
			await this.context.criticalSection(async () => {
				batch = this.materialiseQueue.splice(0, materialiseFlushCap);
				outcomes = await this.settleMaterialiseFlushLocked(
					batch.map((item) => item.request),
					account
				);
			});
		} catch (error) {
			// A failure before the callback took its batch fails everything queued:
			// they were all waiting on this drain.
			const failed = batch.length > 0 ? batch : [...this.materialiseQueue];

			if (batch.length === 0) {
				this.materialiseQueue.length = 0;
			}

			// The waiters' own surfaces carry no detail, so this log line is the
			// record of what took the flush down.
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

	// Drains the queue a flush at a time. An uncontended settle flushes alone
	// with no added latency; under load, where gates queue behind one another,
	// each flush's wait collects the burst that shares it.
	private async drainMaterialiseQueue(logger: Logger): Promise<void> {
		try {
			while (this.materialiseQueue.length > 0) {
				await this.flushMaterialiseQueue(logger);
			}
		} finally {
			this.materialiseDrain = undefined;
		}
	}

	// Answers a commit that lost its narinfo to a concurrent winner: ensures the
	// winner's object is materialised, reclaims this upload's staging object, and
	/**
	 * The tenant's advisory publish status and quota basis, for a batch caller
	 * that reads the account once and passes it into each entry's commit. The
	 * charge batch remains the authoritative fence; this is the same read
	 * {@link commit} performs internally when no advisory account is supplied.
	 */
	async readTenantAccount(): Promise<TenantAccount | undefined> {
		return this.tenantAccount(this.context.requireTenant());
	}

	/**
	 * Attaches one committed path to the run root a push bound at negotiate,
	 * for a settle that finalises outside the shared flush: an already-present
	 * answer, a concede to a concurrent winner, or a re-driven saga whose
	 * generation a competing pass committed. Additive and idempotent by cache,
	 * root and store-path hash; a push that bound no root attaches nothing.
	 * Callers apply it where the committed row's identity has just been
	 * proven, exactly where the captured grace decision is reapplied.
	 */
	attachRootTarget(
		cache: StoredCache,
		rootName: RootName | null | undefined,
		storePathHash: StorePathHash,
		storePath: StorePathString
	): void {
		if (rootName === null || rootName === undefined) {
			return;
		}

		this.context.db
			.insert(schema.retentionRootTargets)
			.values({ cache, rootName, storePathHash, storePath })
			.onConflictDoNothing()
			.run();
	}

	// reports already-present with the winner's narHash. Any blob this upload
	// promoted but no edge now references is left for the reaper to collect.
	// When no committed winner exists yet (the winning upload is still verifying),
	// the upload stays live so the verify pass can settle it.
	async concedeToWinner(
		logger: Logger,
		cache: StoredCache,
		uploadId: UploadId,
		metadata: ParsedUploadPathNegotiation,
		stagingKey: R2ObjectKey,
		graceDecision?: GraceDecision,
		attachRootName?: RootName
	): Promise<CommitOutcome> {
		// Each retry needs a fresh recommit to have landed inside the window, so
		// the loop settles as soon as the path holds still — but sustained churn
		// must not keep one request re-resolving indefinitely, so past the cap
		// the upload defers and the verify pass arbitrates.
		for (let attempt = 0; attempt < concedeAttemptLimit; attempt += 1) {
			const winner = await this.narInfoObjects.committedNarInfoRow(
				cache,
				metadata.storePathHash
			);

			if (winner === undefined) {
				// The row is held by a saga that has not yet committed. Leave the
				// upload row intact, and request a prompt verification pass so the
				// deferred socket is answered within its wait window rather than
				// by the hourly sweep.
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

			// This upload lost the race, so its own captured decision never ran;
			// apply it against the winner's generation before the row holding the
			// decision is destroyed, or a crash in between would lose the grant.
			const confirmed = confirmGrace(
				this.context,
				this.retention,
				cache,
				winner.storePathHash,
				winner.generation,
				winner.narHash,
				graceDecision?.graceSeconds
			);

			// The winner was read before the object-heal await, so its row can
			// have moved by now. A mismatch means whatever holds the path is not
			// the winner this concede read: settling would report a stale row and
			// silently drop the captured grant, so resolve the current winner and
			// concede to that instead.
			if (!confirmed.matched) {
				continue;
			}

			// The winner's row identity was just proven by the confirmation, so
			// this push's run root retains the path it published, served by the
			// winner's row.
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

		// The path moved on every attempt: leave the upload row (and its
		// captured decision) intact and let the verify pass arbitrate once the
		// churn subsides. The prompt pass is requested here for the same reason
		// as the no-winner deferral above: the socket only hears `deferred`, so
		// without one its answer would wait on the hourly sweep.
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

	// A verification pass is about to claim the pending rows, satisfying the
	// outstanding request. Clear the guard before the snapshot is taken: the pass
	// starting now has already chosen its rows, so a deferral after this point
	// must enqueue its own request to be seen.
	onVerificationPassStarted(): void {
		this.verifyRequestedAt = undefined;
	}

	// Asks for a prompt verification pass over the maintenance queue, so a pending
	// commit becomes servable within seconds. Single-flight while fresh: at most
	// one message per staleness window per DO instance, so a pass continuing the
	// drain and a concurrent deferral collapse onto one message that claims each
	// row once. A failed send clears the guard so the next deferral retries; a
	// sent message no pass ever claims goes stale and the next deferral re-sends.
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
		} catch (error) {
			this.verifyRequestedAt = undefined;
			logger.warn('verification request not enqueued', { tenant, error });
		}
	}

	async commit(
		logger: Logger,
		cache: StoredCache,
		uploadId: UploadId,
		// Advisory values a batch caller reads once for the whole message. When
		// present, `commit` uses them for its probe and quota pre-check and skips its
		// own D1 reads for those. The charge batch remains the authoritative fence for
		// status and quota; a stale advisory value only softens the pre-check, never
		// bypasses the authoritative guard.
		advisory?: {
			readonly prefetched?: PrefetchedMaterialisationFacts;
			readonly account?: TenantAccount;
		}
	): Promise<CommitOutcome> {
		// A commit settling after offboarding began must publish nothing: refuse
		// before deferring, so the writer hears a stopped write immediately.
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

		if (pending.cache !== cache) {
			throw new UploadCacheMismatchError(uploadId, pending.cache, cache);
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
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, metadata.storePathHash)
				)
			)
			.get();

		if (existingNarInfo !== undefined) {
			// This upload already started its own commit saga and is mid-verify:
			// its row is reserved, not yet servable, and the verification pass
			// re-drives it from the durable marker. Stay deferred, leaving the
			// marker and the staged bytes the re-drive needs intact. A concurrent commit, by contrast,
			// reaches here with its own verdict still null.
			if (pending.verdict === 'committing' || pending.verdict === 'pending') {
				// Request a prompt verification pass so a retried socket is re-driven
				// within its wait window. A `committing` reuse saga that crashed before
				// settling never requested one, so the hourly sweep would otherwise be
				// its only re-drive.
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
				// A concurrent commit already holds the path: heal its object if
				// missing and concede, reclaiming this upload's own staging.
				await this.narInfoObjects.ensureNarInfoObject(
					cache,
					existingNarInfo.storePathHash
				);

				// This upload lost the race, so its own captured decision never ran;
				// apply it against the winner's generation before the row holding
				// the decision is destroyed, or a crash in between would lose the
				// grant.
				const confirmed = confirmGrace(
					this.context,
					this.retention,
					cache,
					existingNarInfo.storePathHash,
					existingNarInfo.generation,
					existingNarInfo.narHash,
					graceDecision?.graceSeconds
				);

				// The winner was read before the reference-check and heal awaits,
				// so its row can have moved by now. Settling on it would report a
				// stale row and silently drop the captured grant; the path is
				// contested, so hand the upload to the verification pass to
				// arbitrate, exactly as a live rival below is handled.
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

				// The winner's row identity was just proven by the confirmation,
				// so this push's run root retains the path it published, served
				// by the winner's row.
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
				// A concurrent commit reserved the path and its saga is live, so the
				// verification pass arbitrates. Track this upload for the pass,
				// exactly as a fresh deferral does, so it reaches a terminal verdict
				// (`servable` once it owns the path, `absent` if the rival version
				// won); the socket is driven to completion without waiting for the
				// commit timeout.
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

			// No live upload backs the reservation: its saga died (the upload
			// expired or was reaped before materialising), so only the periodic
			// scan would ever reap the row. Waiting on that parks every retry of
			// the path behind a heal this commit can perform itself: reclaim the
			// dead reservation and commit afresh.
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

		// The facts a commit decides on: the blob state and canonical presence for
		// the probe, and the tenant's publish status and quota basis. When an advisory
		// prefetch and account are supplied (a batch caller read them once for the
		// whole message), use them to skip the per-entry D1 reads; only the per-path
		// R2 head for a fresh upload's staged object is always per-entry. The charge
		// batch remains the authoritative fence for status and quota; the advisory
		// values only soften the pre-check. A reuse's staged key is the canonical
		// object itself, whose presence the probe already answers, so only a fresh
		// upload heads its private staging object.
		const [probe, stagedObject, account] = await Promise.all([
			this.probeMaterialisation(metadata, advisory?.prefetched),
			pending.r2Key === canonicalKey
				? undefined
				: this.context.env.BLOBS.head(pending.r2Key),
			advisory?.account ?? this.tenantAccount(tenant)
		]);

		// The staged object must exist before a commit can verify or promote it; its
		// contents are checked by the decompression pass, not here, so a missing
		// object is the only synchronous content failure.
		const stagedSize =
			pending.r2Key === canonicalKey
				? probe.isCanonicalPresent
					? (probe.blob?.fileSize ?? 0)
					: undefined
				: (stagedObject?.size ?? undefined);

		if (stagedSize === undefined) {
			throw new UploadedObjectNotFoundError(pending.r2Key);
		}

		// Advisory pre-verify quota check: skip the expensive verify and promote when
		// charging this hash would clearly exceed quota. It estimates the charge from
		// the canonical size if the hash already exists (the promote adopts it),
		// otherwise the stored object's size, which becomes the canonical size; the
		// authoritative decision is made against the canonical size in
		// materialiseServable, so a concurrent promote that changes the size cannot
		// let an over-quota commit through.
		const estimate = probe.blob?.fileSize ?? stagedSize;

		if (
			account !== undefined &&
			isOverQuota(account, probe.isOwned, estimate)
		) {
			throw new QuotaExceededError(tenant);
		}

		// Past the synchronous validation, mark the row `committing` before any of
		// the reserve/promote/materialise work so an interruption (or, once
		// verification runs off the DO, the handoff itself) leaves a durable saga
		// marker the verify pass re-drives. A null-verdict row would be
		// indistinguishable from one still awaiting its bytes, so it must not be
		// left that way. The reuse and fresh branches below both inherit this
		// marker.
		this.uploadState.markUploadCommitting(uploadId);

		// Capture the session that initiated this commit so it can be excluded
		// from `notifyUploadWaiters` inside `commitReusedBlob`: the committing
		// session receives the result via the return value, not through the
		// notify path, and sending it a `verdict` frame before the `settled`
		// return would break the session's expected frame sequence.
		const committingRow = this.context.db
			.select({ sessionId: schema.pendingUploads.sessionId })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();
		const committingSessionId = committingRow?.sessionId;

		// A reuse binds a new narinfo to a blob already in the verified CAS. It
		// passed verify-before-serve when it was first promoted, so bind it without
		// re-verifying its bytes.
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

		// Verify-before-serve for a fresh upload staged under a private key. One
		// too large to ever verify within the CPU budget is rejected, since it
		// could never be served; every other fresh upload defers: it is marked
		// pending, a prompt verification pass is requested, and the caller's
		// socket parks until the pass answers. One path for every size, so no
		// caller has to know about budgets or thresholds.
		if (metadata.narSize > verifiableMaxBytes) {
			await this.uploadState.clearPendingUploadAndStaging(
				uploadId,
				pending.r2Key,
				metadata.narHash
			);

			throw new NarTooLargeError(metadata.narSize, verifiableMaxBytes);
		}

		// Reserve the narinfo row at commit so it exists before verification: a
		// retention root set right after commit can reference it, and the
		// reachability sweep keeps it through the verify window. The verify pass
		// re-runs this idempotently (`mine`, same generation, no counter advance);
		// a `lost` outcome writes no row, and the verify pass answers the waiter.
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

	// Reserves the narinfo row for a commit before its bytes are verified, the
	// row-first half of the row-first/edge-last saga. It signs the fingerprint
	// over the uncompressed `NarHash`/`NarSize`/references only (independent of
	// any compressed encoding), reads and stamps the next generation, and advances
	// the durable counter, all in one DO transaction. It writes neither the D1 edge
	// nor the R2 object and never touches the pending upload, so the reserved row is
	// never servable on its own. On a conflicting row it reports whether that row is
	// this same commit (`mine`, every signed and rendered field matches) or a
	// different version that won the path (`lost`).
	async reserveNarInfoRow(
		cache: StoredCache,
		metadata: ParsedUploadPathNegotiation
	): Promise<ReserveOutcome> {
		const now = isoTimestamp(new Date());
		this.cacheAdmin.loadOrCreateCache(cache);
		const signingKeys = await this.signingKeysService.signingKeys();
		// The fingerprint, and so the signature, commits to the uncompressed NAR and
		// references alone, never the compressed encoding, so the row is reserved and
		// signed from the path metadata before a fresh upload's file hash and size
		// are known.
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
		const sigs = signatures.map((signature) => signature.value);
		const referencesJson = JSON.stringify(metadata.references);

		// Source the generation inside the same transaction as the insert and the
		// counter advance, so a winning reservation reads, stamps and bumps
		// atomically; the counter survives deletes, so a recommit always lands a
		// higher one.
		return this.context.db.transaction((tx) => {
			const seq = tx
				.select({ next: schema.generationSeq.nextGeneration })
				.from(schema.generationSeq)
				.where(
					and(
						eq(schema.generationSeq.cache, cache),
						eq(schema.generationSeq.storePathHash, metadata.storePathHash)
					)
				)
				.get();
			const generation = seq?.next ?? narInfoGenerationSchema.parse(0);
			const inserted = tx
				.insert(schema.narInfos)
				.values({
					cache,
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					narHash: metadata.narHash,
					narSize: metadata.narSize,
					referencesJson,
					deriver: metadata.deriver,
					ca: metadata.ca,
					sigsJson: JSON.stringify(sigs),
					generation,
					createdAt: now
				} satisfies typeof schema.narInfos.$inferInsert)
				.onConflictDoNothing()
				.returning()
				.all();

			if (inserted.length > 0) {
				const nextGeneration = narInfoGenerationSchema.parse(generation + 1);

				tx.insert(schema.generationSeq)
					.values({
						cache,
						storePathHash: metadata.storePathHash,
						nextGeneration
					})
					.onConflictDoUpdate({
						target: [
							schema.generationSeq.cache,
							schema.generationSeq.storePathHash
						],
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
						eq(schema.narInfos.cache, cache),
						eq(schema.narInfos.storePathHash, metadata.storePathHash)
					)
				)
				.get();

			// A row already holds the path. Treat it as this same commit only when
			// every signed and rendered field matches; any difference means a
			// different narinfo version won, and this upload must not adopt its row.
			const isMine =
				existing?.narHash === metadata.narHash &&
				existing.narSize === metadata.narSize &&
				existing.storePath === metadata.storePath &&
				existing.referencesJson === referencesJson &&
				(existing.deriver ?? undefined) === metadata.deriver &&
				(existing.ca ?? undefined) === metadata.ca;

			if (isMine) {
				return { kind: 'mine', generation: existing.generation };
			}

			return { kind: 'lost', narHash: existing?.narHash ?? metadata.narHash };
		});
	}

	// Probes the shared facts a materialisation decides on, outside any critical
	// section so the D1 and R2 round-trips never hold the gate; see
	// {@link MaterialisationProbe}. Must not open its own critical section.
	async probeMaterialisation(
		metadata: ParsedUploadPathNegotiation,
		prefetched?: PrefetchedMaterialisationFacts
	): Promise<MaterialisationProbe> {
		// When a caller batch-read the D1 facts for its whole claimed set, use them
		// and pay only the per-path R2 head, which has no batch form. The facts were
		// read once before phase B and can be stale by the time this path is reached.
		// Safety: phase A's promote upserts blob_state and re-arms deleteAfter = NULL
		// for every batch member, so a batch member's canonical row cannot be reaped
		// mid-pass (the reaper needs a fresh arm plus its grace period). The charge
		// batch remains the authoritative fence for status and quota; a stale isOwned
		// that causes an over-quota result triggers a fresh re-probe and one retry.
		if (prefetched !== undefined) {
			const canonical = await this.context.env.BLOBS.head(
				narObjectKey(metadata.narHash)
			);

			return {
				blob: prefetched.blob,
				isCanonicalPresent: canonical !== null,
				isOwned: prefetched.isOwned
			};
		}

		const tenant = this.context.requireTenant();
		const canonicalFilter = eq(d1Schema.blobState.narHash, metadata.narHash);
		const ownedFilter = and(
			eq(d1Schema.tenantBlob.tenant, tenant),
			eq(d1Schema.tenantBlob.narHash, metadata.narHash)
		);

		// The canonical facts and the presence check are both keyed on the hash and
		// independent, so read them in one D1 batch; the R2 head runs alongside.
		const [d1Rows, canonical] = await Promise.all([
			this.context.d1.batch([
				this.context.d1
					.select({
						fileHash: d1Schema.blobState.fileHash,
						fileSize: d1Schema.blobState.fileSize,
						compression: d1Schema.blobState.compression
					})
					.from(d1Schema.blobState)
					.where(canonicalFilter),
				this.context.d1
					.select({ narHash: d1Schema.tenantBlob.narHash })
					.from(d1Schema.tenantBlob)
					.where(ownedFilter)
			]),
			this.context.env.BLOBS.head(narObjectKey(metadata.narHash))
		]);

		const [blobRows, ownedRows] = d1Rows;

		return {
			blob: blobRows[0],
			isCanonicalPresent: canonical !== null,
			isOwned: ownedRows.length > 0
		};
	}

	// Batch-reads the two D1 probe facts, the canonical `blob_state` and this
	// tenant's presence, for a whole claimed set of narHashes in two chunked `IN`
	// queries, keyed for a per-path probe to read from memory. A settle pass reads
	// this once before phase B, so each path's probe pays only its R2 head and the
	// pass's D1 reads fall from O(paths) to 2 (one concurrent batch per table,
	// regardless of chunk count). The facts can go stale across the batch; the
	// charge batch remains the authoritative fence for status and quota.
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
					compression: d1Schema.blobState.compression
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
					compression: row.compression
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

	// Whether this upload's reserved generation is already fully committed and
	// serving: its reference edge exists (the generation-scoped proof that these
	// bytes verified, promoted and charged, since the edge is written only by the
	// charge) and its narinfo object is published. A re-claimed row that reads true
	// here had only its clear-marker step interrupted, so it needs its bookkeeping
	// finished, not a re-decode and re-materialise. Keys on the per-generation edge,
	// never shared blob presence, so a superseded or lost generation reads false.
	// The D1 and R2 reads run outside any critical section.
	async isGenerationCommitted(
		cache: StoredCache,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const edgeFilter = and(
			eq(d1Schema.blobReference.tenant, tenant),
			eq(d1Schema.blobReference.cache, cache),
			eq(d1Schema.blobReference.storePathHash, metadata.storePathHash),
			eq(d1Schema.blobReference.generation, generation),
			eq(d1Schema.blobReference.narHash, metadata.narHash)
		);
		const [edge, object] = await Promise.all([
			this.context.d1
				.select({ narHash: d1Schema.blobReference.narHash })
				.from(d1Schema.blobReference)
				.where(edgeFilter)
				.get(),
			this.context.env.BLOBS.head(
				narInfoObjectKey(tenant, metadata.storePathHash, cache)
			)
		]);

		return edge !== undefined && object !== null;
	}

	// Materialises a reserved narinfo through the shared flush queue: concurrent
	// settles (socket commits and verify-pass verdicts alike) share one gate and
	// one combined charge batch per flush, so a push of hundreds of paths costs
	// a handful of gates. The request's probe arrives
	// from outside any gate and may be stale by its flush; the charge batch is
	// the authoritative guard, exactly as it is for a lone settle. The returned
	// narinfo's object is the caller's to publish, after the flush.
	async materialiseBatched(
		logger: Logger,
		request: MaterialiseRequest
	): Promise<BatchedMaterialiseOutcome> {
		return new Promise<BatchedMaterialiseOutcome>((resolve, reject) => {
			this.materialiseQueue.push({ request, resolve, reject });
			this.materialiseDrain ??= this.drainMaterialiseQueue(logger);
		});
	}

	// Removes a reserved narinfo row whose commit failed verification, leaving its
	// burned generation in `generation_seq` (monotonic, never reused). The live
	// local row decides the outcome: only while it still carries the reserved
	// `(generation, narHash)` does a committed edge mean the path serves this
	// reservation. A replaced row reports `superseded` whatever edges linger; a
	// stale D1 edge for the old generation can outlive a delete and recommit
	// until the deletion backlog drains, and proves nothing about the live row.
	// Runs in a critical section so the identity read, the edge check and the
	// delete cannot interleave with a materialisation.
	//
	// Runs inside the caller's critical section; must not open its own.
	async reclaimReservedRow(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		narHash: NixSha256HashString
	): Promise<'reclaimed' | 'committed-current' | 'superseded'> {
		const current = this.context.db
			.select({
				generation: schema.narInfos.generation,
				narHash: schema.narInfos.narHash
			})
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		// A vanished row was reclaimed already; the outcome is idempotent.
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
					eq(d1Schema.blobReference.cache, cache),
					eq(d1Schema.blobReference.storePathHash, storePathHash),
					eq(d1Schema.blobReference.generation, generation),
					eq(d1Schema.blobReference.narHash, narHash)
				)
			)
			.get();

		if (materialised !== undefined) {
			return 'committed-current';
		}

		await this.narInfoObjects.deleteNarInfoObject(cache, storePathHash);

		// Every other removal path drops the path's grace deadline with its
		// row; a reclaim must too, and in the same transaction, or a failed
		// verification can leave a dangling deadline that wakes maintenance
		// for nothing and over-retains a later recommit's closure.
		this.context.db.transaction((tx) => {
			tx.delete(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						eq(schema.narInfos.storePathHash, storePathHash),
						eq(schema.narInfos.generation, generation),
						eq(schema.narInfos.narHash, narHash)
					)
				)
				.run();

			tx.delete(schema.retentionGrace)
				.where(
					and(
						eq(schema.retentionGrace.cache, cache),
						eq(schema.retentionGrace.storePathHash, storePathHash)
					)
				)
				.run();
		});

		return 'reclaimed';
	}

	// Fetches a staging object and decodes it, off the critical section: the
	// object can be arbitrarily large, so this must never hold the DO's input
	// gate. `budgetMs` bounds the fetch and decode together against a stalled R2
	// body stream, which would otherwise hang the whole verification pass
	// indefinitely; a test may shorten it below {@link narVerifyBudgetMs} to
	// exercise the timeout without waiting the full budget.
	async verifyPendingNar(
		r2Key: R2ObjectKey,
		metadata: ParsedUploadPathNegotiation,
		budgetMs: number = narVerifyBudgetMs
	): Promise<NarVerification> {
		let cancelBody: ((reason?: unknown) => Promise<void>) | undefined;

		try {
			return await withDeadline(
				async () => {
					const object = await this.context.env.BLOBS.get(r2Key);

					if (object === null) {
						throw new UploadedObjectNotFoundError(r2Key);
					}

					// R2 object bodies are byte streams, but `R2ObjectBody.body` is typed only
					// as `ReadableStream`; narrow it to the byte stream the verifier expects.
					const body = object.body as ReadableStream<Uint8Array>;
					const cancellable = cancellableNarBody(body);
					cancelBody = cancellable.cancel;

					return verifyDecompressedNar(cancellable.stream, {
						narHash: metadata.narHash,
						narSize: metadata.narSize
					});
				},
				budgetMs,
				(abandoned) => new SubrequestTimeoutError('nar.verify', abandoned)
			);
		} catch (error) {
			// The decode loop reads from the fetched body forever unless told
			// otherwise; cancelling it here lets the abandoned call settle promptly
			// instead of leaving the R2 stream open for the rest of the isolate's
			// life.
			if (cancelBody !== undefined && error instanceof SubrequestTimeoutError) {
				try {
					await cancelBody();
				} catch {
					// Best-effort: the timeout still surfaces below regardless of how
					// the cancel itself settles.
				}
			}

			throw error;
		}
	}
}
