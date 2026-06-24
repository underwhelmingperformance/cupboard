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
import { sendCommitFrame } from './commit-socket.ts';
import { type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { parseStoredUploadMetadata } from './upload-metadata.ts';
import { type UploadStateService } from './upload-state-service.ts';

export class VerificationService {
	constructor(
		private readonly context: ServerContext,
		private readonly commitPipeline: CommitPipelineService,
		private readonly deletionQueue: DeletionQueueService,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly uploadState: UploadStateService
	) {}

	// Settles every commit socket parked for an upload with its terminal
	// verdict. Hibernation tags key the lookup, so waiters survive the object
	// being evicted between the deferral and this pass.
	private notifyWaiters(
		uploadId: string,
		status: ParsedUploadStatusResponse['status']
	): void {
		for (const socket of this.context.ctx.getWebSockets(uploadId)) {
			sendCommitFrame(socket, { event: 'verdict', status });
			socket.close(1000, status);
		}
	}

	private async verifyAndCommitPending(
		pending: typeof schema.pendingUploads.$inferSelect
	): Promise<void> {
		const metadata = parseStoredUploadMetadata(
			pending.id,
			pending.metadataJson
		);

		// Reserve the row before verifying: a fresh deferred upload gets its first
		// row, a crashed or re-driven commit finds its own (`mine`). A different
		// version holding the path (`lost`) means this upload can never own it — drop
		// it and reclaim its staging bytes.
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
			this.notifyWaiters(pending.id, 'absent');
			return;
		}

		const { generation } = reserved;

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
				await this.failReservedUpload(pending, metadata, generation);
				return;
			}

			throw error;
		}

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
			this.notifyWaiters(pending.id, 'servable');
			this.uploadState.clearPendingUpload(pending.id);
			await this.context.env.BLOBS.delete(pending.r2Key);
			return;
		}

		// A concurrent recommit took the path or the blob vanished, so this upload
		// lost: clear its marker. Any blob it promoted that no edge now references is
		// left for the reaper to collect.
		this.uploadState.clearPendingUpload(pending.id);
		await this.context.env.BLOBS.delete(pending.r2Key);
		this.notifyWaiters(pending.id, 'absent');
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
		this.notifyWaiters(pending.id, verdict);
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
		const tenant = this.context.requireTenant();
		const observations = await Promise.all(
			rows.map(async (row) => {
				try {
					const isNarPresent =
						(await this.context.env.BLOBS.head(narObjectKey(row.narHash))) !==
						null;
					const isObjectPresent =
						isNarPresent &&
						(await this.context.env.BLOBS.head(
							narInfoObjectKey(tenant, row.storePathHash, row.cache)
						)) !== null;

					return {
						row,
						narPresent: isNarPresent,
						objectPresent: isObjectPresent
					};
				} catch (error) {
					this.warnSkippedRow(row, error);

					return;
				}
			})
		);

		// Apply the reconciles and advance the cursor in one short critical section.
		// The generation re-check rejects any row a commit or delete changed during
		// the probe, so a reconcile never acts on stale state. What remains inside
		// the gate is fast synchronous SQLite plus the rare write for an unhealthy
		// row, instead of every row's R2 round-trips.
		return this.context.ctx.blockConcurrencyWhile(async () => {
			let narInfoObjectsRestored = 0;
			let danglingNarInfosRemoved = 0;

			for (const observation of observations) {
				if (observation === undefined) {
					continue;
				}

				const {
					row,
					narPresent: isNarPresent,
					objectPresent: isObjectPresent
				} = observation;
				const current = this.context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, row.cache),
							eq(schema.narInfos.storePathHash, row.storePathHash)
						)
					)
					.get();

				// A NAR only reappears through a commit, which bumps the generation, so
				// a generation match means the probe still holds for this row.
				if (current?.generation !== row.generation) {
					continue;
				}

				try {
					if (!isNarPresent) {
						await this.deletionQueue.reconcileMissingNar(current, origin);
						danglingNarInfosRemoved += 1;
					} else if (!isObjectPresent) {
						narInfoObjectsRestored += await this.restoreNarInfoObject(current);
					}
				} catch (error) {
					this.warnSkippedRow(row, error);
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
}
