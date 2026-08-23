import { type Logger } from '@cupboard/logger';
import {
	type NarInfoGeneration,
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { type VerifyReport } from '@cupboard/protocol/reports';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type ParsedUploadGraceFact,
	type ParsedUploadPathNegotiation,
	type ParsedUploadStatusResponse,
	type SessionId,
	type UploadId
} from '@cupboard/protocol/upload';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import { type NarVerification } from '../blob/nar-verify.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import {
	narInfoObjectKey,
	narInfoObjectPrefix,
	narObjectKey,
	narObjectKeyPrefix,
	narObjectKeySuffix,
	type R2ObjectKey,
	type RequestOrigin,
	verifyClaimLeaseMs
} from '../http/http.ts';

import {
	batchNonEmpty,
	chunk,
	maxInClauseValues,
	maxOutgoingConnections
} from './bulk.ts';
import {
	type CommitPipelineService,
	type PrefetchedMaterialisationFacts
} from './commit-pipeline-service.ts';
import { sendCommitSessionFrame } from './commit-socket.ts';
import { type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import {
	confirmGrace,
	parseStoredGraceDecision,
	storedGraceFact
} from './grace-decision.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type ReconcileTarget } from './reconcile-queue-service.ts';
import { type RetentionService } from './retention-service.ts';
import { parseStoredUploadPathMetadata } from './upload-metadata.ts';
import { type UploadStateService } from './upload-state-service.ts';

type NarInfoRow = typeof schema.narInfos.$inferSelect;

function edgeKey(
	cache: StoredCache,
	storePathHash: string,
	generation: NarInfoGeneration,
	narHash: string
): string {
	return `${cache}\0${storePathHash}\0${String(generation)}\0${narHash}`;
}

function reconcileCandidates(
	observations: readonly (RowObservation | undefined)[]
): NarInfoRow[] {
	return observations
		.filter(
			(observation): observation is RowObservation =>
				observation !== undefined &&
				(!observation.isNarPresent || !observation.objectPresent)
		)
		.map((observation) => observation.row);
}

interface RowObservation {
	readonly row: NarInfoRow;
	readonly isNarPresent: boolean;
	readonly objectPresent: boolean;
}

type ReconcileOutcome = 'removed' | 'restored' | 'unchanged';

/**
 * The consumer must fetch and verify `r2Key` unless `reuse` is true. A reuse
 * claim refers to canonical bytes that were verified when they were promoted,
 * so the consumer must not decode them again.
 */
export interface PendingVerification {
	readonly uploadId: UploadId;
	readonly r2Key: R2ObjectKey;
	readonly narHash: NixSha256HashString;
	readonly narSize: number;
	readonly reuse: boolean;
}

// `truncated` means that claimable rows remain. The consumer requests a
// continuation only after the current pass records progress.
export interface PendingVerificationBatch {
	readonly claims: readonly PendingVerification[];
	readonly truncated: boolean;
}

// `missing` is reserved for an object known not to exist. `abandoned` reports a
// transient fault and releases the lease without recording a terminal result.
// `promoted` means that the canonical object and its `blob_state` row are
// already durable, so the Durable Object must not promote the bytes again.
export type VerificationVerdict =
	| { readonly kind: 'verified'; readonly verification: NarVerification }
	| { readonly kind: 'promoted' }
	| { readonly kind: 'missing' }
	| { readonly kind: 'abandoned' };

export type PromotionState = 'promote' | 'already-promoted';

export interface VerificationResult {
	readonly uploadId: UploadId;
	readonly verdict: VerificationVerdict;
}

interface PreparedSettle {
	readonly pending: typeof schema.pendingUploads.$inferSelect;
	readonly metadata: ParsedUploadPathNegotiation;
	readonly generation: NarInfoGeneration;
}

// Terminal rows remain authoritative during their observation window. Verify
// passes can overlap, so a straggling verdict must not reopen a settled row.
function isAwaitingVerdict(
	row: typeof schema.pendingUploads.$inferSelect
): boolean {
	return row.verdict === 'pending' || row.verdict === 'committing';
}

// A lease older than `verifyClaimLeaseMs` belongs to a pass presumed dead, so
// another pass can claim the row again.
function claimableFilter(now: Date) {
	const leasedBefore = isoTimestamp(
		new Date(now.getTime() - verifyClaimLeaseMs)
	);

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

// Claims form a contiguous prefix in id order, subject to the row limit and the
// cumulative uncompressed size of fresh rows. Reuse rows cost no decode bytes.
// Always admit the first fresh row so a lone NAR above `maxNarBytes` cannot
// starve. `truncated` records that claimable rows remain.
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

		if (hasFresh && cost > 0 && bytes + cost > maxNarBytes) {
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
		private readonly uploadState: UploadStateService,
		private readonly retention: RetentionService,
		// A failed verification must remove the path from every retention root. A
		// root can include the path while its bytes are still being verified.
		private readonly pruneRetentionTargets: (
			cache: StoredCache,
			storePathHash: StorePathHash
		) => void
	) {}

	// Re-read the session after the settle's awaits because `attachSession` can
	// move the waiter to a reconnected socket. If the row has already cleared,
	// there is no newer session to use in place of the captured id.
	private currentSessionId(
		uploadId: UploadId,
		captured: SessionId | null
	): SessionId | null {
		const row = this.context.db
			.select({ sessionId: schema.pendingUploads.sessionId })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		return row === undefined ? captured : row.sessionId;
	}

	private notifyWaiters(
		pending: typeof schema.pendingUploads.$inferSelect,
		status: ParsedUploadStatusResponse['status']
	): void {
		const sessionId = this.currentSessionId(pending.id, pending.sessionId);

		if (sessionId === null) {
			return;
		}

		// The grace fact is sent only for an upload that accepted grace facts,
		// keeping a legacy upload's frames on the legacy shape.
		const graceDecision = parseStoredGraceDecision(pending.graceDecisionJson);
		const grace =
			graceDecision?.reportsGrace === true
				? status === 'servable'
					? this.servableGraceFact(pending)
					: {}
				: undefined;

		for (const socket of this.context.ctx.getWebSockets(sessionId)) {
			sendCommitSessionFrame(socket, {
				ev: 'verdict',
				uploadId: pending.id,
				status,
				...(grace !== undefined && { grace })
			});
		}
	}

	// Read grace at notification time so a replayed verdict reports the current
	// deadline.
	private servableGraceFact(
		pending: typeof schema.pendingUploads.$inferSelect
	): ParsedUploadGraceFact {
		const metadata = parseStoredUploadPathMetadata(
			pending.id,
			pending.metadataJson
		);

		return storedGraceFact(
			this.context.db,
			pending.cache,
			metadata.storePathHash
		);
	}

	private async prepareAndPromote(
		pending: typeof schema.pendingUploads.$inferSelect
	): Promise<PreparedSettle | undefined> {
		const metadata = parseStoredUploadPathMetadata(
			pending.id,
			pending.metadataJson
		);

		const reserved = await this.reservePendingRow(pending, metadata);

		if (reserved === undefined) {
			return undefined;
		}

		if (await this.finaliseIfAlreadyCommitted(pending, metadata, reserved)) {
			return undefined;
		}

		// A content mismatch and a missing staging object are terminal. Other read
		// failures leave the row and its staged bytes for another pass. Never use an
		// existing `blob_state` row to accept fresh bytes that have not been verified.
		let verification: NarVerification;

		try {
			verification = await this.commitPipeline.verifyPendingNar(
				pending.r2Key,
				metadata
			);
		} catch (error) {
			if (error instanceof UploadedObjectNotFoundError) {
				await this.failReservedUpload(pending, metadata, reserved);
				return undefined;
			}

			throw error;
		}

		const wasPromoted = await this.promoteForCommit(
			pending,
			metadata,
			reserved,
			verification,
			'promote'
		);

		if (!wasPromoted) {
			return undefined;
		}

		return { pending, metadata, generation: reserved };
	}

	private async prepareRecordedVerdict(
		uploadId: UploadId,
		verification: NarVerification,
		promotion: PromotionState
	): Promise<PreparedSettle | undefined> {
		const pending = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined || !isAwaitingVerdict(pending)) {
			return undefined;
		}

		const metadata = parseStoredUploadPathMetadata(
			pending.id,
			pending.metadataJson
		);
		const generation = await this.reservePendingRow(pending, metadata);

		if (generation === undefined) {
			return undefined;
		}

		if (await this.finaliseIfAlreadyCommitted(pending, metadata, generation)) {
			return undefined;
		}

		const wasPromoted = await this.promoteForCommit(
			pending,
			metadata,
			generation,
			verification,
			promotion
		);

		if (!wasPromoted) {
			return undefined;
		}

		return { pending, metadata, generation };
	}

	private async reservePendingRow(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation
	): Promise<NarInfoGeneration | undefined> {
		const reserved = await this.commitPipeline.reserveNarInfoRow(
			pending.cache,
			metadata
		);

		if (reserved.kind === 'lost') {
			this.notifyWaiters(pending, 'absent');
			await this.uploadState.clearPendingUploadAndStaging(
				pending.id,
				pending.r2Key,
				metadata.narHash
			);
			return undefined;
		}

		return reserved.generation;
	}

	// A crash can leave a committed generation and its pending marker after the
	// private staging bytes have been deleted. Re-decoding that row would turn a
	// successful upload into a mismatch, so finish the remaining bookkeeping from
	// the committed reference and narinfo object.
	private async finaliseIfAlreadyCommitted(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration
	): Promise<boolean> {
		const isCommitted = await this.commitPipeline.isGenerationCommitted(
			pending.cache,
			metadata,
			generation
		);

		if (!isCommitted) {
			return false;
		}

		// The flush applies captured grace only after the durable charge, so an
		// interruption between the two leaves a committed generation while the
		// decision remains on the pending row. Reapply it before the waiters
		// hear the verdict and before the row holding it is cleared; the
		// application is identity-checked and monotonic, so re-running an
		// already-applied decision changes nothing.
		const graceDecision = parseStoredGraceDecision(pending.graceDecisionJson);
		const confirmed = confirmGrace(
			this.context,
			this.retention,
			pending.cache,
			metadata.storePathHash,
			generation,
			metadata.narHash,
			graceDecision?.graceSeconds
		);

		// The row moved during the committed-edge check, so the conclusion is
		// stale. Settling on it would report the wrong row and drop the grant. Let
		// the ordinary saga verify the current row under its authoritative charge
		// fence.
		if (!confirmed.matched) {
			return false;
		}

		// Attach the run root while the confirmation's identity proof still applies.
		// The uninterrupted flush uses the same fence.
		this.commitPipeline.attachRootTarget(
			pending.cache,
			pending.attachRootName,
			metadata.storePathHash,
			metadata.storePath
		);

		this.notifyWaiters(pending, 'servable');
		this.uploadState.clearPendingUpload(pending.id);
		await this.deleteStagingObject(pending);

		return true;
	}

	private async promoteForCommit(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration,
		verification: NarVerification,
		promotion: PromotionState
	): Promise<boolean> {
		if (!verification.ok) {
			await this.failReservedUpload(pending, metadata, generation);
			return false;
		}

		// Streaming the staging bytes must remain outside
		// `blockConcurrencyWhile`. Promotion is content-addressed and idempotent.
		// Skip it when the queue consumer has already made both the canonical object
		// and its `blob_state` row durable.
		if (promotion === 'promote') {
			const blob =
				verification.fileHash !== undefined &&
				verification.fileSize !== undefined
					? { fileHash: verification.fileHash, fileSize: verification.fileSize }
					: undefined;
			await this.uploadState.promoteStagingBlob(pending.r2Key, metadata, blob);
		}

		return true;
	}

	// A failed batch prefetch must fall back to per-path probes. One transient D1
	// fault must not abort the verification pass.
	private async prefetchedFactsFor(
		logger: Logger,
		ready: readonly PreparedSettle[]
	): Promise<
		Map<NixSha256HashString, PrefetchedMaterialisationFacts> | undefined
	> {
		try {
			return await this.commitPipeline.prefetchMaterialisationFacts(
				ready.map((item) => item.metadata.narHash)
			);
		} catch (error) {
			logger.warn(
				'prefetch materialisation facts failed; falling back to per-path probes',
				{ error }
			);
			return undefined;
		}
	}

	private async materialiseVerified(
		logger: Logger,
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration,
		prefetched?: PrefetchedMaterialisationFacts
	): Promise<void> {
		// Probe only after promotion has created the canonical object and its
		// `blob_state` row. An earlier probe would report both as absent.
		const probe = await this.commitPipeline.probeMaterialisation(
			metadata,
			prefetched
		);
		const graceDecision = parseStoredGraceDecision(pending.graceDecisionJson);

		let outcome = await this.commitPipeline.materialiseBatched(logger, {
			cache: pending.cache,
			metadata,
			generation,
			probe,
			graceDecision,
			attachRootName: pending.attachRootName ?? undefined,
			// Verification has already established the bytes, either through a fresh
			// decode or through reuse while the presence edge existed. Do not require
			// tenant ownership here: a tenant does not yet own a hash on its first
			// commit.
			mustOwnBlob: false,
			// Another pass settled a missing or terminal row while this pass awaited
			// promotion and probing. Do not modify that row. This check runs inside
			// the flush gate, so a competing settle cannot interleave between the
			// check and the charge.
			isStillSettleable: () => {
				const current = this.context.db
					.select()
					.from(schema.pendingUploads)
					.where(eq(schema.pendingUploads.id, pending.id))
					.get();

				return current !== undefined && isAwaitingVerdict(current);
			}
		});

		if (outcome.kind === 'gone') {
			return;
		}

		// Over quota on the canonical size: if the probe came from a prefetch batch,
		// its `isOwned` flag may be stale (a sibling settled first and charged the
		// blob, so the tenant already owns it). Re-probe once with a fresh read and
		// retry; only a second over-quota result is terminal. The reserve and charge
		// guards are idempotent, so one retry is safe.
		if (prefetched !== undefined && outcome.kind === 'over-quota') {
			const freshProbe =
				await this.commitPipeline.probeMaterialisation(metadata);
			const retried = await this.commitPipeline.materialiseBatched(logger, {
				cache: pending.cache,
				metadata,
				generation,
				probe: freshProbe,
				mustOwnBlob: false,
				graceDecision,
				attachRootName: pending.attachRootName ?? undefined,
				isStillSettleable: () => {
					const current = this.context.db
						.select()
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.id, pending.id))
						.get();

					return current !== undefined && isAwaitingVerdict(current);
				}
			});

			if (retried.kind === 'gone') {
				return;
			}

			outcome = retried;
		}

		if (outcome.kind === 'over-quota') {
			// Without reclaiming this reserved row, a later scan could restore its
			// object and make an unreferenced, uncharged path servable.
			await this.failReservedUpload(
				pending,
				metadata,
				generation,
				'over-quota'
			);
			return;
		}

		// Publishing can stop after reservation and before the charge fence. Reclaim
		// the row so a later scan cannot restore an unreferenced, uncharged path.
		if (outcome.kind === 'tenant-inactive') {
			// The grace confirmation runs inside the same gated callback as the
			// identity proof: the input gate reopens the moment that callback
			// completes, so a confirmation outside it could race a delete or
			// recommit queued behind the gate.
			const reclaim = await this.context.criticalSection(async () => {
				const result = await this.commitPipeline.reclaimReservedRow(
					pending.cache,
					metadata.storePathHash,
					generation,
					metadata.narHash
				);

				// This upload's captured grace decision has not been applied. Apply it
				// to the winning generation before notifying, and attach the run root
				// under the same identity proof.
				if (result === 'committed-current') {
					this.commitPipeline.attachRootTarget(
						pending.cache,
						pending.attachRootName,
						metadata.storePathHash,
						metadata.storePath
					);
					confirmGrace(
						this.context,
						this.retention,
						pending.cache,
						metadata.storePathHash,
						generation,
						metadata.narHash,
						graceDecision?.graceSeconds
					);
				}

				return result;
			});

			if (reclaim === 'committed-current') {
				this.notifyWaiters(pending, 'servable');
				this.uploadState.clearPendingUpload(pending.id);
				return;
			}

			this.notifyWaiters(pending, 'absent');
			await this.uploadState.clearPendingUploadAndStaging(
				pending.id,
				pending.r2Key,
				metadata.narHash
			);

			// A superseded row belongs to a replacement that still holds the
			// path, so its retention targets must survive; only a genuinely
			// reclaimed path releases them.
			if (reclaim === 'reclaimed') {
				this.pruneRetentionTargets(pending.cache, metadata.storePathHash);
			}

			return;
		}

		if (outcome.kind === 'materialised') {
			// Wait for the narinfo object to publish before notifying waiters or
			// clearing the marker. A failure before publication must leave the upload
			// available for another pass.
			await this.narInfoObjects.publishNarInfoObject(
				pending.cache,
				metadata.storePathHash,
				generation,
				metadata.narHash,
				outcome.narInfo
			);

			this.notifyWaiters(pending, 'servable');
			this.uploadState.clearPendingUpload(pending.id);
			await this.deleteStagingObject(pending);
			return;
		}

		// A concurrent recommit took the path or the blob vanished, so clear this
		// upload's marker. If no edge references a blob that this pass promoted,
		// leave the blob for the reaper.
		this.notifyWaiters(pending, 'absent');
		this.uploadState.clearPendingUpload(pending.id);
		await this.deleteStagingObject(pending);
	}

	// Never delete a reuse row's shared canonical object. Other paths can refer to
	// it, and the blob reaper owns its lifetime.
	private async deleteStagingObject(
		pending: typeof schema.pendingUploads.$inferSelect
	): Promise<void> {
		if (pending.r2Key === narObjectKey(pending.narHash)) {
			return;
		}

		await this.context.env.BLOBS.delete(pending.r2Key);
	}

	// A straggling failure verdict must not retire a generation that another pass
	// has already committed. Its edge proves that the path is servable, so leave
	// the row, root and waiter for the committing pass to update.
	private async failReservedUpload(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration,
		verdict: 'mismatch' | 'over-quota' = 'mismatch'
	): Promise<void> {
		const reclaim = await this.context.criticalSection(() =>
			this.commitPipeline.reclaimReservedRow(
				pending.cache,
				metadata.storePathHash,
				generation,
				metadata.narHash
			)
		);

		if (reclaim === 'committed-current') {
			return;
		}

		await this.uploadState.markUploadTerminal(
			pending.id,
			pending.r2Key,
			metadata.narHash,
			verdict
		);

		// A superseded row belongs to a replacement that still holds the path,
		// so its retention targets must survive; only a genuinely reclaimed
		// path releases them.
		if (reclaim === 'reclaimed') {
			this.pruneRetentionTargets(pending.cache, metadata.storePathHash);
		}

		this.notifyWaiters(pending, verdict);
	}

	// Re-check the NAR under the caller's critical section before restoring the
	// narinfo object. A delete can otherwise remove the NAR after the probe and
	// leave the restored narinfo pointing at a missing NAR.
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
			{
				generation: row.generation,
				narHash: row.narHash,
				signatureGeneration:
					row.pendingSignatureGeneration ?? row.signatureGeneration
			},
			narInfo
		);

		return 1;
	}

	private warnSkippedRow(
		logger: Logger,
		row: typeof schema.narInfos.$inferSelect,
		error: unknown
	): void {
		logger.warn('narinfo row not reconciled', {
			cache: row.cache,
			storePathHash: row.storePathHash,
			error
		});
	}

	private narInfoRow(
		cache: StoredCache,
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

	private async probeRow(
		logger: Logger,
		row: NarInfoRow,
		isObjectPresent: (row: NarInfoRow) => Promise<boolean>
	): Promise<RowObservation | undefined> {
		try {
			const isNarPresent =
				(await this.context.env.BLOBS.head(narObjectKey(row.narHash))) !== null;

			return {
				row,
				isNarPresent: isNarPresent,
				objectPresent: isNarPresent && (await isObjectPresent(row))
			};
		} catch (error) {
			this.warnSkippedRow(logger, row, error);

			return undefined;
		}
	}

	private async headNarInfoObject(row: NarInfoRow): Promise<boolean> {
		const key = narInfoObjectKey(
			this.context.requireTenant(),
			row.storePathHash,
			row.cache
		);

		return (await this.context.env.BLOBS.head(key)) !== null;
	}

	// Bound the R2 listing by the batch's last key, not by its row count. An orphan
	// object can outlive its row; counting it against the limit could omit a live
	// row's object and trigger a redundant restore. Within one cache, the
	// `(cache, storePathHash)` scan covers a contiguous R2 key range.
	private async presentNarInfoObjects(
		logger: Logger,
		rows: readonly NarInfoRow[],
		candidateStartAfter: string | undefined
	): Promise<ReadonlySet<string> | undefined> {
		if (rows.length === 0) {
			return new Set();
		}

		const tenant = this.context.requireTenant();
		const prefix = narInfoObjectPrefix(tenant);

		let minKey: string | undefined;
		let lastKey = '';
		for (const row of rows) {
			const key = narInfoObjectKey(tenant, row.storePathHash, row.cache);

			if (key > lastKey) {
				lastKey = key;
			}

			if (minKey === undefined || key < minKey) {
				minKey = key;
			}
		}

		// The scan cursor walks `(cache, storePathHash)`, which diverges from R2 key
		// order because a named cache nests its segment inside the shared narinfo
		// prefix. Resuming after the cursor is only safe when every batch key sorts
		// after it. When a batch key sorts at or before the cursor (a named cache the
		// cursor has already passed in scan order), resuming would skip it and listing
		// from the start could rescan the whole prefix, so fall back to a head per row
		// for this batch instead.
		if (
			candidateStartAfter !== undefined &&
			minKey !== undefined &&
			candidateStartAfter >= minKey
		) {
			return undefined;
		}

		const startAfter = candidateStartAfter;

		const present = new Set<string>();
		let cursor: string | undefined;
		let isDone = false;

		try {
			while (!isDone) {
				const listed = await this.context.env.BLOBS.list(
					cursor === undefined ? { prefix, startAfter } : { prefix, cursor }
				);
				const inRange = listed.objects.filter(
					(object) => object.key <= lastKey
				);

				for (const object of inRange) {
					present.add(object.key);
				}

				// An object beyond the batch's last key proves that the range is complete.
				isDone = inRange.length < listed.objects.length || !listed.truncated;
				cursor = listed.truncated ? listed.cursor : undefined;
			}
		} catch (error) {
			// A transient list fault must not abort the whole reconcile; fall back to
			// a per-row head, which keeps each row's own fault isolation.
			logger.warn('narinfo object listing failed; falling back to heads', {
				error
			});

			return undefined;
		}

		return present;
	}

	// A deferred commit reserves its narinfo row before creating a reference edge.
	// Require the edge so reconciliation cannot serve a reserved, unverified row.
	// Read outside the gate; if a commit creates the edge afterwards, this pass
	// leaves the row for the next scan.
	private async committedEdgeKeys(
		rows: readonly NarInfoRow[]
	): Promise<ReadonlySet<string>> {
		if (rows.length === 0) {
			return new Set();
		}

		const tenant = this.context.requireTenant();
		const hashes = [...new Set(rows.map((row) => row.storePathHash))];

		const hashChunks = chunk(hashes, maxInClauseValues);
		const queries = hashChunks.map((hashChunk) => {
			const edgeFilter = and(
				eq(d1Schema.blobReference.tenant, tenant),
				inArray(d1Schema.blobReference.storePathHash, hashChunk)
			);

			return this.context.d1
				.select({
					cache: d1Schema.blobReference.cache,
					storePathHash: d1Schema.blobReference.storePathHash,
					generation: d1Schema.blobReference.generation,
					narHash: d1Schema.blobReference.narHash
				})
				.from(d1Schema.blobReference)
				.where(edgeFilter);
		});

		const chunkResults = await batchNonEmpty(this.context.d1, queries);

		const keys = new Set<string>();

		for (const edges of chunkResults) {
			for (const edge of edges) {
				keys.add(
					edgeKey(edge.cache, edge.storePathHash, edge.generation, edge.narHash)
				);
			}
		}

		return keys;
	}

	// Re-check the generation under the caller's critical section because a commit
	// or delete can change the row while R2 is being probed. Require a committed
	// edge as well, so a reserved row cannot become servable before verification.
	//
	// Runs inside the caller's critical section; must not open its own.
	private async reconcileObservation(
		logger: Logger,
		observation: RowObservation,
		origin: RequestOrigin | undefined,
		committedEdges: ReadonlySet<string>
	): Promise<ReconcileOutcome> {
		const {
			row,
			isNarPresent: isNarPresent,
			objectPresent: isObjectPresent
		} = observation;
		const current = this.narInfoRow(row.cache, row.storePathHash);

		if (current?.generation !== row.generation) {
			return 'unchanged';
		}

		if (
			!committedEdges.has(
				edgeKey(
					current.cache,
					current.storePathHash,
					current.generation,
					current.narHash
				)
			)
		) {
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
			this.warnSkippedRow(logger, row, error);
		}

		return 'unchanged';
	}

	// Select and lease without yielding so no other claim can interleave. Lease
	// only the rows returned to the caller; the sentinel and rows excluded by a
	// cap must remain claimable.
	private leaseRows(uploadIds: readonly UploadId[], now: Date): void {
		if (uploadIds.length === 0) {
			return;
		}

		this.context.db
			.update(schema.pendingUploads)
			.set({ claimedAt: isoTimestamp(now) })
			.where(inArray(schema.pendingUploads.id, uploadIds))
			.run();
	}

	// Frees a claimed row the pass working it is abandoning unsettled (a
	// transient fault), so the next pass need not wait the lease out. A crashed
	// pass never reaches this; its rows free at lease expiry.
	private releaseLease(uploadId: UploadId): void {
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
		logger: Logger,
		targets: readonly ReconcileTarget[],
		origin: RequestOrigin | undefined
	): Promise<void> {
		const rows = targets
			.map((target) => this.narInfoRow(target.cache, target.storePathHash))
			.filter((row): row is NarInfoRow => row !== undefined);

		if (rows.length === 0) {
			return;
		}

		const observations = await Promise.all(
			rows.map((row) =>
				this.probeRow(logger, row, (target) => this.headNarInfoObject(target))
			)
		);
		const committedEdges = await this.committedEdgeKeys(
			reconcileCandidates(observations)
		);

		await this.context.criticalSection(async () => {
			for (const observation of observations) {
				if (observation === undefined) {
					continue;
				}

				await this.reconcileObservation(
					logger,
					observation,
					origin,
					committedEdges
				);
			}
		});
	}

	async verify(
		logger: Logger,
		purgeOrigin: RequestOrigin | undefined,
		limit: number
	): Promise<VerifyReport> {
		await this.verifyPendingUploads(logger, limit);

		return this.verifyBatch(logger, purgeOrigin, limit);
	}

	async verifyBatch(
		logger: Logger,
		origin: RequestOrigin | undefined,
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

		// Verification spans every cache and resumes after the composite
		// `(cache, storePathHash)` cursor. Keep both parts in the predicate so a
		// pass cannot skip the beginning of the next cache.
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
		// round-trips never block a concurrent commit or delete. A transient R2
		// fault on one row drops it from this pass, letting the batch continue. The
		// narinfo objects come from one bounded list at the cursor, not a head per
		// row; a list fault falls back to per-row heads. The per-row NAR head stays,
		// since a `blob_state` proxy would hide the object-versus-fact drift this
		// reconcile exists to heal.
		const tenant = this.context.requireTenant();
		const startAfter =
			fromCache === '' && fromHash === ''
				? undefined
				: narInfoObjectKey(
						tenant,
						storePathHashSchema.parse(fromHash),
						fromCache
					);
		const presentObjects = await this.presentNarInfoObjects(
			logger,
			rows,
			startAfter
		);
		const resolveObjectPresent =
			presentObjects === undefined
				? (target: NarInfoRow) => this.headNarInfoObject(target)
				: (target: NarInfoRow) =>
						Promise.resolve(
							presentObjects.has(
								narInfoObjectKey(tenant, target.storePathHash, target.cache)
							)
						);
		const observations = await Promise.all(
			rows.map((row) => this.probeRow(logger, row, resolveObjectPresent))
		);
		const committedEdges = await this.committedEdgeKeys(
			reconcileCandidates(observations)
		);

		// Apply the reconciles and advance the cursor in one short critical section.
		// What remains inside the gate is fast synchronous SQLite plus the rare write
		// for an unhealthy row.
		return this.context.criticalSection(async () => {
			let narInfoObjectsRestored = 0;
			let danglingNarInfosRemoved = 0;

			for (const observation of observations) {
				if (observation === undefined) {
					continue;
				}

				const outcome = await this.reconcileObservation(
					logger,
					observation,
					origin,
					committedEdges
				);

				if (outcome === 'removed') {
					danglingNarInfosRemoved += 1;
				} else if (outcome === 'restored') {
					narInfoObjectsRestored += 1;
				}
			}

			// A short batch reaches the end of the scan. `wrapped` reports that the
			// next pass will restart from the first cache's lowest hash.
			const hasWrapped = rows.length < limit;
			const last = rows.at(-1);
			const nextCache = hasWrapped || last === undefined ? '' : last.cache;
			const nextHash =
				hasWrapped || last === undefined ? '' : last.storePathHash;
			const now = isoTimestamp(new Date());

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

	// The cron fallback claims unleased `pending` and `committing` rows. It verifies
	// fresh staging bytes outside the input gate, then uses the same fenced settle
	// path as the queue consumer. Each pass is bounded by `limit`.
	async verifyPendingUploads(logger: Logger, limit: number): Promise<void> {
		// Queue leases identify work already in progress. Claim around those rows and
		// lease this pass's rows synchronously so a consumer cannot take them.
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

		// A failure for one upload releases its lease and leaves its marker for the
		// next pass. It must not prevent the remaining claims from settling.
		const ready: PreparedSettle[] = [];

		for (const pending of pendings) {
			try {
				const prepared = await this.prepareAndPromote(pending);

				if (prepared !== undefined) {
					ready.push(prepared);
				}
			} catch {
				this.releaseLease(pending.id);
			}
		}

		if (ready.length === 0) {
			return;
		}

		// Read each promoted path's canonical facts and ownership once through
		// chunked queries. These facts can become stale while the batch settles; the
		// charge batch remains the authoritative status and quota fence, and an
		// over-quota result triggers a fresh probe.
		const prefetched = await this.prefetchedFactsFor(logger, ready);

		for (const item of ready) {
			try {
				await this.materialiseVerified(
					logger,
					item.pending,
					item.metadata,
					item.generation,
					prefetched?.get(item.metadata.narHash)
				);
			} catch {
				this.releaseLease(item.pending.id);
			}
		}
	}

	// The queue consumer fetches and verifies fresh staging objects outside the
	// Durable Object. A reuse claim identifies canonical bytes that need no
	// decode. Selection and leasing are one synchronous step on the single writer,
	// so an overlapping cron or queue pass cannot take the same row.
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

	// Processes up to `limit` pending reuse rows on the Durable Object. Their
	// bytes are already verified in the canonical object, so processing requires
	// only a head request and a `blob_state` upsert. The alarm backstop processes
	// these inexpensive rows even when no consumer pass is running; fresh rows
	// remain for the queue consumer, which decodes them off the Durable Object's
	// thread. The query applies both the reuse test and the limit, so a large
	// backlog of fresh rows adds no scan cost. It also leases the selected rows
	// synchronously, so a concurrent consumer does not claim them.
	async processPendingReuse(logger: Logger, limit: number): Promise<number> {
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
		const ready: PreparedSettle[] = [];

		for (const pending of pendings) {
			try {
				const prepared = await this.prepareRecordedVerdict(
					pending.id,
					{ ok: true },
					'promote'
				);

				if (prepared === undefined) {
					settled += 1;
				} else {
					ready.push(prepared);
				}
			} catch (error) {
				if (error instanceof UploadedObjectNotFoundError) {
					// A missing canonical object cannot reappear. Record `absent`
					// immediately rather than leave a lease on a stale row.
					await this.recordMissingObject(pending.id);
					settled += 1;
					continue;
				}

				// A transient fault: free the lease and leave the row for the next
				// pass without starving the rest.
				this.releaseLease(pending.id);
				logger.warn('pending reuse upload not settled', {
					uploadId: pending.id,
					error
				});
			}
		}

		if (ready.length === 0) {
			return settled;
		}

		// Read every survivor's canonical facts once, then materialise from memory:
		// a reuse backlog settles with O(chunks) probe reads, not one per row. The
		// facts can go stale across the batch; the charge batch remains the
		// authoritative fence and the over-quota retry re-probes.
		const prefetched = await this.prefetchedFactsFor(logger, ready);

		for (const item of ready) {
			try {
				await this.materialiseVerified(
					logger,
					item.pending,
					item.metadata,
					item.generation,
					prefetched?.get(item.metadata.narHash)
				);
				settled += 1;
			} catch (error) {
				this.releaseLease(item.pending.id);
				logger.warn('pending reuse upload not settled', {
					uploadId: item.pending.id,
					error
				});
			}
		}

		return settled;
	}

	// This compatibility RPC is idempotent because a queue consumer can report the
	// same upload again after a retry. A vanished, terminal or superseded row makes
	// the repeated report a no-op.
	async recordVerification(
		logger: Logger,
		uploadId: UploadId,
		verification: NarVerification,
		promotion: PromotionState = 'promote'
	): Promise<void> {
		const prepared = await this.prepareRecordedVerdict(
			uploadId,
			verification,
			promotion
		);

		if (prepared === undefined) {
			return;
		}

		await this.materialiseVerified(
			logger,
			prepared.pending,
			prepared.metadata,
			prepared.generation
		);
	}

	// Each result is isolated so a transient promote or commit failure leaves only
	// that row for another pass. Materialisations share the flush, and the return
	// value counts only results that applied. The consumer requests a continuation
	// only after real progress; a batch with no progress leaves retry to cron.
	async recordVerifications(
		logger: Logger,
		results: readonly VerificationResult[]
	): Promise<number> {
		let applied = 0;

		const ready: PreparedSettle[] = [];

		await mapWithConcurrency(
			results,
			maxOutgoingConnections,
			async ({ uploadId, verdict }) => {
				try {
					if (verdict.kind === 'abandoned') {
						// The consumer gave the claim up unsettled (a transient fault);
						// free the lease so the next pass retries promptly. Not progress,
						// so it does not count towards the continuation gate.
						this.releaseLease(uploadId);
						return;
					}

					if (verdict.kind === 'missing') {
						await this.recordMissingObject(uploadId);
						applied += 1;
						return;
					}

					const verification: NarVerification =
						verdict.kind === 'promoted' ? { ok: true } : verdict.verification;
					const promotion: PromotionState =
						verdict.kind === 'promoted' ? 'already-promoted' : 'promote';
					const prepared = await this.prepareRecordedVerdict(
						uploadId,
						verification,
						promotion
					);

					if (prepared === undefined) {
						applied += 1;
						return;
					}

					ready.push(prepared);
				} catch (error) {
					logger.warn('verification verdict not recorded', { uploadId, error });
				}
			}
		);

		if (ready.length === 0) {
			return applied;
		}

		// Read every promoted survivor's canonical facts once, then materialise each
		// from memory: a large verdict batch costs O(chunks) probe reads, not one per
		// path. A materialise fault leaves the row for the next pass, so it does not
		// count towards the continuation gate. The facts can go stale across the
		// batch; the charge batch remains the authoritative fence and the over-quota
		// retry re-probes.
		const prefetched = await this.prefetchedFactsFor(logger, ready);

		await mapWithConcurrency(ready, maxOutgoingConnections, async (item) => {
			try {
				await this.materialiseVerified(
					logger,
					item.pending,
					item.metadata,
					item.generation,
					prefetched?.get(item.metadata.narHash)
				);
				applied += 1;
			} catch (error) {
				logger.warn('verification verdict not recorded', {
					uploadId: item.pending.id,
					error
				});
			}
		});

		return applied;
	}

	// A missing private staging object is a terminal mismatch because those bytes
	// cannot reappear. A missing canonical object does not prove that a reuse
	// client's NAR is invalid, so clear that row and report `absent`; the client can
	// negotiate and upload again.
	async recordMissingObject(uploadId: UploadId): Promise<void> {
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
			// A reuse commit that crashed after reserving its narinfo row leaves that
			// row behind; with the canonical object gone it can never materialise, and
			// a root may already reference it (as not-present). Reclaim it before
			// dropping the marker.
			const reserved = this.narInfoRow(pending.cache, metadata.storePathHash);

			let reclaim: 'reclaimed' | 'committed-current' | 'superseded' =
				'superseded';

			if (reserved?.narHash === metadata.narHash) {
				// The grace confirmation runs inside the same gated callback as
				// the identity proof: the input gate reopens the moment that
				// callback completes, so a confirmation outside it could race a
				// delete or recommit queued behind the gate.
				reclaim = await this.context.criticalSection(async () => {
					const result = await this.commitPipeline.reclaimReservedRow(
						pending.cache,
						metadata.storePathHash,
						reserved.generation,
						metadata.narHash
					);

					// This upload lost the race, so its own captured decision
					// never ran; apply it against the winning generation before
					// notifying, or a positive policy would grant nothing. The
					// push's run root retains the path for the same reason,
					// under the same proof.
					if (result === 'committed-current') {
						this.commitPipeline.attachRootTarget(
							pending.cache,
							pending.attachRootName,
							metadata.storePathHash,
							metadata.storePath
						);
						confirmGrace(
							this.context,
							this.retention,
							pending.cache,
							metadata.storePathHash,
							reserved.generation,
							metadata.narHash,
							parseStoredGraceDecision(pending.graceDecisionJson)?.graceSeconds
						);
					}

					return result;
				});

				// A concurrent pass has already committed this generation, so the
				// missing verdict is stale. Clear the stuck row and send `servable`
				// without pruning its root.
				if (reclaim === 'committed-current') {
					this.notifyWaiters(pending, 'servable');
					this.uploadState.clearPendingUpload(pending.id);
					return;
				}
			}

			this.notifyWaiters(pending, 'absent');
			await this.uploadState.clearPendingUploadAndStaging(
				pending.id,
				pending.r2Key,
				metadata.narHash
			);

			// A superseded or recommitted row still holds the path, so its
			// retention targets must survive; only a genuinely reclaimed path
			// releases them.
			if (reclaim === 'reclaimed') {
				this.pruneRetentionTargets(pending.cache, metadata.storePathHash);
			}

			return;
		}

		await this.uploadState.markUploadTerminal(
			pending.id,
			pending.r2Key,
			metadata.narHash,
			'mismatch'
		);
		this.pruneRetentionTargets(pending.cache, metadata.storePathHash);
		this.notifyWaiters(pending, 'mismatch');
	}
}
