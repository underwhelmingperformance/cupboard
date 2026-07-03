import {
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { type VerifyReport } from '@cupboard/protocol/reports';
import {
	type ParsedUploadPathNegotiation,
	type ParsedUploadStatusResponse
} from '@cupboard/protocol/upload';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import { type NarVerification } from '../blob/nar-verify.ts';
import * as schema from '../db/schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import {
	narInfoObjectKey,
	narObjectKey,
	narObjectKeyPrefix,
	narObjectKeySuffix,
	verifyClaimLeaseMs
} from '../http/http.ts';

import { type CommitPipelineService } from './commit-pipeline-service.ts';
import { sendCommitSessionFrame } from './commit-socket.ts';
import { type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type ReconcileTarget } from './reconcile-queue-service.ts';
import { parseStoredUploadPathMetadata } from './upload-metadata.ts';
import { type UploadStateService } from './upload-state-service.ts';

type NarInfoRow = typeof schema.narInfos.$inferSelect;

// A committed row paired with what an R2 probe found for the two objects it
// points at: its canonical NAR and its tenant narinfo object. The probe runs
// outside the DO gate; the reconcile re-checks the row under the gate before
// acting on it.
interface RowObservation {
	readonly row: NarInfoRow;
	readonly narPresent: boolean;
	readonly objectPresent: boolean;
}

// What a single row's reconcile did, so a batch can tally restores and removals.
type ReconcileOutcome = 'removed' | 'restored' | 'unchanged';

/**
 * A deferred upload claimed for verification, carrying just what the queue
 * consumer needs to fetch and decode the staging object off the DO thread. A
 * `reuse` row's bytes are the shared canonical object, already verified when it
 * was first promoted, so the consumer skips the decode for it.
 */
export interface PendingVerification {
	readonly uploadId: string;
	readonly r2Key: string;
	readonly narHash: NixSha256HashString;
	readonly narSize: number;
	readonly reuse: boolean;
}

// One claim call's result: the chunk of rows the consumer should work now,
// plus whether pending rows were left behind by the row or byte cap, the
// signal to chain a continuation pass.
export interface PendingVerificationBatch {
	readonly claims: readonly PendingVerification[];
	readonly truncated: boolean;
}

// The verdict the queue consumer reached for one claimed upload off the DO
// thread: the decoded NAR verification, that the bytes verified and the
// consumer also promoted them (the canonical object and its `blob_state` row
// are already durable, so the settle skips its own promote), that its staging
// object was definitively gone, or that a transient fault made the consumer
// abandon the claim unsettled, freeing its lease for the next pass.
export type VerificationVerdict =
	| { readonly kind: 'verified'; readonly verification: NarVerification }
	| { readonly kind: 'promoted' }
	| { readonly kind: 'missing' }
	| { readonly kind: 'abandoned' };

// Whether a verdict's apply still owes the promote, or the reporter already
// ran it. The on-DO cron path always promotes itself.
export type PromotionState = 'promote' | 'already-promoted';

// One upload's verdict, carried back to the DO so a whole batch settles in a
// single RPC rather than one round trip per upload.
export interface VerificationResult {
	readonly uploadId: string;
	readonly verdict: VerificationVerdict;
}

// Whether a row is still awaiting its verdict. A terminal row is retained
// through its observation window as the settled authority; verify passes
// overlap, so a straggling verdict may find one and must never reopen it.
function isAwaitingVerdict(
	row: typeof schema.pendingUploads.$inferSelect
): boolean {
	return row.verdict === 'pending' || row.verdict === 'committing';
}

// The rows a verify pass may claim: awaiting a verdict, and not leased to a
// pass already working them. A lease older than `verifyClaimLeaseMs` belongs
// to a pass presumed dead, so its rows are claimable again.
function claimableFilter(now: Date) {
	const leasedBefore = new Date(
		now.getTime() - verifyClaimLeaseMs
	).toISOString();

	return and(
		or(
			eq(schema.pendingUploads.verdict, 'pending'),
			eq(schema.pendingUploads.verdict, 'committing')
		),
		or(
			isNull(schema.pendingUploads.claimedAt),
			lte(schema.pendingUploads.claimedAt, leasedBefore)
		)
	);
}

// Cuts one claim's chunk from the selected rows: at most `limit` rows and at
// most `maxNarBytes` of cumulative uncompressed size over the fresh rows
// (reuse rows decode nothing and count zero), taken as a contiguous prefix in
// id order so the consumer's continuation drains the rest. The first fresh
// row is admitted whatever its size, so a lone over-cap NAR cannot starve.
// `truncated` reports that pending rows were left behind, the consumer's
// signal to chain another pass.
function chunkClaims(
	pendings: readonly (typeof schema.pendingUploads.$inferSelect)[],
	limit: number,
	maxNarBytes: number
): PendingVerificationBatch {
	const claims: PendingVerification[] = [];
	let bytes = 0;
	let hasFresh = false;

	for (const pending of pendings) {
		if (claims.length === limit) {
			return { claims, truncated: true };
		}

		const metadata = parseStoredUploadPathMetadata(
			pending.id,
			pending.metadataJson
		);
		const isReuse = pending.r2Key === narObjectKey(metadata.narHash);
		const cost = isReuse ? 0 : metadata.narSize;

		if (cost > 0 && hasFresh && bytes + cost > maxNarBytes) {
			return { claims, truncated: true };
		}

		claims.push({
			uploadId: pending.id,
			r2Key: pending.r2Key,
			narHash: metadata.narHash,
			narSize: metadata.narSize,
			reuse: isReuse
		});
		bytes += cost;
		hasFresh ||= cost > 0;
	}

	return { claims, truncated: false };
}

export class VerificationService {
	constructor(
		private readonly context: ServerContext,
		private readonly commitPipeline: CommitPipelineService,
		private readonly deletionQueue: DeletionQueueService,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly uploadState: UploadStateService
	) {}

	// Routes an upload's terminal verdict to the commit session waiting on it. The
	// session id is the socket's hibernation tag, read from the row, so the lookup
	// finds the waiter even after the object was evicted between the deferral and
	// this pass. The session stays open: it carries the other ids in the push too.
	private notifyWaiters(
		uploadId: string,
		sessionId: string | null,
		status: ParsedUploadStatusResponse['status']
	): void {
		if (sessionId === null) {
			return;
		}

		for (const socket of this.context.ctx.getWebSockets(sessionId)) {
			sendCommitSessionFrame(socket, { ev: 'verdict', uploadId, status });
		}
	}

	// The on-DO verify path, the hourly-cron backstop: reserve the row, decode and
	// hash-check the staging bytes here, then commit. The prompt path runs the
	// decode in the queue consumer off the DO thread and reaches `commitVerified`
	// through `recordVerification` instead.
	private async verifyAndCommitPending(
		pending: typeof schema.pendingUploads.$inferSelect
	): Promise<void> {
		const metadata = parseStoredUploadPathMetadata(
			pending.id,
			pending.metadataJson
		);

		const reserved = await this.reservePendingRow(pending, metadata);

		if (reserved === undefined) {
			return;
		}

		// A returned `{ok:false}` (a hash/size mismatch or an undecodable frame) is a
		// definitive content failure that reclaims the reserved row. A thrown error
		// splits two ways: a definitively absent staging object cannot reappear, so it
		// fails terminally; any other thrown error is a transient read fault that
		// propagates to the per-iteration guard, leaving the row reserved and its
		// bytes staged for the next pass. `blob_state` already holding the hash never
		// short-circuits the verify: unverified bytes must not bind to the shared
		// object.
		let verification: NarVerification;

		try {
			verification = await this.commitPipeline.verifyPendingNar(
				pending.r2Key,
				metadata
			);
		} catch (error) {
			if (error instanceof UploadedObjectNotFoundError) {
				await this.failReservedUpload(pending, metadata, reserved);
				return;
			}

			throw error;
		}

		await this.commitVerified(
			pending,
			metadata,
			reserved,
			verification,
			'promote'
		);
	}

	// Reserves the narinfo row before committing a verified upload: a fresh deferred
	// upload gets its first row, a crashed or re-driven commit finds its own
	// (`mine`). A different version holding the path (`lost`) means this upload can
	// never own it, so its row and staging bytes are dropped and waiters told
	// `absent`; the caller stops. Returns the reserved generation, or undefined when
	// the path was lost.
	private async reservePendingRow(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation
	): Promise<number | undefined> {
		const reserved = await this.commitPipeline.reserveNarInfoRow(
			pending.cache,
			metadata
		);

		if (reserved.kind === 'lost') {
			await this.uploadState.clearPendingUploadAndStaging(
				pending.id,
				pending.r2Key,
				metadata.narHash
			);
			this.notifyWaiters(pending.id, pending.sessionId, 'absent');
			return undefined;
		}

		return reserved.generation;
	}

	// The post-verify half of the saga, shared by the on-DO cron path and the
	// worker-driven `recordVerification`: a failed verdict reclaims the reserved
	// row, a good one promotes the staging bytes into the shared CAS and
	// materialises the servable object.
	private async commitVerified(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: number,
		verification: NarVerification,
		promotion: PromotionState
	): Promise<void> {
		if (!verification.ok) {
			await this.failReservedUpload(pending, metadata, generation);
			return;
		}

		// Promote outside the critical section: streaming the staging bytes into the
		// shared CAS must not run under `blockConcurrencyWhile`. It is idempotent and
		// content-addressed, so a redundant promotion is harmless. A byte verification
		// carries the file hash and size; a reuse pass-through carries none and
		// promotes against the already-canonical object. A reporter that already
		// promoted (the queue consumer) skips it here entirely.
		if (promotion === 'promote') {
			const blob =
				verification.fileHash !== undefined &&
				verification.fileSize !== undefined
					? { fileHash: verification.fileHash, fileSize: verification.fileSize }
					: undefined;
			await this.uploadState.promoteStagingBlob(pending.r2Key, metadata, blob);
		}

		// Probed after the promote, which is what makes the canonical object and
		// its `blob_state` row exist; probing earlier would read them absent.
		const probe = await this.commitPipeline.probeMaterialisation(metadata);

		const outcome = await this.context.criticalSection(async () => {
			const current = this.context.db
				.select()
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, pending.id))
				.get();

			// A vanished row was settled elsewhere; a terminal one was settled by a
			// competing pass during this apply's promote and probe awaits. Either
			// way the row's fate is decided and this apply must not touch it.
			if (current === undefined || !isAwaitingVerdict(current)) {
				return 'gone' as const;
			}

			return this.commitPipeline.materialiseServable(
				pending.cache,
				metadata,
				generation,
				probe,
				// A deferred settle proved its bytes (a fresh decode, or a reuse row
				// negotiate admitted when the presence edge existed), so ownership is
				// not re-required here; the first commit of a hash is not yet owned.
				{ mustOwnBlob: false }
			);
		});

		if (outcome === 'gone') {
			return;
		}

		// Over quota on the canonical size: reclaim the reserved row and record a
		// terminal `over-quota` verdict, the same shape as an inline over-quota commit.
		// Otherwise a later verify pass, scanning narInfos, would restore its object and
		// make an unreferenced, uncharged path servable.
		if (outcome === 'over-quota') {
			await this.failReservedUpload(
				pending,
				metadata,
				generation,
				'over-quota'
			);
			return;
		}

		// Publishing stopped between the reserve and the gate (a suspension or
		// offboard). The reserved row is reclaimed for the same reason as the
		// over-quota rejection: left behind, a later scan would restore an
		// unreferenced, uncharged object for it. The waiter hears `absent`, the
		// same answer an inline commit's writes-stopped rejection amounts to.
		if (outcome === 'tenant-inactive') {
			await this.context.criticalSection(() =>
				this.commitPipeline.reclaimReservedRow(
					pending.cache,
					metadata.storePathHash,
					generation,
					metadata.narHash
				)
			);
			await this.uploadState.clearPendingUploadAndStaging(
				pending.id,
				pending.r2Key,
				metadata.narHash
			);
			this.notifyWaiters(pending.id, pending.sessionId, 'absent');
			return;
		}

		if (outcome === 'materialised') {
			// The parked sockets carry the verdict, and the narinfo itself is the
			// durable evidence of success, so a settled upload leaves no residue:
			// the row clears and the staging bytes go.
			this.notifyWaiters(pending.id, pending.sessionId, 'servable');
			this.uploadState.clearPendingUpload(pending.id);
			await this.deleteStagingObject(pending);
			return;
		}

		// A concurrent recommit took the path or the blob vanished, so this upload
		// lost: clear its marker. Any blob it promoted that no edge now references is
		// left for the reaper to collect.
		this.uploadState.clearPendingUpload(pending.id);
		await this.deleteStagingObject(pending);
		this.notifyWaiters(pending.id, pending.sessionId, 'absent');
	}

	// Reclaims an upload's private staging object once its saga settles. A reuse
	// row's r2Key is the shared canonical key, which the blob reaper owns and
	// other paths reference, so it is left untouched.
	private async deleteStagingObject(
		pending: typeof schema.pendingUploads.$inferSelect
	): Promise<void> {
		if (pending.r2Key === narObjectKey(pending.narHash)) {
			return;
		}

		await this.context.env.BLOBS.delete(pending.r2Key);
	}

	// Reclaims the reserved row a deferred upload never made servable and records its
	// terminal verdict, so neither a stranded row nor a stuck marker survives. The
	// verdict is `mismatch` for a failed NAR-hash check or `over-quota` for a quota
	// rejection.
	private async failReservedUpload(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: number,
		verdict: 'mismatch' | 'over-quota' = 'mismatch'
	): Promise<void> {
		await this.context.criticalSection(() =>
			this.commitPipeline.reclaimReservedRow(
				pending.cache,
				metadata.storePathHash,
				generation,
				metadata.narHash
			)
		);
		await this.uploadState.markUploadTerminal(
			pending.id,
			pending.r2Key,
			metadata.narHash,
			verdict
		);
		this.notifyWaiters(pending.id, pending.sessionId, verdict);
	}

	// Restore a missing narinfo object, re-confirming the NAR inside the critical
	// section first so a delete during the probe phase cannot leave the object
	// pointing at a removed NAR. Returns 1 when it restored the object, else 0.
	private async restoreNarInfoObject(
		row: typeof schema.narInfos.$inferSelect
	): Promise<number> {
		const isNarPresent =
			(await this.context.env.BLOBS.head(narObjectKey(row.narHash))) !== null;

		if (!isNarPresent) {
			return 0;
		}

		const narInfo = await this.narInfoObjects.narInfoFromRow(row);

		if (narInfo === undefined) {
			return 0;
		}

		await this.narInfoObjects.putNarInfoObject(
			row.cache,
			row.storePathHash,
			narInfo
		);

		return 1;
	}

	private warnSkippedRow(
		row: typeof schema.narInfos.$inferSelect,
		error: unknown
	): void {
		console.warn('verification skipped a narinfo row', {
			cache: row.cache,
			storePathHash: row.storePathHash,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	private narInfoRow(
		cache: string,
		storePathHash: StorePathHash
	): NarInfoRow | undefined {
		return this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();
	}

	// Probes a committed row's two R2 objects outside any critical section, so the
	// round-trips never block a concurrent commit or delete. A transient R2 fault
	// drops the row from this pass rather than aborting it. The narinfo object is
	// only probed when its NAR is present: a missing NAR removes the row regardless
	// of the narinfo object.
	private async probeRow(row: NarInfoRow): Promise<RowObservation | undefined> {
		try {
			const tenant = this.context.requireTenant();
			const isNarPresent =
				(await this.context.env.BLOBS.head(narObjectKey(row.narHash))) !== null;
			const isObjectPresent =
				isNarPresent &&
				(await this.context.env.BLOBS.head(
					narInfoObjectKey(tenant, row.storePathHash, row.cache)
				)) !== null;

			return { row, narPresent: isNarPresent, objectPresent: isObjectPresent };
		} catch (error) {
			this.warnSkippedRow(row, error);

			return undefined;
		}
	}

	// Applies one row's probe under the caller's critical section. The generation
	// re-check rejects any row a commit or delete changed during the probe, so a
	// reconcile never acts on stale state: a NAR only reappears through a commit,
	// which bumps the generation. A missing NAR removes the dangling narinfo; a
	// present NAR with a missing object restores the object.
	//
	// Runs inside the caller's critical section; must not open its own.
	private async reconcileObservation(
		observation: RowObservation,
		origin: string | undefined
	): Promise<ReconcileOutcome> {
		const {
			row,
			narPresent: isNarPresent,
			objectPresent: isObjectPresent
		} = observation;
		const current = this.narInfoRow(row.cache, row.storePathHash);

		if (current?.generation !== row.generation) {
			return 'unchanged';
		}

		try {
			if (!isNarPresent) {
				await this.deletionQueue.reconcileMissingNar(current, origin);

				return 'removed';
			}

			if (!isObjectPresent) {
				return (await this.restoreNarInfoObject(current)) === 1
					? 'restored'
					: 'unchanged';
			}
		} catch (error) {
			this.warnSkippedRow(row, error);
		}

		return 'unchanged';
	}

	// Takes the lease for rows a pass is about to work, synchronously with the
	// selection that chose them, so no other claim can interleave. Only the
	// rows actually handed out are leased: the selection's sentinel row and any
	// rows a cap excluded stay claimable.
	private leaseRows(uploadIds: readonly string[], now: Date): void {
		if (uploadIds.length === 0) {
			return;
		}

		this.context.db
			.update(schema.pendingUploads)
			.set({ claimedAt: now.toISOString() })
			.where(inArray(schema.pendingUploads.id, uploadIds))
			.run();
	}

	// Frees a claimed row the pass working it is abandoning unsettled (a
	// transient fault), so the next pass need not wait the lease out. A crashed
	// pass never reaches this; its rows free at lease expiry.
	private releaseLease(uploadId: string): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ claimedAt: sql`null` })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Reconciles a targeted set of committed paths, the per-push counterpart of the
	// scanning {@link verifyBatch}. The probes run outside the gate; one short
	// critical section applies the generation-checked reconciles. The DO alarm
	// drives this in bounded chunks for a recently negotiated closure, so a missing
	// narinfo object is restored and a lost NAR removed without the negotiate
	// heading R2 on its hot path.
	async reconcileTargets(
		targets: readonly ReconcileTarget[],
		origin: string | undefined
	): Promise<void> {
		const rows = targets
			.map((target) => this.narInfoRow(target.cache, target.storePathHash))
			.filter((row): row is NarInfoRow => row !== undefined);

		if (rows.length === 0) {
			return;
		}

		const observations = await Promise.all(
			rows.map((row) => this.probeRow(row))
		);

		await this.context.criticalSection(async () => {
			for (const observation of observations) {
				if (observation === undefined) {
					continue;
				}

				await this.reconcileObservation(observation, origin);
			}
		});
	}

	// One interactive verify pass: settle deferred uploads first, then run a
	// bounded reconciling batch and report it.
	async verify(
		purgeOrigin: string | undefined,
		limit: number
	): Promise<VerifyReport> {
		await this.verifyPendingUploads(limit);

		return this.verifyBatch(purgeOrigin, limit);
	}

	async verifyBatch(
		origin: string | undefined,
		limit: number
	): Promise<VerifyReport> {
		// Snapshot the cursor and the batch synchronously. Synchronous SQLite on
		// the single-threaded DO cannot interleave with anything, so this is an
		// atomic read without a critical section.
		const cursor = this.context.db
			.select()
			.from(schema.verificationCursor)
			.where(eq(schema.verificationCursor.id, 'active'))
			.get();
		// An empty cursor starts (or restarts) at the lowest (cache, hash): the
		// empty string sorts before every cache name and every 32-character hash.
		const fromCache = cursor?.cache ?? '';
		const fromHash = cursor?.lastStorePathHash ?? '';

		// Verification spans every cache, walking the (cache, store_path_hash)
		// space in order and resuming after the composite cursor. drizzle has no
		// tuple form of `gt`, so the row-value comparison is spelt out.
		const sameCache = eq(schema.narInfos.cache, fromCache);
		const afterHash = gt(schema.narInfos.storePathHash, sql`${fromHash}`);
		const rows = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				or(gt(schema.narInfos.cache, fromCache), and(sameCache, afterHash))
			)
			.orderBy(asc(schema.narInfos.cache), asc(schema.narInfos.storePathHash))
			.limit(limit)
			.all();

		// Probe R2 for every row outside any critical section, so the batch's
		// round-trips never block a concurrent commit or delete. One row's
		// transient R2 fault drops it from this pass rather than aborting the batch.
		const observations = await Promise.all(
			rows.map((row) => this.probeRow(row))
		);

		// Apply the reconciles and advance the cursor in one short critical section.
		// What remains inside the gate is fast synchronous SQLite plus the rare write
		// for an unhealthy row, instead of every row's R2 round-trips.
		return this.context.criticalSection(async () => {
			let narInfoObjectsRestored = 0;
			let danglingNarInfosRemoved = 0;

			for (const observation of observations) {
				if (observation === undefined) {
					continue;
				}

				const outcome = await this.reconcileObservation(observation, origin);

				if (outcome === 'removed') {
					danglingNarInfosRemoved += 1;
				} else if (outcome === 'restored') {
					narInfoObjectsRestored += 1;
				}
			}

			// A short batch means the scan reached the end; clear the cursor so the
			// next pass starts again from the first cache's lowest hash.
			const hasWrapped = rows.length < limit;
			const last = rows.at(-1);
			const nextCache = hasWrapped || last === undefined ? '' : last.cache;
			const nextHash =
				hasWrapped || last === undefined ? '' : last.storePathHash;
			const now = new Date().toISOString();

			this.context.db
				.insert(schema.verificationCursor)
				.values({
					id: 'active',
					cache: nextCache,
					lastStorePathHash: nextHash,
					updatedAt: now
				})
				.onConflictDoUpdate({
					target: schema.verificationCursor.id,
					set: { cache: nextCache, lastStorePathHash: nextHash, updatedAt: now }
				})
				.run();

			return {
				scanned: rows.length,
				narInfoObjectsRestored,
				danglingNarInfosRemoved,
				cursor: nextHash,
				cursorCache: nextCache,
				wrapped: hasWrapped
			} satisfies VerifyReport;
		});
	}

	// Background verify-and-commit of uploads deferred at commit because their blob
	// exceeded the inline budget. Each staging blob is decompressed and hash-verified
	// outside the critical section, then promoted and committed (on a match) or its
	// staging object deleted (on a failure) inside one, so a `pending` path becomes
	// servable only once its bytes are confirmed. Bounded per pass; the cron drives
	// it.
	async verifyPendingUploads(limit: number): Promise<void> {
		// Re-drive both deferred (`pending`) uploads awaiting their first verify and
		// inline commits crashed mid-saga (`committing`); both finish through the same
		// idempotent reserve→verify→promote→materialise path. Leased rows are a
		// consumer pass's in-flight work: this pass claims around them, and takes
		// the lease itself so a consumer crossing it stays off its rows too.
		const now = new Date();
		const pendings = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(claimableFilter(now))
			.orderBy(asc(schema.pendingUploads.id))
			.limit(limit)
			.all();

		this.leaseRows(
			pendings.map((pending) => pending.id),
			now
		);

		for (const pending of pendings) {
			try {
				await this.verifyAndCommitPending(pending);
			} catch {
				// One upload's failure (a transient promote or commit error) must not
				// starve the rest of the pass; free its lease and leave its marker
				// for the next pass.
				this.releaseLease(pending.id);
				continue;
			}
		}
	}

	// Claims deferred uploads for the queue consumer to verify off the DO
	// thread, the first half of the prompt verify path. The consumer fetches,
	// decodes and promotes each staging object, then reports the verdicts. A
	// reuse row is flagged so the consumer skips its decode.
	//
	// The claim is a bounded chunk (see {@link chunkClaims}) of the claimable
	// rows, and leases what it hands out: the selection and the lease are one
	// synchronous step on the single-writer, so a duplicate pass (the alarm
	// backstop's re-request, an overlapping cron) claims nothing already in
	// flight.
	listPendingForVerify(
		limit: number,
		maxNarBytes: number
	): PendingVerificationBatch {
		const now = new Date();
		const pendings = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(claimableFilter(now))
			.orderBy(asc(schema.pendingUploads.id))
			.limit(limit + 1)
			.all();
		const batch = chunkClaims(pendings, limit, maxNarBytes);

		this.leaseRows(
			batch.claims.map((claim) => claim.uploadId),
			now
		);

		return batch;
	}

	// Settles up to `limit` pending reuse rows on the DO. Their bytes are the
	// already-verified canonical object, so the settle is decode-free: the
	// promote is a head plus the `blob_state` upsert. The alarm backstop drives
	// this so waiters on cheap rows are answered even with no consumer pass
	// running; fresh rows stay for the queue consumer, which decodes off the DO
	// thread. The reuse test and the bound run in the query, so a large
	// fresh-row backlog costs nothing to walk past, and the snapshot leases its
	// rows synchronously: a consumer pass's claims are respected, and a
	// consumer crossing this settle stays off its rows in turn.
	async settlePendingReuse(limit: number): Promise<number> {
		const now = new Date();
		const pendings = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(
				and(
					claimableFilter(now),
					eq(
						schema.pendingUploads.r2Key,
						sql`${narObjectKeyPrefix} || ${schema.pendingUploads.narHash} || ${narObjectKeySuffix}`
					)
				)
			)
			.orderBy(asc(schema.pendingUploads.id))
			.limit(limit)
			.all();

		this.leaseRows(
			pendings.map((pending) => pending.id),
			now
		);

		let settled = 0;

		for (const pending of pendings) {
			try {
				await this.recordVerification(pending.id, { ok: true }, 'promote');
				settled += 1;
			} catch (error) {
				if (error instanceof UploadedObjectNotFoundError) {
					// The canonical object is gone and cannot reappear: answer the
					// waiter terminally instead of retrying the same vanished object
					// every firing.
					await this.recordMissingObject(pending.id);
					settled += 1;
					continue;
				}

				// A transient fault: free the lease and leave the row for the next
				// pass without starving the rest.
				this.releaseLease(pending.id);
				console.warn('reuse settle failed', {
					uploadId: pending.id,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}

		return settled;
	}

	// Commits a deferred upload the queue consumer has already verified off the DO
	// thread, running the same reserve→promote→materialise path the on-DO pass uses
	// with the verdict passed in. A vanished row or a lost race is handled
	// idempotently, so a re-driven verify (the consumer may run a row twice) is
	// safe.
	async recordVerification(
		uploadId: string,
		verification: NarVerification,
		promotion: PromotionState = 'promote'
	): Promise<void> {
		const pending = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined || !isAwaitingVerdict(pending)) {
			return;
		}

		const metadata = parseStoredUploadPathMetadata(
			pending.id,
			pending.metadataJson
		);
		const generation = await this.reservePendingRow(pending, metadata);

		if (generation === undefined) {
			return;
		}

		await this.commitVerified(
			pending,
			metadata,
			generation,
			verification,
			promotion
		);
	}

	// Settles a batch of verdicts the queue consumer decoded off the DO thread in
	// one RPC, so a pass over many deferred uploads costs a single round trip into
	// the DO rather than one per upload. The verdicts apply one at a time, each
	// through the same idempotent reserve→commit path, so two never interleave their
	// critical sections. One verdict's apply failing (a transient promote or commit
	// fault) must not abort the rest of the batch or fail the queue message: its row
	// is left for the next pass, the same fault isolation the per-upload RPCs had.
	// Returns how many verdicts actually applied, so the caller continues the drain
	// only on real progress rather than on a mere decode, and a batch whose every
	// apply fails backs off to the cron instead of spinning.
	async recordVerifications(
		results: readonly VerificationResult[]
	): Promise<number> {
		let applied = 0;

		for (const { uploadId, verdict } of results) {
			try {
				if (verdict.kind === 'abandoned') {
					// The consumer gave the claim up unsettled (a transient fault);
					// free the lease so the next pass retries promptly. Not progress,
					// so it does not count towards the continuation gate.
					this.releaseLease(uploadId);
					continue;
				}

				if (verdict.kind === 'missing') {
					await this.recordMissingObject(uploadId);
				} else if (verdict.kind === 'promoted') {
					await this.recordVerification(
						uploadId,
						{ ok: true },
						'already-promoted'
					);
				} else {
					await this.recordVerification(uploadId, verdict.verification);
				}

				applied += 1;
			} catch (error) {
				console.warn('verification verdict not recorded', {
					uploadId,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}

		return applied;
	}

	// Records the terminal outcome for a deferred upload whose bytes the queue
	// consumer found definitively gone, so its waiters are answered rather than
	// left parked until the commit timeout. A fresh row's staging object cannot
	// reappear, so it fails as `mismatch`. A reuse row's bytes are the shared
	// canonical object, whose disappearance says nothing against the client's
	// upload: the row is dropped and its waiters told `absent`, the answer that
	// re-drives the push through a fresh negotiate and upload.
	async recordMissingObject(uploadId: string): Promise<void> {
		const pending = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined || !isAwaitingVerdict(pending)) {
			return;
		}

		const metadata = parseStoredUploadPathMetadata(
			pending.id,
			pending.metadataJson
		);

		if (pending.r2Key === narObjectKey(metadata.narHash)) {
			await this.uploadState.clearPendingUploadAndStaging(
				pending.id,
				pending.r2Key,
				metadata.narHash
			);
			this.notifyWaiters(pending.id, pending.sessionId, 'absent');
			return;
		}

		await this.uploadState.markUploadTerminal(
			pending.id,
			pending.r2Key,
			metadata.narHash,
			'mismatch'
		);
		this.notifyWaiters(pending.id, pending.sessionId, 'mismatch');
	}
}
