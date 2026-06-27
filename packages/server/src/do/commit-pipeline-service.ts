import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type NixSha256HashString,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type CommitResponse,
	type ParsedUploadPathMetadata
} from '@cupboard/protocol/upload';
import { and, eq, notExists, sql } from 'drizzle-orm';

import { type NarVerification } from '../blob/nar-verify.ts';
import { verifyDecompressedNar } from '../blob/nar-verify.ts';
import { verifyUploadedObject } from '../blob/upload-verification.ts';
import { signNixFingerprint } from '../crypto/crypto.ts';
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
	narInfoObjectKey,
	narObjectKey,
	verifiableMaxBytes
} from '../http/http.ts';
import type { MaintenanceQueueMessage } from '../routing/scheduled.ts';

import { type CacheAdminService } from './cache-admin-service.ts';
import {
	type MaterialiseOutcome,
	type ReserveOutcome,
	type ServerContext
} from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type SigningKeysService } from './signing-keys-service.ts';
import { parseStoredUploadMetadata } from './upload-metadata.ts';
import { type UploadStateService } from './upload-state-service.ts';

/**
 * What a commit settled to at commit time: the path is served (`settled`,
 * committed by these bytes or already present from an earlier upload), or the
 * upload is stored pending verification (`deferred`) and the caller waits for
 * the verification pass's verdict. Failures are thrown.
 */
export type CommitOutcome =
	| { readonly kind: 'settled'; readonly response: CommitResponse }
	| {
			readonly kind: 'deferred';
			readonly storePathHash: StorePathHash;
			readonly narHash: NixSha256HashString;
	  };

export class CommitPipelineService {
	constructor(
		private readonly context: ServerContext,
		private readonly cacheAdmin: CacheAdminService,
		private readonly signingKeysService: SigningKeysService,
		private readonly uploadState: UploadStateService,
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

	// Asks for a prompt verification pass over the maintenance queue, so a
	// pending commit becomes servable in seconds rather than at the next
	// hourly sweep. Requested, not awaited: the sweep remains the backstop, so
	// a failed send only delays the promotion and must never fail the commit.
	private async requestVerification(tenant: TenantId): Promise<void> {
		const message: MaintenanceQueueMessage = { kind: 'tenant-verify', tenant };

		try {
			await this.context.env.MAINTENANCE_QUEUE.send(message);
		} catch (error) {
			console.warn('verification request not enqueued', {
				tenant,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	// Commits a fresh inline upload row-first: mark the saga in progress, reserve the
	// not-yet-servable row, verify the staged bytes (never serving them unverified,
	// even when `blob_state` already holds the hash), promote into the shared CAS,
	// then materialise the servable object. A concurrent commit that already holds
	// the path is conceded to; a verification failure reclaims the reserved row and
	// rejects.
	// Commits a reuse of a blob already in the verified CAS: reserve the row, then
	// materialise from the existing canonical object and `blob_state`. If the shared
	// blob was reaped between negotiate and now, reclaim the row and report it gone so
	// the client re-uploads, rather than serve a narinfo with no backing object.
	private async commitReusedBlob(
		cache: string,
		uploadId: string,
		metadata: ParsedUploadPathMetadata
	): Promise<CommitOutcome> {
		const canonicalKey = narObjectKey(metadata.narHash);
		const reserved = await this.reserveNarInfoRow(cache, metadata);

		if (reserved.kind !== 'reserved') {
			return this.concedeToWinner(cache, uploadId, metadata, canonicalKey);
		}

		const outcome = await this.context.ctx.blockConcurrencyWhile(() =>
			this.materialiseServable(cache, metadata, reserved.generation)
		);

		if (outcome === 'materialised') {
			// A reuse commit settles synchronously, so its upload row is cleared
			// rather than retained for observation.
			this.uploadState.clearPendingUpload(uploadId);

			return {
				kind: 'settled',
				response: {
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'committed'
				}
			};
		}

		if (outcome === 'superseded') {
			return this.concedeToWinner(cache, uploadId, metadata, canonicalKey);
		}

		if (outcome === 'tenant-inactive') {
			await this.context.ctx.blockConcurrencyWhile(() =>
				this.reclaimReservedRow(
					cache,
					metadata.storePathHash,
					reserved.generation,
					metadata.narHash
				)
			);
			this.uploadState.clearPendingUpload(uploadId);

			throw new TenantWritesStoppedError(
				this.context.requireTenant(),
				'inactive'
			);
		}

		await this.context.ctx.blockConcurrencyWhile(() =>
			this.reclaimReservedRow(
				cache,
				metadata.storePathHash,
				reserved.generation,
				metadata.narHash
			)
		);
		this.uploadState.clearPendingUpload(uploadId);

		throw new UploadedObjectNotFoundError(canonicalKey);
	}

	// Answers a commit that lost its narinfo to a concurrent winner: ensures the
	// winner's object is materialised, reclaims this upload's staging object, and
	// reports already-present with the winner's narHash. Any blob this upload
	// promoted but no edge now references is left for the reaper to collect.
	private async concedeToWinner(
		cache: string,
		uploadId: string,
		metadata: ParsedUploadPathMetadata,
		stagingKey: string
	): Promise<CommitOutcome> {
		const winner = await this.narInfoObjects.committedNarInfoRow(
			cache,
			metadata.storePathHash
		);

		if (winner !== undefined) {
			await this.narInfoObjects.ensureNarInfoObject(
				cache,
				winner.storePathHash
			);
		}

		await this.uploadState.clearPendingUploadAndStaging(
			uploadId,
			stagingKey,
			metadata.narHash
		);

		return {
			kind: 'settled',
			response: {
				storePathHash: metadata.storePathHash,
				narHash: winner?.narHash ?? metadata.narHash,
				status: 'already-present'
			}
		};
	}

	// The authoritative active check the edge/object publish is gated on: the Worker's
	// write gate read this status before dispatch, but a commit can settle here after a
	// suspend or offboard, so it is re-read in the critical section. A missing row reads
	// as not-active and fails closed.
	private async tenantActive(): Promise<boolean> {
		const row = await this.context.d1
			.select({ status: d1Schema.tenant.status })
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, this.context.requireTenant()))
			.get();

		return row?.status === 'active';
	}

	// Writes the reference edge and per-tenant presence and charges usage, all in one
	// atomic D1 batch. The counters are charged before the inserts and gated on the
	// rows not yet existing, so a replay (the edge/presence already present) neither
	// double-charges nor double-references, and an over-quota bytes charge fails the
	// `tenant_usage` CHECK and rolls the whole batch back: no edge and no charge are
	// ever stranded over quota. Clearing the reaper grace timer in the same batch
	// keeps a re-referenced blob alive.
	private async reserveEdgeAndCharge(
		tenant: TenantId,
		cache: string,
		metadata: ParsedUploadPathMetadata,
		generation: number,
		blob: { readonly fileSize: number }
	): Promise<void> {
		const clock = new Date();
		const now = clock.toISOString();
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
			edgeMissing
		);
		const creditBytesFilter = and(
			eq(d1Schema.tenantUsage.tenant, tenant),
			presenceMissing
		);

		// The `requireQuota` pre-check in the same critical section is the clean
		// over-quota rejection. The `tenant_usage` CHECK constraint backs it as a
		// database-level invariant: should a charge ever reach here over quota, the
		// batch fails and rolls back, so no edge or charge is stranded even though the
		// pre-check is the expected guard.
		await this.context.d1.batch([
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
				.values({
					tenant,
					cache,
					storePathHash: metadata.storePathHash,
					generation,
					narHash: metadata.narHash
				})
				.onConflictDoNothing(),
			this.context.d1
				.insert(d1Schema.tenantBlob)
				.values({ tenant, narHash: metadata.narHash, fileSize: blob.fileSize })
				.onConflictDoNothing(),
			this.context.d1
				.update(d1Schema.blobState)
				.set({ deleteAfter: sql`null` })
				.where(eq(d1Schema.blobState.narHash, metadata.narHash))
		]);
	}

	// Whether charging this hash would take the tenant over its quota. A hash the
	// tenant already holds (no charge), an absent usage row, or an unset quota are all
	// within quota. The caller passes the size that will actually be charged.
	private async overQuota(
		tenant: TenantId,
		narHash: NixSha256HashString,
		fileSize: number
	): Promise<boolean> {
		const usage = await this.context.d1
			.select({
				bytes: d1Schema.tenantUsage.bytes,
				casBytes: d1Schema.tenantUsage.casBytes,
				quotaBytes: d1Schema.tenantUsage.quotaBytes
			})
			.from(d1Schema.tenantUsage)
			.where(eq(d1Schema.tenantUsage.tenant, tenant))
			.get();

		if (usage === undefined) {
			return false;
		}

		if (usage.quotaBytes === null) {
			return false;
		}

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

		if (owned !== undefined) {
			return false;
		}

		return usage.bytes + usage.casBytes + fileSize > usage.quotaBytes;
	}

	// The size a commit of this hash will be charged: the canonical compressed size
	// already recorded for the hash if one exists (the promote adopts that encoding),
	// otherwise this upload's staged size, which becomes the canonical size. Used by
	// the advisory pre-check; the authoritative charge reads the canonical size after
	// the promote.
	private async chargeSize(
		narHash: NixSha256HashString,
		stagedSize: number
	): Promise<number> {
		const existing = await this.context.d1
			.select({ fileSize: d1Schema.blobState.fileSize })
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, narHash))
			.get();

		return existing?.fileSize ?? stagedSize;
	}

	async commit(cache: string, uploadId: string): Promise<CommitOutcome> {
		// A commit settling after offboarding began must publish nothing: refuse
		// before deferring, so the writer hears a stopped write rather than a
		// verification verdict that never comes.
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

		const clock = new Date();
		const nowIso = clock.toISOString();

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
			.set({
				expiresAt: renewedExpiry.toISOString()
			})
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();

		const metadata = parseStoredUploadMetadata(uploadId, pending.metadataJson);
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
			// marker and the staged bytes the re-drive needs intact, rather than
			// conceding and deleting them. A concurrent commit, by contrast,
			// reaches here with its own verdict still null.
			if (pending.verdict === 'committing' || pending.verdict === 'pending') {
				// Request a prompt verification pass so a retried socket is re-driven
				// within its wait window. A `committing` reuse saga that crashed before
				// settling never requested one, so the hourly sweep would otherwise be
				// its only re-drive.
				await this.requestVerification(this.context.requireTenant());

				return {
					kind: 'deferred',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				};
			}

			if (
				!(await this.narInfoObjects.hasCommittedReference(
					cache,
					existingNarInfo
				))
			) {
				// A concurrent commit reserved the path but has not committed its
				// reference yet, so there is nothing to concede to. Track this upload for
				// verification, exactly as a fresh deferral does, so the pass drives it to
				// a terminal verdict (`servable` once it owns the path, `absent` if the
				// rival version won) instead of leaving its socket parked until the commit
				// timeout.
				this.uploadState.markUploadPending(uploadId);
				await this.requestVerification(this.context.requireTenant());

				return {
					kind: 'deferred',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				};
			}

			// A concurrent commit already holds the path: heal its object if missing
			// and concede, reclaiming this upload's own staging.
			await this.narInfoObjects.ensureNarInfoObject(
				cache,
				existingNarInfo.storePathHash
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
				}
			};
		}

		const object =
			(await this.context.env.BLOBS.head(pending.r2Key)) ?? undefined;

		verifyUploadedObject(object, pending.expectedSize, metadata, pending.r2Key);

		// Advisory pre-verify quota check: skip the expensive verify and promote when
		// charging this hash would clearly exceed quota. It estimates the charge from
		// the canonical size if the hash already exists (the promote adopts it),
		// otherwise the staged size; the authoritative decision is made against the
		// canonical size in materialiseServable, so a concurrent promote that changes
		// the size cannot let an over-quota commit through.
		const tenant = this.context.requireTenant();
		const estimate = await this.chargeSize(metadata.narHash, metadata.fileSize);

		if (await this.overQuota(tenant, metadata.narHash, estimate)) {
			throw new QuotaExceededError(tenant);
		}

		// Past the synchronous validation, mark the row `committing` before any of
		// the reserve/promote/materialise work so an interruption (or, once
		// verification runs off the DO, the handoff itself) leaves a durable saga
		// marker the verify pass re-drives, rather than a null-verdict row
		// indistinguishable from one still awaiting its bytes. The reuse and fresh
		// branches below both inherit this marker.
		this.uploadState.markUploadCommitting(uploadId);

		const canonicalKey = narObjectKey(metadata.narHash);

		// A reuse binds a new narinfo to a blob already in the verified CAS. It
		// passed verify-before-serve when it was first promoted, so bind it without
		// re-verifying its bytes.
		if (pending.r2Key === canonicalKey) {
			return this.commitReusedBlob(cache, uploadId, metadata);
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

		await this.requestVerification(tenant);

		return {
			kind: 'deferred',
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash
		};
	}

	// Reserves the narinfo row for a commit before its bytes are verified, the
	// row-first half of the row-first/edge-last saga. It signs the fingerprint —
	// over the uncompressed `NarHash`/`NarSize`/references only, so it is independent
	// of any compressed encoding — reads and stamps the next generation, and advances
	// the durable counter, all in one DO transaction. It writes neither the D1 edge
	// nor the R2 object and never touches the pending upload, so the reserved row is
	// never servable on its own. On a conflicting row it reports whether that row is
	// this same commit (`mine`, every signed and rendered field matches) or a
	// different version that won the path (`lost`).
	async reserveNarInfoRow(
		cache: string,
		metadata: ParsedUploadPathMetadata
	): Promise<ReserveOutcome> {
		const clock = new Date();
		const now = clock.toISOString();
		this.cacheAdmin.loadOrCreateCache(cache);
		const signingKeys = await this.signingKeysService.signingKeys();
		const narInfo = new NarInfo(
			new StorePath(metadata.storePath),
			narObjectKey(metadata.narHash),
			metadata.compression,
			NixSha256Hash.parse(metadata.fileHash),
			metadata.fileSize,
			NixSha256Hash.parse(metadata.narHash),
			metadata.narSize,
			metadata.references,
			metadata.deriver,
			metadata.ca
		);
		const fingerprint = narInfo.fingerprint();
		const sigs = await Promise.all(
			signingKeys.map((key) =>
				signNixFingerprint(key.privateJwk, fingerprint, key.name)
			)
		);
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
			const generation = seq?.next ?? 0;
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
				tx.insert(schema.generationSeq)
					.values({
						cache,
						storePathHash: metadata.storePathHash,
						nextGeneration: generation + 1
					})
					.onConflictDoUpdate({
						target: [
							schema.generationSeq.cache,
							schema.generationSeq.storePathHash
						],
						set: { nextGeneration: generation + 1 }
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

	// Makes a reserved narinfo servable, the edge-last half of the saga and the only
	// place that writes the reference edge and the served object or clears the
	// pending upload. It requires the shared blob to be present — the `available`
	// `blob_state` fact and the canonical R2 object — re-reads the live row to
	// confirm it is still this reserved version, writes the D1 edge and per-tenant
	// presence, renders the object from the canonical compressed metadata in
	// `blob_state`, and puts it. Every step is idempotent, so a crash before the
	// caller resolves the pending upload leaves it re-drivable from its durable marker.
	//
	// Runs inside the caller's critical section; must not open its own.
	async materialiseServable(
		cache: string,
		metadata: ParsedUploadPathMetadata,
		generation: number
	): Promise<MaterialiseOutcome> {
		// A commit that passed the Worker's write gate while the tenant was active can
		// still be settling here after the tenant was suspended or began offboarding.
		// Publishing its edge now would re-reference a shared blob the drain is
		// reclaiming, pinning it forever, so the caller reclaims the reserved row
		// instead. The in-memory flag is a fast same-instance signal; correctness rests
		// on the authoritative D1 status, read in the caller's critical section so the
		// check and the edge write below are one atomic decision. The single rule —
		// publish only while the tenant is active — covers suspended, offboarding,
		// offboarded and a missing row alike.
		if (this.context.offboarding || !(await this.tenantActive())) {
			return 'tenant-inactive';
		}

		const blob = await this.context.d1
			.select({ fileSize: d1Schema.blobState.fileSize })
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, metadata.narHash))
			.get();
		const isCanonicalPresent =
			(await this.context.env.BLOBS.head(narObjectKey(metadata.narHash))) !==
			null;

		if (blob === undefined || !isCanonicalPresent) {
			return 'blob-gone';
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
			return 'superseded';
		}

		const narInfo = await this.narInfoObjects.narInfoFromRow(row);

		if (narInfo === undefined) {
			return 'blob-gone';
		}

		const tenant = this.context.requireTenant();

		// Authoritative quota decision against the size that will actually be charged:
		// the canonical `blob_state` size, which the promote may have adopted from an
		// existing encoding and so can differ from the staged size the pre-check used.
		// Returning here lets the caller reclaim the reserved row rather than charging.
		if (await this.overQuota(tenant, metadata.narHash, blob.fileSize)) {
			return 'over-quota';
		}

		await this.reserveEdgeAndCharge(tenant, cache, metadata, generation, blob);

		await this.narInfoObjects.putNarInfoObject(
			cache,
			metadata.storePathHash,
			narInfo
		);

		// The pending upload's lifecycle is the caller's: an inline commit clears the
		// row (it returns `committed` synchronously), while a deferred commit records a
		// terminal `servable` verdict for `push --wait` to observe.
		return 'materialised';
	}

	// Removes a reserved narinfo row whose commit failed verification, leaving its
	// burned generation in `generation_seq` (monotonic, never reused). Compare-and-
	// delete on the captured `(generation, narHash)`, and only while the row is not
	// yet materialised, so neither a newer recommit nor a concurrent commit that has
	// already made the path servable is ever removed. Runs in a critical section so
	// the object check and the delete cannot interleave with a materialisation.
	//
	// Runs inside the caller's critical section; must not open its own.
	async reclaimReservedRow(
		cache: string,
		storePathHash: StorePathHash,
		generation: number,
		narHash: NixSha256HashString
	): Promise<void> {
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
			return;
		}

		await this.context.env.BLOBS.delete(
			narInfoObjectKey(tenant, storePathHash, cache)
		);

		this.context.db
			.delete(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash),
					eq(schema.narInfos.generation, generation),
					eq(schema.narInfos.narHash, narHash)
				)
			)
			.run();
	}

	async verifyPendingNar(
		r2Key: string,
		metadata: ParsedUploadPathMetadata
	): Promise<NarVerification> {
		const object = await this.context.env.BLOBS.get(r2Key);

		if (object === null) {
			throw new UploadedObjectNotFoundError(r2Key);
		}

		// R2 object bodies are byte streams, but `R2ObjectBody.body` is typed only
		// as `ReadableStream`; narrow it to the byte stream the verifier expects.
		const body = object.body as ReadableStream<Uint8Array>;

		return verifyDecompressedNar(body, {
			narHash: metadata.narHash,
			narSize: metadata.narSize
		});
	}
}
