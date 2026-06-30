import {
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { type VerifyReport } from '@cupboard/protocol/reports';
import {
	type ParsedUploadPathMetadata,
	type ParsedUploadStatusResponse
} from '@cupboard/protocol/upload';
import { and, asc, eq, gt, or, sql } from 'drizzle-orm';

import { type NarVerification } from '../blob/nar-verify.ts';
import * as schema from '../db/schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';

import { type CommitPipelineService } from './commit-pipeline-service.ts';
import { sendCommitSessionFrame } from './commit-socket.ts';
import { type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type ReconcileTarget } from './reconcile-queue-service.ts';
import { parseStoredUploadMetadata } from './upload-metadata.ts';
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

// The verdict the queue consumer reached for one claimed upload off the DO
// thread: the decoded NAR verification, or that its staging object was
// definitively gone.
export type VerificationVerdict =
	| { readonly kind: 'verified'; readonly verification: NarVerification }
	| { readonly kind: 'missing' };

// One upload's verdict, carried back to the DO so a whole batch settles in a
// single RPC rather than one round trip per upload.
export interface VerificationResult {
	readonly uploadId: string;
	readonly verdict: VerificationVerdict;
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
		const metadata = parseStoredUploadMetadata(
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

		await this.commitVerified(pending, metadata, reserved, verification);
	}

	// Reserves the narinfo row before committing a verified upload: a fresh deferred
	// upload gets its first row, a crashed or re-driven commit finds its own
	// (`mine`). A different version holding the path (`lost`) means this upload can
	// never own it, so its row and staging bytes are dropped and waiters told
	// `absent`; the caller stops. Returns the reserved generation, or undefined when
	// the path was lost.
	private async reservePendingRow(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathMetadata
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
		metadata: ParsedUploadPathMetadata,
		generation: number,
		verification: NarVerification
	): Promise<void> {
		if (!verification.ok) {
			await this.failReservedUpload(pending, metadata, generation);
			return;
		}

		// Promote outside the critical section: streaming the staging bytes into the
		// shared CAS must not run under `blockConcurrencyWhile`. It is idempotent and
		// content-addressed, so a redundant promotion is harmless.
		await this.uploadState.promoteStagingBlob(pending.r2Key, metadata);

		const outcome = await this.context.ctx.blockConcurrencyWhile(async () => {
			const current = this.context.db
				.select()
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, pending.id))
				.get();

			if (current === undefined) {
				return 'gone' as const;
			}

			return this.commitPipeline.materialiseServable(
				pending.cache,
				metadata,
				generation
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

		if (outcome === 'materialised') {
			// The parked sockets carry the verdict, and the narinfo itself is the
			// durable evidence of success, so a settled upload leaves no residue:
			// the row clears and the staging bytes go.
			this.notifyWaiters(pending.id, pending.sessionId, 'servable');
			this.uploadState.clearPendingUpload(pending.id);
			await this.context.env.BLOBS.delete(pending.r2Key);
			return;
		}

		// A concurrent recommit took the path or the blob vanished, so this upload
		// lost: clear its marker. Any blob it promoted that no edge now references is
		// left for the reaper to collect.
		this.uploadState.clearPendingUpload(pending.id);
		await this.context.env.BLOBS.delete(pending.r2Key);
		this.notifyWaiters(pending.id, pending.sessionId, 'absent');
	}

	// Reclaims the reserved row a deferred upload never made servable and records its
	// terminal verdict, so neither a stranded row nor a stuck marker survives. The
	// verdict is `mismatch` for a failed NAR-hash check or `over-quota` for a quota
	// rejection.
	private async failReservedUpload(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathMetadata,
		generation: number,
		verdict: 'mismatch' | 'over-quota' = 'mismatch'
	): Promise<void> {
		await this.context.ctx.blockConcurrencyWhile(() =>
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

		await this.context.ctx.blockConcurrencyWhile(async () => {
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
		return this.context.ctx.blockConcurrencyWhile(async () => {
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
		// idempotent reserve→verify→promote→materialise path.
		const pendings = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(
				or(
					eq(schema.pendingUploads.verdict, 'pending'),
					eq(schema.pendingUploads.verdict, 'committing')
				)
			)
			.orderBy(asc(schema.pendingUploads.id))
			.limit(limit)
			.all();

		for (const pending of pendings) {
			try {
				await this.verifyAndCommitPending(pending);
			} catch {
				// One upload's failure (a transient promote or commit error) must not
				// starve the rest of the pass; leave its marker for the next pass.
				continue;
			}
		}
	}

	// Lists deferred uploads for the queue consumer to verify off the DO thread,
	// the read-only first half of the prompt verify path. The consumer fetches and
	// decodes each staging object, then calls `recordVerification`. A reuse row is
	// flagged so the consumer skips its decode.
	listPendingForVerify(limit: number): PendingVerification[] {
		const pendings = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(
				or(
					eq(schema.pendingUploads.verdict, 'pending'),
					eq(schema.pendingUploads.verdict, 'committing')
				)
			)
			.orderBy(asc(schema.pendingUploads.id))
			.limit(limit)
			.all();

		return pendings.map((pending) => {
			const metadata = parseStoredUploadMetadata(
				pending.id,
				pending.metadataJson
			);

			return {
				uploadId: pending.id,
				r2Key: pending.r2Key,
				narHash: metadata.narHash,
				narSize: metadata.narSize,
				reuse: pending.r2Key === narObjectKey(metadata.narHash)
			};
		});
	}

	// Commits a deferred upload the queue consumer has already verified off the DO
	// thread, running the same reserve→promote→materialise path the on-DO pass uses
	// with the verdict passed in. A vanished row or a lost race is handled
	// idempotently, so a re-driven verify (the consumer may run a row twice) is
	// safe.
	async recordVerification(
		uploadId: string,
		verification: NarVerification
	): Promise<void> {
		const pending = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined) {
			return;
		}

		const metadata = parseStoredUploadMetadata(
			pending.id,
			pending.metadataJson
		);
		const generation = await this.reservePendingRow(pending, metadata);

		if (generation === undefined) {
			return;
		}

		await this.commitVerified(pending, metadata, generation, verification);
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
				if (verdict.kind === 'missing') {
					await this.recordMissingObject(uploadId);
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

	// Records a terminal `mismatch` for a deferred upload whose staging object the
	// queue consumer found definitively gone, so its waiters are answered rather
	// than left parked until the commit timeout.
	async recordMissingObject(uploadId: string): Promise<void> {
		const pending = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined) {
			return;
		}

		const metadata = parseStoredUploadMetadata(
			pending.id,
			pending.metadataJson
		);

		await this.uploadState.markUploadTerminal(
			pending.id,
			pending.r2Key,
			metadata.narHash,
			'mismatch'
		);
		this.notifyWaiters(pending.id, pending.sessionId, 'mismatch');
	}
}
