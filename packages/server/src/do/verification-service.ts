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

// The identity of a committed reference edge, so a reconcile can tell a committed
// row from a reserved-but-unverified one (which reserve-at-commit also leaves in
// `nar_infos`) without a per-row D1 read.
function edgeKey(
	cache: StoredCache,
	storePathHash: string,
	generation: NarInfoGeneration,
	narHash: string
): string {
	return `${cache}\0${storePathHash}\0${String(generation)}\0${narHash}`;
}

// The rows a reconcile would act on: a missing NAR or narinfo object. Only these
// need the committed-edge check, so a healthy pass reads no edges at all.
function reconcileCandidates(
	observations: readonly (RowObservation | undefined)[]
): NarInfoRow[] {
	return observations
		.filter(
			(observation): observation is RowObservation =>
				observation !== undefined &&
				(!observation.narPresent || !observation.objectPresent)
		)
		.map((observation) => observation.row);
}

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
	readonly uploadId: UploadId;
	readonly r2Key: R2ObjectKey;
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
// single RPC.
export interface VerificationResult {
	readonly uploadId: UploadId;
	readonly verdict: VerificationVerdict;
}

// A claimed upload that reserved, verified and promoted in a batch pass's first
// phase, ready to materialise in the second once the batch's probe facts are read.
interface PreparedSettle {
	readonly pending: typeof schema.pendingUploads.$inferSelect;
	readonly metadata: ParsedUploadPathNegotiation;
	readonly generation: NarInfoGeneration;
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
		// Drops a store path from every retention root when it fails verification, so
		// a root set at commit over a still-verifying target does not keep a dead
		// reference. Injected because the roots service is constructed after this one.
		private readonly pruneRetentionTargets: (
			cache: StoredCache,
			storePathHash: StorePathHash
		) => void
	) {}

	// The current session id for an upload, re-read from the row at notify time so
	// a reconnect that re-pointed the row via `attachSession` between the settle's
	// read and its notify receives the verdict. Falls back to `captured` when the
	// row is already gone, which means the upload cleared while this pass was
	// working it and the captured id is as good as any.
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

	// Routes an upload's terminal verdict to the commit session waiting on it. The
	// session id is resolved from the live row at notify time, so a client reconnect
	// that re-pointed the row's session id via `attachSession` between the settle
	// reading the row and reaching this notify receives the verdict. The session
	// stays open: it carries the other ids in the push too.
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

	// The deadline a servable verdict reports: the grace row its materialisation
	// extended, read afresh so a replayed verdict reports the current deadline.
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

	// Phase A of a batch settle, and the backstop the hourly cron runs: reserve
	// the row, decode and hash-check the staging bytes on the Durable Object,
	// then promote, returning the claimed upload ready to materialise. A settle
	// that finishes here (the path was lost, already committed, its object
	// definitively absent, or its verdict failed) returns undefined and is not
	// carried into the materialise phase. The prompt path instead decodes in the
	// queue consumer, off the Durable Object thread, and records its verdict
	// through `recordVerification`.
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

	// Phase A of recording a queue-consumer verdict: read the row, reserve, verify
	// it is not already committed, and promote. Returns the upload ready to
	// materialise, or undefined when it settled here (a vanished or already-decided
	// row, a lost path, or a failed verdict). A batch pass collects the survivors,
	// reads their probe facts once, then materialises them from memory.
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

	// Reserves the narinfo row before committing a verified upload: a fresh deferred
	// upload gets its first row, a crashed or re-driven commit finds its own
	// (`mine`). A different version holding the path (`lost`) means this upload can
	// never own it, so its row and staging bytes are dropped and waiters told
	// `absent`; the caller stops. Returns the reserved generation, or undefined when
	// the path was lost.
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

	// Short-circuits a re-claimed upload whose bytes already verified and
	// materialised: only its clear-marker step was interrupted, so the whole
	// decode/promote/materialise saga would re-run to no effect. When the reserved
	// generation is already committed and serving, finish the bookkeeping instead,
	// the same tail a fresh materialise's success runs. Returns whether it settled
	// the upload here.
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
		// interruption between the two leaves a committed generation whose
		// decision still sits on the pending row. Reapply it before the waiters
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

		// The row moved during the committed-edge check, so this "already
		// committed" conclusion is stale: settling on it would report a row
		// that no longer holds the path and drop the grant. Decline the
		// short-circuit and let the ordinary saga re-verify against whatever
		// holds the path now; its charge batch is the authoritative fence.
		if (!confirmed.matched) {
			return false;
		}

		// The committed row's identity was just proven by the confirmation, so
		// the push's run root retains the path, exactly as the flush attaches
		// it when the settle runs uninterrupted.
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

	// A failed verdict reclaims the reserved row and settles the upload; a good one
	// promotes the staging bytes into the shared CAS. Returns whether the upload
	// survived to materialise. Split from the materialise half so a batch pass can
	// promote its whole claim before reading the probe facts once.
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

		return true;
	}

	// Reads a whole batch's probe facts for its materialise phase, degrading to
	// undefined on a fault so each row falls back to its own fresh probe under
	// the per-row guards: one transient D1 blip costs the batched read, never
	// the pass.
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

	// The materialise half of the settle: probe the canonical facts and settle the
	// reserved narinfo through the shared flush. A batch pass passes the probe facts
	// it read for the whole claim; a lone settle passes none and the probe reads
	// them fresh.
	private async materialiseVerified(
		logger: Logger,
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration,
		prefetched?: PrefetchedMaterialisationFacts
	): Promise<void> {
		// Probed after the promote, which is what makes the canonical object and
		// its `blob_state` row exist; probing earlier would read them absent.
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
			// A deferred settle proved its bytes: a fresh decode, or a reuse row
			// that negotiate admitted while the presence edge existed. Ownership
			// is not re-required here, and on the first commit of a hash the
			// tenant does not own it yet.
			mustOwnBlob: false,
			// A vanished row was settled elsewhere; a terminal one was settled by a
			// competing pass during this apply's promote and probe awaits. Either
			// way the row's fate is decided and this apply must not touch it. Runs
			// inside the flush gate, so the check and the charge cannot interleave
			// with a competing settle.
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

			// A concurrent pass may have settled the upload during the re-probe; its
			// fate is decided, so this apply stops exactly as the first outcome's
			// gone check does.
			if (retried.kind === 'gone') {
				return;
			}

			// Swap in the fresh outcome so the handlers below decide on it. A second
			// over-quota falls through to the terminal block.
			outcome = retried;
		}

		if (outcome.kind === 'over-quota') {
			// Reclaim the reserved row and record a terminal verdict. Otherwise a later
			// verify pass, scanning narInfos, would restore its object and make an
			// unreferenced, uncharged path servable.
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

				// This upload lost the race, so its own captured decision never
				// ran; apply it against the winning generation before notifying,
				// or a positive policy would grant nothing. The push's run root
				// retains the path for the same reason, under the same proof.
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

			// A concurrent pass committed this generation before the tenant went
			// inactive, so it serves; finish the bookkeeping without pruning.
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
			// The object publishes after the gate; the waiters hear the verdict and
			// the marker clears only once it has landed, so an interruption in
			// between stays re-drivable from the durable marker.
			await this.narInfoObjects.publishNarInfoObject(
				pending.cache,
				metadata.storePathHash,
				generation,
				metadata.narHash,
				outcome.narInfo
			);

			// The parked sockets carry the verdict, and the narinfo itself is the
			// durable evidence of success, so a settled upload leaves no residue:
			// the row clears and the staging bytes go.
			this.notifyWaiters(pending, 'servable');
			this.uploadState.clearPendingUpload(pending.id);
			await this.deleteStagingObject(pending);
			return;
		}

		// A concurrent recommit took the path or the blob vanished, so this upload
		// lost: clear its marker. Any blob it promoted that no edge now references is
		// left for the reaper to collect.
		this.notifyWaiters(pending, 'absent');
		this.uploadState.clearPendingUpload(pending.id);
		await this.deleteStagingObject(pending);
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
	// rejection. If the reclaim finds the generation already committed (its edge
	// exists, because a concurrent pass settled these bytes servable), this is not a
	// failure: leave the row, the root and the waiter to that committer, so a
	// straggling failure verdict never retires a path that serves.
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

		// A concurrent saga committed this upload's own row, so the failure is
		// stale and the path serves; the settle that committed it owns the
		// bookkeeping.
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
			row.generation,
			row.narHash,
			narInfo
		);

		return 1;
	}

	private warnSkippedRow(
		logger: Logger,
		row: typeof schema.narInfos.$inferSelect,
		error: unknown
	): void {
		logger.warn('verification skipped a narinfo row', {
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

	// Probes a committed row's two R2 objects outside any critical section, so the
	// round-trips never block a concurrent commit or delete. A transient R2 fault
	// drops the row from this pass, letting the batch continue. The narinfo object
	// is only probed when its NAR is present: a missing NAR removes the row
	// regardless of the narinfo object. The narinfo-object presence is resolved by
	// the caller: a targeted probe heads it directly; a scanning batch reads it from
	// one bulk list (see {@link presentNarInfoObjects}).
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
				narPresent: isNarPresent,
				objectPresent: isNarPresent && (await isObjectPresent(row))
			};
		} catch (error) {
			this.warnSkippedRow(logger, row, error);

			return undefined;
		}
	}

	// Heads a single narinfo object, the per-row presence check a targeted reconcile
	// uses where the paths are arbitrary and too few to list.
	private async headNarInfoObject(row: NarInfoRow): Promise<boolean> {
		const key = narInfoObjectKey(
			this.context.requireTenant(),
			row.storePathHash,
			row.cache
		);

		return (await this.context.env.BLOBS.head(key)) !== null;
	}

	// The narinfo objects present for a scanning reconcile batch, listed from the
	// cursor position instead of a head per row. The scan walks
	// `(cache, storePathHash)` in order, so within a cache the objects are a
	// contiguous key range. The listing is bounded by the batch's last key, not a
	// row count: an orphan object in the range (a delete whose object outlived its
	// row) must not consume a slot and push a live row's object out of the window,
	// which would read it absent and force a redundant restore. A row whose object
	// the range genuinely omits reads absent, at worst prompting an idempotent
	// restore.
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

				// A filtered object (past the batch's last key) or an untruncated page
				// ends the scan.
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

	// The committed reference edges among `rows`, read in one chunked D1 query, so a
	// reconcile can skip a reserved-but-unverified row. A deferred commit reserves
	// its narinfo row before verification, so a row can sit in `nar_infos` with no
	// edge; the verify pass, not this reconcile, owns such a row. Read outside any
	// gate; a row that commits after this reads conservatively as uncommitted and is
	// simply left for the next pass.
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

		// One D1 round-trip covers every chunk; each stays within the parameter cap.
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

	// Applies one row's probe under the caller's critical section. The generation
	// re-check rejects any row a commit or delete changed during the probe, so a
	// reconcile never acts on stale state: a NAR only reappears through a commit,
	// which bumps the generation. A missing NAR removes the dangling narinfo; a
	// present NAR with a missing object restores the object. A row with no committed
	// edge is reserved, not yet verified, so it is left untouched.
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
			narPresent: isNarPresent,
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

	// Takes the lease for rows a pass is about to work, synchronously with the
	// selection that chose them, so no other claim can interleave. Only the
	// rows actually handed out are leased: the selection's sentinel row and any
	// rows a cap excluded stay claimable.
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

	// One interactive verify pass: settle deferred uploads first, then run a
	// bounded reconciling batch and report it.
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

			// A short batch means the scan reached the end; clear the cursor so the
			// next pass starts again from the first cache's lowest hash.
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

	// Background verify-and-commit of uploads deferred at commit because their blob
	// exceeded the inline budget. Each staging blob is decompressed and hash-verified
	// outside the critical section, then promoted and committed (on a match) or its
	// staging object deleted (on a failure) inside one, so a `pending` path becomes
	// servable only once its bytes are confirmed. Bounded per pass; the cron drives
	// it.
	async verifyPendingUploads(logger: Logger, limit: number): Promise<void> {
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

		// Phase A: reserve, verify and promote each claimed upload, collecting the
		// survivors that reach materialise. A per-upload failure frees its lease and
		// leaves its marker for the next pass, so it does not starve the rest.
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

		// Read every promoted path's canonical facts and ownership once, in two
		// chunked queries, then materialise each from memory: the pass's per-path D1
		// reads collapse from O(paths) to O(chunks). The facts are read once before
		// phase B and can go stale across the batch; the charge batch remains the
		// authoritative fence for status and quota, and the over-quota retry re-probes.
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
	async settlePendingReuse(logger: Logger, limit: number): Promise<number> {
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

		// Phase A: reserve and promote each reuse row against its canonical object.
		// A row settled here (lost or already committed) counts at once; a promoted
		// survivor is collected to materialise once the batch's facts are read.
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
					// The canonical object is gone and cannot reappear: answer the
					// waiter terminally so the lease is not wasted on a stale row.
					await this.recordMissingObject(pending.id);
					settled += 1;
					continue;
				}

				// A transient fault: free the lease and leave the row for the next
				// pass without starving the rest.
				this.releaseLease(pending.id);
				logger.warn('reuse settle failed', { uploadId: pending.id, error });
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
				logger.warn('reuse settle failed', {
					uploadId: item.pending.id,
					error
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

	// Settles a batch of verdicts the queue consumer decoded off the DO thread in
	// one RPC, so a pass over many deferred uploads costs a single round trip
	// into the DO. The verdicts apply concurrently (each
	// upload id is claimed once, so no two applies share a row) and their
	// materialisations coalesce onto the shared flush, so a batch costs a
	// handful of gates and charge batches. One
	// verdict's apply failing (a transient promote or commit fault) must not
	// abort the rest of the batch or fail the queue message: its row is left for
	// the next pass, the same fault isolation the per-upload RPCs had. Returns
	// how many verdicts actually applied, so the caller continues the drain only
	// on real progress; a batch whose every apply fails backs off to the cron.
	async recordVerifications(
		logger: Logger,
		results: readonly VerificationResult[]
	): Promise<number> {
		let applied = 0;

		// Phase A: read, reserve, verify and promote each verdict concurrently. A
		// verdict settled here (missing, a lost path, an already-committed row, or a
		// failed verdict) is progress and counts at once; a promoted survivor is
		// collected to materialise once the batch's probe facts are read.
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

	// Records the terminal outcome for a deferred upload whose bytes the queue
	// consumer found definitively gone, so its waiters are answered promptly. A
	// fresh row's staging object cannot reappear, so it fails as `mismatch`. A
	// reuse row's bytes are the shared canonical object, and that object going
	// missing is no evidence against the bytes the client offered, so the row is
	// dropped and its waiters told `absent`, the answer that re-drives the push
	// through a fresh negotiate and upload.
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

				// A concurrent pass has already committed this generation (its edge
				// exists), so the missing verdict is stale and the path serves. Clear
				// the stuck row and answer servable, without pruning its root.
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
