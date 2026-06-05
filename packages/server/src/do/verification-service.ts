import { type VerifyReport } from '@cupboard/protocol/reports';
import { type UploadPathMetadataFields } from '@cupboard/protocol/upload';
import { and, asc, eq, gt, or } from 'drizzle-orm';
import { z } from 'zod';

import { type NarVerification } from '../blob/nar-verify.ts';
import * as schema from '../db/schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import {
	internalOrigin,
	narInfoObjectKey,
	narObjectKey,
	verificationBatchSize
} from '../http/http.ts';
import { parseRequestValue } from '../http/parse.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import { type CommitPipelineService } from './commit-pipeline-service.ts';
import { parseStoredUploadMetadata, type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type UploadStateService } from './upload-state-service.ts';

// An optional `?limit` on `POST /verify`: a positive integer, clamped to
// `verificationBatchSize` so a manual run cannot scan an unbounded batch in one
// critical section.
const verificationLimitSchema = z.coerce.number().int().min(1);

export class VerificationService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService,
		private readonly commitPipeline: CommitPipelineService,
		private readonly deletionQueue: DeletionQueueService,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly uploadState: UploadStateService
	) {}

	async handleVerify(request: Request): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		// Interactive verify purges this colo's edge cache via the caller's public
		// origin; the cron sweep arrives on the internal origin, cannot know the
		// public URL, and relies on the narinfo TTL and the orphan-blob grace
		// window instead, exactly as GC does.
		const url = new URL(request.url);
		const purgeOrigin = url.origin === internalOrigin ? undefined : url.origin;
		const requested = url.searchParams.get('limit');
		const limit =
			requested === null
				? verificationBatchSize
				: Math.min(
						parseRequestValue(verificationLimitSchema, requested),
						verificationBatchSize
					);

		await this.verifyPendingUploads(limit);

		return Response.json(await this.verifyBatch(purgeOrigin, limit));
	}

	verifyBatch(
		origin: string | undefined,
		limit: number
	): Promise<VerifyReport> {
		// The whole batch runs in one critical section: the cursor read, the
		// per-row re-materialise/reconcile, and the cursor advance must not
		// interleave with a commit or a delete.
		return this.context.ctx.blockConcurrencyWhile(async () => {
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
			const rows = this.context.db
				.select()
				.from(schema.narInfos)
				.where(
					or(
						gt(schema.narInfos.cache, fromCache),
						and(
							eq(schema.narInfos.cache, fromCache),
							gt(schema.narInfos.storePathHash, fromHash)
						)
					)
				)
				.orderBy(asc(schema.narInfos.cache), asc(schema.narInfos.storePathHash))
				.limit(limit)
				.all();

			let narInfoObjectsRestored = 0;
			let danglingNarInfosRemoved = 0;

			for (const row of rows) {
				const narPresent =
					(await this.context.env.BLOBS.head(narObjectKey(row.narHash))) !==
					null;

				if (!narPresent) {
					await this.deletionQueue.reconcileMissingNar(row, origin);
					danglingNarInfosRemoved += 1;
					continue;
				}

				const narInfoObject = await this.context.env.BLOBS.head(
					narInfoObjectKey(
						this.context.requireTenant(),
						row.storePathHash,
						row.cache
					)
				);

				if (narInfoObject === null) {
					const narInfo = await this.narInfoObjects.narInfoFromRow(row);

					if (narInfo !== undefined) {
						await this.narInfoObjects.putNarInfoObject(
							row.cache,
							row.storePathHash,
							narInfo
						);
						narInfoObjectsRestored += 1;
					}
				}
			}

			// A short batch means the scan reached the end; clear the cursor so the
			// next pass starts again from the first cache's lowest hash.
			const wrapped = rows.length < limit;
			const last = rows.at(-1);
			const nextCache = wrapped || last === undefined ? '' : last.cache;
			const nextHash = wrapped || last === undefined ? '' : last.storePathHash;
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
				wrapped
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
				generation,
				pending.id
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

		// A concurrent recommit took the path or the blob vanished, so this upload
		// lost: clear its marker. Any blob it promoted that no edge now references is
		// left for the reaper to collect.
		if (outcome !== 'materialised') {
			this.uploadState.clearPendingUpload(pending.id);
		}

		await this.context.env.BLOBS.delete(pending.r2Key);
	}

	// Reclaims the reserved row a deferred upload never made servable and records its
	// terminal verdict, so neither a stranded row nor a stuck marker survives. The
	// verdict is `mismatch` for a failed NAR-hash check or `over-quota` for a quota
	// rejection.
	private async failReservedUpload(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: UploadPathMetadataFields,
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
		await this.uploadState.markUploadFailed(
			pending.id,
			pending.r2Key,
			metadata.narHash,
			verdict
		);
	}
}
