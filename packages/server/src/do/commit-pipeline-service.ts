import { narFingerprint } from '@cupboard/nix-store/narinfo';
import {
	type NixSha256HashString,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type CommitResponse,
	type ParsedUploadPathNegotiation
} from '@cupboard/protocol/upload';
import { and, eq, notExists, sql } from 'drizzle-orm';

import { type NarVerification } from '../blob/nar-verify.ts';
import { verifyDecompressedNar } from '../blob/nar-verify.ts';
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

import { armAlarmNoLaterThan } from './alarm.ts';
import { type CacheAdminService } from './cache-admin-service.ts';
import {
	type MaterialiseOutcome,
	type ReserveOutcome,
	type ServerContext
} from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
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

// The tenant's publish status and quota basis, read together by
// {@link CommitPipelineService.tenantAccount}. The usage columns are nullable
// because the left join may find no usage row.
interface TenantAccount {
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
 * The shared facts a materialisation decides on, probed outside the critical
 * section so their round-trips never hold the gate: the tenant's publish
 * status and quota basis, the canonical blob's compressed metadata and object
 * presence, and whether the tenant already holds the hash (no fresh charge).
 * The gate re-checks only what the single writer owns (the generation fence
 * and the in-memory offboarding flag); a probe going stale converges through
 * the same paths a concurrent delete always could, and the quota CHECK
 * constraint remains the authoritative guard behind the probed decision.
 */
export interface MaterialisationProbe {
	readonly account: TenantAccount | undefined;
	readonly blob: CanonicalBlobFacts | undefined;
	readonly isCanonicalPresent: boolean;
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
	if (account.quotaBytes === null || isOwned) {
		return false;
	}

	return (
		(account.bytes ?? 0) + (account.casBytes ?? 0) + fileSize >
		account.quotaBytes
	);
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

	constructor(
		private readonly context: ServerContext,
		private readonly cacheAdmin: CacheAdminService,
		private readonly signingKeysService: SigningKeysService,
		private readonly uploadState: UploadStateService,
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

	// Commits a reuse of a blob already in the verified CAS: reserve the row, then
	// materialise from the existing canonical object and `blob_state`. If the shared
	// blob was reaped between negotiate and now, reclaim the row and report it gone so
	// the client re-uploads, rather than serve a narinfo with no backing object.
	private async commitReusedBlob(
		cache: string,
		uploadId: string,
		metadata: ParsedUploadPathNegotiation
	): Promise<CommitOutcome> {
		const canonicalKey = narObjectKey(metadata.narHash);
		const reserved = await this.reserveNarInfoRow(cache, metadata);

		if (reserved.kind !== 'reserved') {
			return this.concedeToWinner(cache, uploadId, metadata, canonicalKey);
		}

		const probe = await this.probeMaterialisation(metadata);
		const outcome = await this.context.ctx.blockConcurrencyWhile(() =>
			this.materialiseServable(cache, metadata, reserved.generation, probe, {
				mustOwnBlob: true
			})
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
		metadata: ParsedUploadPathNegotiation,
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

	// The tenant's publish gate and quota basis in one read. The status is the
	// authoritative active check the edge/object publish is gated on: the Worker's
	// write gate read it before dispatch, but a commit can settle here after a
	// suspend or offboard, so the probe re-reads it (and the gate re-checks just
	// the status right before the charge; see {@link tenantStatus}). A missing
	// row reads as not-active and fails closed. The usage columns ride along on a
	// left join, so the same read also answers the quota decision; an absent usage
	// row leaves them null, which {@link isOverQuota} reads as within quota.
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

	// The narrow in-gate twin of {@link tenantAccount}: only the status column,
	// read inside the critical section. The probe's read runs before the gate,
	// and the wait for the gate plus the R2 head give a suspension written
	// meanwhile a window; writes have no other status check (the front door
	// gates reads only), so this one stands right against the charge.
	private async tenantStatus(
		tenant: TenantId
	): Promise<TenantAccount['status'] | undefined> {
		const row = await this.context.d1
			.select({ status: d1Schema.tenant.status })
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, tenant))
			.get();

		return row?.status;
	}

	// Whether the tenant holds a presence edge for this hash, so charging it
	// would be a replay rather than fresh usage.
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
		metadata: ParsedUploadPathNegotiation,
		generation: number,
		blob: { readonly fileSize: number }
	): Promise<'charged' | 'over-quota'> {
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

		// The probed pre-check is the clean over-quota rejection. The
		// `tenant_usage` CHECK constraint backs it as a database-level invariant:
		// a charge that reaches here over quota fails the batch and rolls it
		// back, so no edge or charge is ever stranded over quota.
		try {
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
					.values({
						tenant,
						narHash: metadata.narHash,
						fileSize: blob.fileSize
					})
					.onConflictDoNothing(),
				this.context.d1
					.update(d1Schema.blobState)
					.set({ deleteAfter: sql`null` })
					.where(eq(d1Schema.blobState.narHash, metadata.narHash))
			]);
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
				return 'over-quota';
			}

			throw error;
		}

		return 'charged';
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
	async requestVerification(tenant: TenantId): Promise<void> {
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
			console.warn('verification request not enqueued', {
				tenant,
				error: error instanceof Error ? error.message : String(error)
			});
		}
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

		// The staged object must exist before a commit can verify or promote it; its
		// contents are checked by the decompression pass, not here, so a missing
		// object is the only synchronous content failure.
		if (object === undefined) {
			throw new UploadedObjectNotFoundError(pending.r2Key);
		}

		// Advisory pre-verify quota check: skip the expensive verify and promote when
		// charging this hash would clearly exceed quota. It estimates the charge from
		// the canonical size if the hash already exists (the promote adopts it),
		// otherwise the stored object's size, which becomes the canonical size; the
		// authoritative decision is made against the canonical size in
		// materialiseServable, so a concurrent promote that changes the size cannot
		// let an over-quota commit through.
		const tenant = this.context.requireTenant();
		const estimate = await this.chargeSize(metadata.narHash, object.size);

		if (await this.overQuota(tenant, metadata.narHash, estimate)) {
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
		metadata: ParsedUploadPathNegotiation
	): Promise<ReserveOutcome> {
		const clock = new Date();
		const now = clock.toISOString();
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

	// Probes the shared facts a materialisation decides on, outside any critical
	// section so the D1 and R2 round-trips never hold the gate; see
	// {@link MaterialisationProbe}. Must not open its own critical section.
	async probeMaterialisation(
		metadata: ParsedUploadPathNegotiation
	): Promise<MaterialisationProbe> {
		const tenant = this.context.requireTenant();
		const [account, blob, canonical, isOwned] = await Promise.all([
			this.tenantAccount(tenant),
			this.context.d1
				.select({
					fileHash: d1Schema.blobState.fileHash,
					fileSize: d1Schema.blobState.fileSize,
					compression: d1Schema.blobState.compression
				})
				.from(d1Schema.blobState)
				.where(eq(d1Schema.blobState.narHash, metadata.narHash))
				.get(),
			this.context.env.BLOBS.head(narObjectKey(metadata.narHash)),
			this.ownsHash(tenant, metadata.narHash)
		]);

		return { account, blob, isCanonicalPresent: canonical !== null, isOwned };
	}

	// Makes a reserved narinfo servable, the edge-last half of the saga and the only
	// place that writes the reference edge and the served object or clears the
	// pending upload. The shared-fact reads arrive in the caller's probe, taken
	// outside the gate so their round-trips never hold it; what runs here is the
	// synchronous generation fence, one atomic D1 batch (the edge, presence and
	// charge), and the narinfo object put. The edge batch stays inside the gate
	// because `reclaimReservedRow` and the offboard drain fence on the edge's
	// existence; the object put stays because it overwrites a fixed key with no
	// compare-and-swap, and the verify passes heal presence, not content, so a
	// stale overwrite would never converge. Every step is idempotent, so a crash
	// before the caller resolves the pending upload leaves it re-drivable from
	// its durable marker.
	//
	// Runs inside the caller's critical section; must not open its own. The
	// probe may be stale by the time the gate runs: a fact deleted after it was
	// probed converges exactly as a delete after the gate always has (the reaper
	// demote re-drive), and the quota CHECK in the charge batch is the
	// authoritative guard behind the probed decision.
	async materialiseServable(
		cache: string,
		metadata: ParsedUploadPathNegotiation,
		generation: number,
		probe: MaterialisationProbe,
		options: { readonly mustOwnBlob: boolean }
	): Promise<MaterialiseOutcome> {
		// A commit that passed the Worker's write gate while the tenant was active
		// can still be settling here after the tenant was suspended or began
		// offboarding. Publishing its edge now would re-reference a shared blob
		// the drain is reclaiming, pinning it forever, so the caller reclaims the
		// reserved row instead. The in-memory flag is re-checked inside the gate:
		// the offboard drain runs its passes under `blockConcurrencyWhile` on this
		// same instance after setting it, so the flag and the gate together keep
		// an edge write from landing behind a drain pass. The single rule, publish
		// only while the tenant is active, covers suspended, offboarding,
		// offboarded and a missing row alike.
		if (this.context.offboarding || probe.account?.status !== 'active') {
			return 'tenant-inactive';
		}

		if (probe.blob === undefined || !probe.isCanonicalPresent) {
			return 'blob-gone';
		}

		// A reuse binds a narinfo to bytes this tenant never re-proved, on the
		// strength of its presence edge; with the edge gone (a delete credited it
		// back) the reuse fails towards re-upload rather than re-referencing a
		// hash the tenant no longer holds.
		if (options.mustOwnBlob && !probe.isOwned) {
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

		// The blob was probed present, so the narinfo renders from the row and the
		// metadata already in hand.
		const narInfo = this.narInfoObjects.buildNarInfo(row, probe.blob);

		// Quota decision against the size that will actually be charged: the
		// canonical `blob_state` size, which the promote may have adopted from an
		// existing encoding and so can differ from the staged size the negotiate
		// pre-check used. Returning here lets the caller reclaim the reserved row
		// rather than charging; the charge batch re-fences the decision.
		if (isOverQuota(probe.account, probe.isOwned, probe.blob.fileSize)) {
			return 'over-quota';
		}

		const tenant = this.context.requireTenant();

		// The probed status can be stale by the whole probe-to-gate window;
		// re-check it here so a suspension never has more than one round trip of
		// room to slip a charge through.
		if ((await this.tenantStatus(tenant)) !== 'active') {
			return 'tenant-inactive';
		}

		const charged = await this.reserveEdgeAndCharge(
			tenant,
			cache,
			metadata,
			generation,
			probe.blob
		);

		if (charged === 'over-quota') {
			return 'over-quota';
		}

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
		metadata: ParsedUploadPathNegotiation
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
