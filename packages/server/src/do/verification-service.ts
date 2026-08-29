import { type Logger, rootLogger } from '@cupboard/logger';
import {
	type NarInfoGeneration,
	nixSha256HashSchema,
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { type VerifyReport } from '@cupboard/protocol/reports';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type ParsedUploadGraceFact,
	type ParsedUploadPathNegotiation,
	type ParsedUploadStatusResponse,
	type SessionId,
	type UploadId,
	uploadIdSchema
} from '@cupboard/protocol/upload';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	and,
	asc,
	eq,
	exists,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	ne,
	or,
	sql
} from 'drizzle-orm';
import { z } from 'zod';

import { type NarVerification } from '../blob/nar-verify.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import {
	maxVerificationRpcRows,
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
	chunk,
	executeChunkedStatement,
	maxInClauseValues,
	maxOutgoingConnections
} from './bulk.ts';
import {
	type CommitPipelineService,
	type PrefetchedMaterialisationFacts
} from './commit-pipeline-service.ts';
import { sendCommitSessionFrame } from './commit-socket.ts';
import { type SchemaDatabase, type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import {
	confirmGrace,
	parseStoredGraceDecision,
	storedGraceFact
} from './grace-decision.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import {
	type ReconcileTarget,
	statementsPerReconcileEdgeQuery,
	statementsPerReconcileProbe,
	statementsPerReconcileRemoval,
	statementsPerReconcileRestore
} from './reconcile-queue-service.ts';
import { type RetentionService } from './retention-service.ts';
import {
	affordableOperations,
	statementsRemaining
} from './statement-scope.ts';
import { parseStoredUploadPathMetadata } from './upload-metadata.ts';
import { type UploadStateService } from './upload-state-service.ts';
import {
	raceVerificationOperation,
	withRenewedVerificationClaim
} from './verification-claim-lease.ts';

type NarInfoRow = typeof schema.narInfos.$inferSelect;
type PendingUploadRow = typeof schema.pendingUploads.$inferSelect;

// These constants determine the page sizes for the settle and drain passes. The
// D1 binding enforces the statement limit even if one of the constants becomes
// inaccurate. An inaccurate constant can therefore reduce the work completed
// by a pass, but cannot cause the pass to exceed the limit.
//
// Before settling any rows, a pass reads the shared blob rows and the tenant's
// presence rows for the whole page. The page contains at most the number of
// distinct NAR hashes allowed in one `IN (...)` list, so each read requires one
// D1 statement.
export const pendingSettlePrefetchStatements = 2;

// Classifying one committed-recovery candidate reads the path's committed
// reference edge. A reuse row skips this read.
const settleClassifyStatements = 1;

// Preparing one row reads the NAR's current incarnation, the row's committed
// reference edge, and the shared blob row from which the narinfo is rendered.
const settlePrepareStatements = 3;

// Charging one commit probes the tenant's quota, then runs a batch containing
// the tenant status read and the five statements that credit usage and record
// the reference edge and the presence row.
const settleChargeStatements = 7;

// After charging a row, publication reads the shared blob row for the narinfo.
const settlePublishStatements = 1;

// Re-reading one row's shared blob row and presence row is a two-statement
// batch.
const settleRowProbeStatements = 2;

// Reclaiming a reserved narinfo row reads the row's reference edge.
const settleReclaimStatements = 1;

// If charging reports that the tenant is over quota, the service reads the
// blob and presence rows again, charges a second time, and reclaims the
// reserved narinfo row. The row does not reach the publication read. The result
// is unknown until the first charge completes, so every row reserves enough
// statements for the more expensive result.
const settleOverQuotaStatements =
	settleRowProbeStatements + settleChargeStatements + settleReclaimStatements;

/**
 * The maximum number of D1 statements needed to settle one pending row without
 * decoding its NAR.
 *
 * Every row uses the same maximum because the result is unknown before the
 * first charge completes.
 */
export const statementsPerPendingSettleRow =
	settleClassifyStatements +
	settlePrepareStatements +
	settleChargeStatements +
	Math.max(settlePublishStatements, settleOverQuotaStatements);

// Promoting a freshly verified upload writes the shared blob row for the new
// canonical object and reads the row back. Complete invocations show that this
// requires six more statements than settling a row for an existing canonical
// object.
const settlePromoteStatements = 6;

/**
 * The maximum number of D1 statements needed to apply one recorded verdict.
 *
 * Applying a verdict runs the same reservation, charge and publication as
 * settling a row without a decode, and promotes the upload's bytes as well. It
 * skips the classification read, because the queue consumer has already
 * classified the row. A page of verdicts also requires the same prefetch as a
 * page of pending rows.
 *
 * Complete invocations show that a successful settlement requires 17 of these
 * statements. The remaining statements cover the case in which charging
 * reports that the tenant is over quota.
 */
export const statementsPerRecordedVerdict =
	statementsPerPendingSettleRow -
	settleClassifyStatements +
	settlePromoteStatements;

const pendingDecodeFreeCursorKey =
	'maintenance:verification-decode-free-cursor';

// The rotating cursor for the verdict drain. Each pass stores the upload ID of
// the last valid verdict in its page. The drain wraps to the lowest upload ID
// when no row follows the cursor. A pass with no verdict to apply deletes the
// cursor, so the next pass starts from the beginning.
const recordedVerdictCursorKey = 'maintenance:verdict-drain-cursor';

function parseUploadIdCursor(value: unknown): UploadId | undefined {
	const parsed = uploadIdSchema.safeParse(value);

	return parsed.success ? parsed.data : undefined;
}

type DecodeFreeCandidateKind = 'reuse' | 'recovery';

interface DecodeFreeCursorState {
	readonly next: DecodeFreeCandidateKind;
	readonly reuse?: UploadId;
	readonly recovery?: UploadId;
}

function parseDecodeFreeCursorState(value: unknown): DecodeFreeCursorState {
	if (typeof value !== 'object' || value === null) {
		return { next: 'reuse' };
	}

	const stored = value as Record<string, unknown>;
	const reuse = uploadIdSchema.safeParse(stored.reuse);
	const recovery = uploadIdSchema.safeParse(stored.recovery);
	const next = stored.next === 'recovery' ? 'recovery' : 'reuse';

	return {
		next,
		...(reuse.success && { reuse: reuse.data }),
		...(recovery.success && { recovery: recovery.data })
	};
}

function otherDecodeFreeCandidateKind(
	kind: DecodeFreeCandidateKind
): DecodeFreeCandidateKind {
	return kind === 'reuse' ? 'recovery' : 'reuse';
}

function edgeKey(
	cache: StoredCache,
	storePathHash: string,
	generation: NarInfoGeneration,
	narHash: string
): string {
	return `${cache}\0${storePathHash}\0${String(generation)}\0${narHash}`;
}

// Returns the number of D1 statements required to repair an observation.
// Removing a row with a missing NAR requires one statement. Restoring a missing
// narinfo object requires two. A healthy row requires no repair and returns
// zero.
function repairStatements(observation: RowObservation): number {
	if (!observation.isNarPresent) {
		return statementsPerReconcileRemoval;
	}

	return observation.objectPresent ? 0 : statementsPerReconcileRestore;
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

/**
 * Runs probes with the same outgoing-connection bound as reconciliation.
 */
export function mapVerificationProbes<T, U>(
	items: readonly T[],
	probe: (item: T, index: number) => Promise<U>
): Promise<U[]> {
	return mapWithConcurrency(items, maxOutgoingConnections, probe);
}

/**
 * The result of reconciling one row. `failed` means that a D1, R2 or narinfo
 * publication error interrupted the repair and the row still needs attention.
 */
type ReconcileOutcome = 'removed' | 'restored' | 'unchanged' | 'failed';

interface ReconcileCounts {
	readonly removed: number;
	readonly restored: number;
}

function reconcileCounts(outcome: ReconcileOutcome): ReconcileCounts {
	if (outcome === 'removed') {
		return { removed: 1, restored: 0 };
	}

	if (outcome === 'restored') {
		return { removed: 0, restored: 1 };
	}

	return { removed: 0, restored: 0 };
}

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

// The owner must accompany every later renewal and verdict. `truncated` means
// that the row or byte limit left work for another pass.
export interface PendingVerificationBatch {
	readonly owner: string;
	readonly claims: readonly PendingVerification[];
	readonly truncated: boolean;
}

type PendingVerificationChunk = Omit<PendingVerificationBatch, 'owner'>;

// The queue consumer's verdict for one claimed upload. Older consumers can
// report `promoted` after writing the canonical object. Current consumers report
// `verified` and leave shared writes to the Durable Object.
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

// The verdicts stored on an upload row until a pass can apply them. An
// `abandoned` result releases the lease immediately and is not stored.
const narVerificationSchema = z.union([
	z.strictObject({
		ok: z.literal(true),
		fileHash: nixSha256HashSchema.optional(),
		fileSize: z.number().optional()
	}),
	z.strictObject({
		ok: z.literal(false),
		reason: z.literal('nar-hash-mismatch'),
		actualNarHash: z.string()
	}),
	z.strictObject({
		ok: z.literal(false),
		reason: z.literal('nar-size-mismatch'),
		actualNarSize: z.number()
	}),
	z.strictObject({ ok: z.literal(false), reason: z.literal('undecodable') })
]);

const heldVerdictSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('verified'),
		verification: narVerificationSchema
	}),
	z.strictObject({ kind: z.literal('promoted') }),
	z.strictObject({ kind: z.literal('missing') })
]);

// The recorded owner fences verdict application. If the current claim owner
// differs, the verdict is stale and must not be applied.
const recordedVerdictSchema = z.strictObject({
	owner: z.string(),
	verdict: heldVerdictSchema
});

type RecordedVerdict = z.output<typeof recordedVerdictSchema>;

/**
 * Parses a recorded verdict, or returns `undefined` if this build cannot read
 * it.
 *
 * The column contains text. JSON written by an older build can fail the current
 * schema, and malformed JSON fails during parsing. The caller clears either
 * value so the drain can continue with later verdicts.
 */
function parseRecordedVerdict(
	recordedVerdictJson: string | null
): RecordedVerdict | undefined {
	if (recordedVerdictJson === null) {
		return undefined;
	}

	let document: unknown;

	try {
		document = JSON.parse(recordedVerdictJson);
	} catch {
		return undefined;
	}

	const parsed = recordedVerdictSchema.safeParse(document);

	return parsed.success ? parsed.data : undefined;
}

interface HeldVerdictRow extends RecordedVerdict {
	readonly pending: PendingUploadRow;
}

interface PreparedSettle {
	readonly pending: typeof schema.pendingUploads.$inferSelect;
	readonly metadata: ParsedUploadPathNegotiation;
	readonly generation: NarInfoGeneration;
	readonly owner: string;
}

/**
 * The committed reference edges returned by a read and the store path hashes
 * included in that read. The edge is unknown for every excluded hash.
 */
interface CommittedEdges {
	readonly keys: ReadonlySet<string>;
	readonly covered: ReadonlySet<StorePathHash>;
}

/**
 * A verdict that is ready to materialise and the upload row from the start of
 * the pass. The row provides the values needed to fence the later clear.
 */
interface ReadyRecordedVerdict {
	readonly held: PendingUploadRow;
	readonly settle: PreparedSettle;
}

type PreparedVerdict =
	| { readonly kind: 'ready'; readonly settle: PreparedSettle }
	| { readonly kind: 'applied' }
	| { readonly kind: 'ignored' };

type PreparedWithoutDecode =
	PreparedVerdict | { readonly kind: 'requires-decode' };

type PendingReservation =
	| { readonly kind: 'reserved'; readonly generation: NarInfoGeneration }
	| { readonly kind: 'applied' }
	| { readonly kind: 'ignored' };

type FinaliseCommittedResult = 'continue' | 'applied' | 'ignored';
type PromotionResult = 'ready' | 'applied' | 'ignored';

// Terminal rows remain authoritative during their observation window.
// Overlapping verification passes must not reopen them.
function isAwaitingVerdict(
	row: typeof schema.pendingUploads.$inferSelect
): boolean {
	return row.verdict === 'pending' || row.verdict === 'committing';
}

// A lease older than `verifyClaimLeaseMs` belongs to a pass presumed dead, so
// another pass can claim the row again.
//
// A recorded verdict remains assigned to its claim owner after the lease
// expires. Sending the row to the queue consumer again would repeat the NAR
// decode. A client re-drive revokes the claim, which invalidates the recorded
// verdict and makes the row claimable again.
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
			isNull(schema.pendingUploads.recordedVerdictJson),
			isNull(schema.pendingUploads.claimOwner)
		),
		or(
			isNull(schema.pendingUploads.claimedAt),
			lte(schema.pendingUploads.claimedAt, leasedBefore)
		)
	);
}

/**
 * Builds the update that leases one chunk of pending uploads to a verification
 * pass.
 *
 * The parameter guard imports this builder and inspects the generated SQL
 * without executing it.
 */
export function buildLeaseUpdate(
	database: SchemaDatabase,
	uploadIds: readonly UploadId[],
	claimedAt: IsoTimestamp,
	owner: string
) {
	return database
		.update(schema.pendingUploads)
		.set({ claimedAt, claimOwner: owner })
		.where(inArray(schema.pendingUploads.id, uploadIds));
}

// Claims form a contiguous prefix in ID order. The row limit and cumulative
// uncompressed size of fresh rows bound the prefix. Reuse rows contribute zero
// bytes to the size. Always admit the first fresh row so a single NAR larger
// than `maxNarBytes` can make progress. `truncated` records that claimable rows
// remain.
function chunkClaims(
	pendings: readonly (typeof schema.pendingUploads.$inferSelect)[],
	limit: number,
	maxNarBytes?: number
): PendingVerificationChunk {
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

		if (
			maxNarBytes !== undefined &&
			hasFresh &&
			cost > 0 &&
			bytes + cost > maxNarBytes
		) {
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

	// Re-read the session after settlement awaits because `attachSession` can
	// move the waiter to a reconnected socket. Use the captured ID if settlement
	// has already removed the row.
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

	private async prepareRecordedVerdict(
		uploadId: UploadId,
		verification: NarVerification,
		promotion: PromotionState,
		owner: string,
		signal?: AbortSignal
	): Promise<PreparedVerdict> {
		signal?.throwIfAborted();
		const pending = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(
				and(
					eq(schema.pendingUploads.id, uploadId),
					eq(schema.pendingUploads.claimOwner, owner)
				)
			)
			.get();

		if (pending === undefined || !isAwaitingVerdict(pending)) {
			return { kind: 'ignored' };
		}

		const metadata = parseStoredUploadPathMetadata(
			pending.id,
			pending.metadataJson
		);
		const effectivePromotion: PromotionState =
			pending.r2Key === narObjectKey(metadata.narHash)
				? 'already-promoted'
				: promotion;
		const reservation = await this.reservePendingRow(
			pending,
			metadata,
			owner,
			signal
		);

		if (reservation.kind !== 'reserved') {
			return reservation;
		}
		const { generation } = reservation;

		const finalised = await this.finaliseIfAlreadyCommitted(
			pending,
			metadata,
			generation,
			owner,
			signal
		);

		if (finalised !== 'continue') {
			return { kind: finalised };
		}

		const promotionResult = await this.promoteForCommit(
			pending,
			metadata,
			generation,
			verification,
			effectivePromotion,
			owner,
			signal
		);

		if (promotionResult !== 'ready') {
			return { kind: promotionResult };
		}

		return {
			kind: 'ready',
			settle: { pending, metadata, generation, owner }
		};
	}

	private async prepareWithoutDecode(
		pending: typeof schema.pendingUploads.$inferSelect,
		owner: string,
		signal?: AbortSignal
	): Promise<PreparedWithoutDecode> {
		signal?.throwIfAborted();

		if (!this.ownsActiveClaim(owner, pending.id, signal)) {
			return { kind: 'ignored' };
		}

		const metadata = parseStoredUploadPathMetadata(
			pending.id,
			pending.metadataJson
		);
		const isReuse = pending.r2Key === narObjectKey(metadata.narHash);

		if (!isReuse) {
			const reserved = this.narInfoRow(pending.cache, metadata.storePathHash);

			if (reserved === undefined) {
				return { kind: 'requires-decode' };
			}

			const isCommitted = await this.commitPipeline.isGenerationCommitted(
				pending.cache,
				metadata,
				reserved.generation
			);

			if (!this.ownsActiveClaim(owner, pending.id, signal)) {
				return { kind: 'ignored' };
			}

			if (!isCommitted) {
				return { kind: 'requires-decode' };
			}
		} else if (!(await this.isCurrentNarPresent(metadata.narHash))) {
			throw new UploadedObjectNotFoundError(pending.r2Key);
		}

		const reservation = await this.reservePendingRow(
			pending,
			metadata,
			owner,
			signal
		);

		if (reservation.kind !== 'reserved') {
			return reservation;
		}

		const finalised = await this.finaliseIfAlreadyCommitted(
			pending,
			metadata,
			reservation.generation,
			owner,
			signal
		);

		if (finalised !== 'continue') {
			return { kind: finalised };
		}

		if (!isReuse) {
			return { kind: 'requires-decode' };
		}

		const promotion = await this.promoteForCommit(
			pending,
			metadata,
			reservation.generation,
			{ ok: true },
			'already-promoted',
			owner,
			signal
		);

		if (promotion !== 'ready') {
			return { kind: promotion };
		}

		return {
			kind: 'ready',
			settle: {
				pending,
				metadata,
				generation: reservation.generation,
				owner
			}
		};
	}

	private collectPreparedWithoutDecode(
		prepared: PreparedWithoutDecode,
		uploadId: UploadId,
		owner: string,
		ready: PreparedSettle[]
	): number {
		switch (prepared.kind) {
			case 'applied': {
				return 1;
			}
			case 'ready': {
				ready.push(prepared.settle);

				return 0;
			}
			case 'requires-decode': {
				this.releaseLease(uploadId, owner);

				return 0;
			}
			case 'ignored': {
				return 0;
			}
		}
	}

	private async reservePendingRow(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		owner: string,
		signal?: AbortSignal
	): Promise<PendingReservation> {
		if (!this.ownsActiveClaim(owner, pending.id, signal)) {
			return { kind: 'ignored' };
		}

		const reserved = await this.commitPipeline.reserveNarInfoRow(
			pending.cache,
			metadata,
			() => this.ownsActiveClaim(owner, pending.id, signal)
		);

		if (
			reserved === undefined ||
			!this.ownsActiveClaim(owner, pending.id, signal)
		) {
			return { kind: 'ignored' };
		}

		if (reserved.kind === 'lost') {
			const didApply = await this.uploadState.clearPendingUploadAndStaging(
				pending.id,
				pending.r2Key,
				metadata.narHash,
				owner
			);

			if (didApply) {
				this.notifyWaiters(pending, 'absent');
			}

			return { kind: didApply ? 'applied' : 'ignored' };
		}

		return { kind: 'reserved', generation: reserved.generation };
	}

	// A crash can leave a committed generation and its pending marker after the
	// private staging bytes have been deleted. Re-decoding that row would turn a
	// successful upload into a mismatch, so finish the remaining bookkeeping from
	// the committed reference and narinfo object.
	private async finaliseIfAlreadyCommitted(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration,
		owner: string,
		signal?: AbortSignal
	): Promise<FinaliseCommittedResult> {
		return this.context.criticalSection(() =>
			this.finaliseIfAlreadyCommittedLocked(
				pending,
				metadata,
				generation,
				owner,
				signal
			)
		);
	}

	private async finaliseIfAlreadyCommittedLocked(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration,
		owner: string,
		signal?: AbortSignal
	): Promise<FinaliseCommittedResult> {
		const isCommitted = await this.commitPipeline.isGenerationCommitted(
			pending.cache,
			metadata,
			generation
		);

		if (!this.ownsActiveClaim(owner, pending.id, signal)) {
			return 'ignored';
		}

		if (!isCommitted) {
			return 'continue';
		}

		// The flush applies captured grace after the durable charge. An interruption
		// between these operations leaves the committed generation and its pending
		// grace decision in different states. Reapply the decision before notifying
		// waiters and clearing the pending row. The identity check and monotonic
		// update make repeated application safe.
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
			return 'continue';
		}

		// Attach the run root while the confirmation's identity proof still applies.
		// The uninterrupted flush uses the same fence.
		this.commitPipeline.attachRootTarget(
			pending.cache,
			pending.attachRootName,
			metadata.storePathHash,
			metadata.storePath
		);

		if (!this.uploadState.clearPendingUpload(pending.id, owner)) {
			return 'ignored';
		}

		this.notifyWaiters(pending, 'servable');
		await this.deleteStagingObject(pending);

		return 'applied';
	}

	private async promoteForCommit(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration,
		verification: NarVerification,
		promotion: PromotionState,
		owner: string,
		signal?: AbortSignal
	): Promise<PromotionResult> {
		signal?.throwIfAborted();

		if (!verification.ok) {
			const didApply = await this.failReservedUpload(
				pending,
				metadata,
				generation,
				'mismatch',
				owner,
				signal
			);
			return didApply ? 'applied' : 'ignored';
		}

		// Stream the R2 write outside the input gate. A replacement owner reserves
		// a greater object version and cannot adopt bytes from the revoked owner.
		// Re-enter the gate to check ownership before activating the object and
		// writing `blob_state`.
		if (promotion === 'promote') {
			if (!this.ownsActiveClaim(owner, pending.id, signal)) {
				return 'ignored';
			}

			const blob =
				verification.fileHash !== undefined &&
				verification.fileSize !== undefined
					? { fileHash: verification.fileHash, fileSize: verification.fileSize }
					: undefined;
			const staged = await this.uploadState.stageStagingBlob(
				pending.r2Key,
				metadata,
				blob,
				owner,
				() => this.ownsActiveClaim(owner, pending.id, signal)
			);

			if (
				staged === undefined ||
				!this.ownsActiveClaim(owner, pending.id, signal)
			) {
				return 'ignored';
			}

			return this.context.criticalSection(async () => {
				if (!this.ownsActiveClaim(owner, pending.id, signal)) {
					return 'ignored';
				}

				const activation = await this.uploadState.commitStagingBlob(
					staged,
					() => this.ownsActiveClaim(owner, pending.id, signal)
				);

				if (activation === 'retired') {
					return 'ignored';
				}

				return this.ownsActiveClaim(owner, pending.id, signal)
					? 'ready'
					: 'ignored';
			});
		}

		return 'ready';
	}

	// A failed batch prefetch must fall back to per-path probes. One transient D1
	// fault must not abort the verification pass.
	private async prefetchedFactsFor(
		logger: Logger,
		ready: readonly PreparedSettle[],
		signal?: AbortSignal
	): Promise<
		Map<NixSha256HashString, PrefetchedMaterialisationFacts> | undefined
	> {
		try {
			signal?.throwIfAborted();
			return await raceVerificationOperation(
				this.commitPipeline.prefetchMaterialisationFacts(
					ready.map((item) => item.metadata.narHash)
				),
				signal
			);
		} catch {
			signal?.throwIfAborted();
			logger.warn(
				'prefetch materialisation facts failed; falling back to per-path probes',
				{
					kind: 'materialisation',
					count: ready.length,
					reason: 'prefetch-failed'
				}
			);
			return undefined;
		}
	}

	private async materialiseVerified(
		logger: Logger,
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration,
		prefetched: PrefetchedMaterialisationFacts | undefined,
		owner: string,
		signal?: AbortSignal
	): Promise<boolean> {
		signal?.throwIfAborted();
		// Promotion creates the object and `blob_state` row, so probe afterwards.
		const probe = await this.commitPipeline.probeMaterialisation(
			metadata,
			prefetched
		);
		signal?.throwIfAborted();

		if (!this.ownsActiveClaim(owner, pending.id, signal)) {
			return false;
		}
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
			// Check the claim again inside the charge gate. A competing pass might have
			// removed the row or recorded a terminal verdict during the earlier awaits.
			isStillSettleable: () => this.ownsActiveClaim(owner, pending.id, signal)
		});

		if (outcome.kind === 'gone' || outcome.kind === 'deferred') {
			return false;
		}

		// Over quota on the canonical size: if the probe came from a prefetch batch,
		// its `isOwned` flag may be stale (a sibling settled first and charged the
		// blob, so the tenant already owns it). Re-probe once with a fresh read and
		// retry; only a second over-quota result is terminal. The reserve and charge
		// guards are idempotent, so one retry is safe.
		if (prefetched !== undefined && outcome.kind === 'over-quota') {
			const freshProbe =
				await this.commitPipeline.probeMaterialisation(metadata);
			signal?.throwIfAborted();

			if (!this.ownsActiveClaim(owner, pending.id, signal)) {
				return false;
			}

			const retried = await this.commitPipeline.materialiseBatched(logger, {
				cache: pending.cache,
				metadata,
				generation,
				probe: freshProbe,
				mustOwnBlob: false,
				graceDecision,
				attachRootName: pending.attachRootName ?? undefined,
				isStillSettleable: () => this.ownsActiveClaim(owner, pending.id, signal)
			});

			if (retried.kind === 'gone' || retried.kind === 'deferred') {
				return false;
			}

			outcome = retried;
		}

		if (outcome.kind === 'over-quota') {
			// Reclaim the reserved narinfo row so reconciliation cannot restore a path
			// without a reference or a corresponding tenant charge.
			return this.failReservedUpload(
				pending,
				metadata,
				generation,
				'over-quota',
				owner,
				signal
			);
		}

		// Reclaim the reservation after publication stops before the charge fence.
		// This prevents a later scan from restoring a path without a reference or a
		// corresponding tenant charge.
		if (outcome.kind === 'tenant-inactive') {
			// The grace confirmation runs inside the same gated callback as the
			// identity proof: the input gate reopens the moment that callback
			// completes, so a confirmation outside it could race a delete or
			// recommit queued behind the gate.
			const reclaim = await this.context.criticalSection(async () => {
				if (!this.ownsActiveClaim(owner, pending.id, signal)) {
					return 'superseded' as const;
				}

				const result = await this.commitPipeline.reclaimReservedRow(
					pending.cache,
					metadata.storePathHash,
					generation,
					metadata.narHash,
					() => this.ownsActiveClaim(owner, pending.id, signal)
				);

				if (!this.ownsActiveClaim(owner, pending.id, signal)) {
					return 'superseded' as const;
				}

				// The winning generation must receive this upload's retention decision and
				// run-root attachment before the waiter is notified.
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
				signal?.throwIfAborted();
				const didApply = this.uploadState.clearPendingUpload(pending.id, owner);

				if (didApply) {
					this.notifyWaiters(pending, 'servable');
				}

				return didApply;
			}

			signal?.throwIfAborted();
			const didApply = await this.uploadState.clearPendingUploadAndStaging(
				pending.id,
				pending.r2Key,
				metadata.narHash,
				owner
			);

			if (!didApply) {
				return false;
			}

			this.notifyWaiters(pending, 'absent');

			// A superseded row belongs to a replacement that still holds the
			// path, so its retention targets must survive; only a genuinely
			// reclaimed path releases them.
			if (reclaim === 'reclaimed') {
				this.pruneRetentionTargets(pending.cache, metadata.storePathHash);
			}

			return true;
		}

		if (outcome.kind === 'materialised') {
			// Keep the upload row until the narinfo object is published. An interruption
			// before publication can then re-drive the commit.
			const wasPublished = await this.narInfoObjects.publishNarInfoObjectWhile(
				pending.cache,
				metadata.storePathHash,
				generation,
				metadata.narHash,
				outcome.narInfo,
				() => this.ownsActiveClaim(owner, pending.id, signal)
			);

			if (!wasPublished) {
				return false;
			}

			signal?.throwIfAborted();
			// Once the narinfo is durable, notify waiters and remove the upload row and
			// private staging bytes.
			const wasCleared = this.uploadState.clearPendingUpload(pending.id, owner);

			if (wasCleared) {
				this.notifyWaiters(pending, 'servable');
				await this.deleteStagingObject(pending);
			}

			return wasCleared;
		}

		// A concurrent commit took the path or the blob disappeared. Remove this
		// upload row; the reaper collects any unreferenced object it promoted.
		signal?.throwIfAborted();
		if (!this.uploadState.clearPendingUpload(pending.id, owner)) {
			return false;
		}

		this.notifyWaiters(pending, 'absent');
		await this.deleteStagingObject(pending);

		return true;
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

	// Do not replace a terminal verdict with a staging-cleanup failure. The orphan
	// collector will retry deletion after the upload grace period.
	private async deleteStagingObjectBestEffort(
		pending: typeof schema.pendingUploads.$inferSelect,
		signal?: AbortSignal
	): Promise<void> {
		try {
			signal?.throwIfAborted();
			await this.deleteStagingObject(pending);
		} catch {
			signal?.throwIfAborted();
			rootLogger().warn(
				'upload completed but its staging object was not deleted',
				{ kind: 'fresh', reason: 'staging-delete-failed' }
			);
		}
	}

	// Reclaim the reserved narinfo row before recording a mismatch or over-quota
	// result. If another pass committed the generation first, that pass retains
	// ownership of the upload row, root and waiter. This prevents a late failure
	// from retiring a servable path.
	private async failReservedUpload(
		pending: typeof schema.pendingUploads.$inferSelect,
		metadata: ParsedUploadPathNegotiation,
		generation: NarInfoGeneration,
		verdict: 'mismatch' | 'over-quota' = 'mismatch',
		owner: string,
		signal?: AbortSignal
	): Promise<boolean> {
		signal?.throwIfAborted();
		const reclaim = await this.context.criticalSection(async () => {
			if (!this.ownsActiveClaim(owner, pending.id, signal)) {
				return 'superseded' as const;
			}

			const result = await this.commitPipeline.reclaimReservedRow(
				pending.cache,
				metadata.storePathHash,
				generation,
				metadata.narHash,
				() => this.ownsActiveClaim(owner, pending.id, signal)
			);

			return this.ownsActiveClaim(owner, pending.id, signal)
				? result
				: ('superseded' as const);
		});

		if (reclaim === 'committed-current') {
			return false;
		}

		signal?.throwIfAborted();
		const isSettled = this.uploadState.markUploadTerminal(
			pending.id,
			verdict,
			owner
		);

		if (!isSettled) {
			return false;
		}

		// A superseded row belongs to a replacement that still holds the path,
		// so its retention targets must survive; only a genuinely reclaimed
		// path releases them.
		if (reclaim === 'reclaimed') {
			this.pruneRetentionTargets(pending.cache, metadata.storePathHash);
		}

		this.notifyWaiters(pending, verdict);
		await this.deleteStagingObjectBestEffort(pending, signal);

		return true;
	}

	// Re-check the NAR under the caller's critical section before restoring the
	// narinfo object. A delete can otherwise remove the NAR after the probe and
	// leave the restored narinfo pointing at a missing NAR.
	private async restoreNarInfoObject(
		row: typeof schema.narInfos.$inferSelect
	): Promise<number> {
		const isNarPresent = await this.isCurrentNarPresent(row.narHash);

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
				narUrl: narInfo.url,
				signatureGeneration:
					row.pendingSignatureGeneration ?? row.signatureGeneration
			},
			narInfo
		);

		return 1;
	}

	private warnSkippedRow(logger: Logger): void {
		logger.warn('narinfo row not reconciled', {
			kind: 'narinfo',
			reason: 'reconcile-failed'
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
			const isNarPresent = await this.isCurrentNarPresent(row.narHash);

			return {
				row,
				isNarPresent: isNarPresent,
				objectPresent: isNarPresent && (await isObjectPresent(row))
			};
		} catch {
			this.warnSkippedRow(logger);

			return undefined;
		}
	}

	private async isCurrentNarPresent(
		narHash: NixSha256HashString
	): Promise<boolean> {
		const state = await this.context.d1
			.select({ incarnation: d1Schema.blobState.incarnation })
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, narHash))
			.get();

		return (
			state !== undefined &&
			(await this.context.env.BLOBS.head(
				narObjectKey(narHash, state.incarnation)
			)) !== null
		);
	}

	// A targeted reconciliation checks a small set of unrelated paths, so probe
	// each narinfo object directly instead of listing a prefix.
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
		let pages = 0;

		try {
			while (!isDone) {
				if (pages === maxOutgoingConnections) {
					logger.warn(
						'narinfo object listing reached its page limit; falling back to heads'
					);

					return undefined;
				}

				const listed = await this.context.env.BLOBS.list(
					cursor === undefined ? { prefix, startAfter } : { prefix, cursor }
				);
				pages += 1;
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
		} catch {
			// A transient list fault must not abort the whole reconcile; fall back to
			// a per-row head, which keeps each row's own fault isolation.
			logger.warn('narinfo object listing failed; falling back to heads', {
				kind: 'narinfo-list',
				reason: 'list-failed'
			});

			return undefined;
		}

		return present;
	}

	/**
	 * Reads the committed reference edges for `rows` and reports which store path
	 * hashes were included in the completed queries.
	 *
	 * A deferred commit reserves its narinfo row before creating a reference
	 * edge. Requiring the edge stops reconciliation serving a reserved,
	 * unverified row. The read runs outside the gate; if a commit creates the
	 * edge afterwards, this pass leaves the row for the next scan.
	 *
	 * The read stops before a query that would exceed the D1 allowance. `covered`
	 * contains only the hashes from completed queries. Callers must defer every
	 * other row because its reference edge is unknown.
	 */
	private async committedEdgeKeys(
		rows: readonly NarInfoRow[]
	): Promise<CommittedEdges> {
		if (rows.length === 0) {
			return { keys: new Set(), covered: new Set() };
		}

		const tenant = this.context.requireTenant();
		const hashes = [...new Set(rows.map((row) => row.storePathHash))];
		const read = await executeChunkedStatement(hashes, (hashChunk) =>
			this.context.d1
				.select({
					cache: d1Schema.blobReference.cache,
					storePathHash: d1Schema.blobReference.storePathHash,
					generation: d1Schema.blobReference.generation,
					narHash: d1Schema.blobReference.narHash
				})
				.from(d1Schema.blobReference)
				.where(
					and(
						eq(d1Schema.blobReference.tenant, tenant),
						inArray(d1Schema.blobReference.storePathHash, [...hashChunk])
					)
				)
		);

		const keys = new Set<string>();

		for (const edges of read.results) {
			for (const edge of edges) {
				keys.add(
					edgeKey(edge.cache, edge.storePathHash, edge.generation, edge.narHash)
				);
			}
		}

		return { keys, covered: new Set(read.processed) };
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
		} catch {
			this.warnSkippedRow(logger);

			return 'failed';
		}

		return 'unchanged';
	}

	// Lease only the rows returned to this pass. Selection and leasing are
	// synchronous on the single writer, so another pass cannot claim them between
	// those operations.
	//
	// The largest verification page contains `maxVerificationRpcRows` uploads.
	// Split that page so each update stays within the parameter limit.
	private leaseRows(
		uploadIds: readonly UploadId[],
		now: Date,
		owner: string
	): void {
		for (const ids of chunk(uploadIds, maxInClauseValues)) {
			buildLeaseUpdate(this.context.db, ids, isoTimestamp(now), owner).run();
		}
	}

	private decodeFreeCandidatePage(
		now: Date,
		kind: DecodeFreeCandidateKind,
		after: UploadId | undefined,
		limit: number
	): PendingUploadRow[] {
		const pendingStorePathHash = sql<StorePathHash>`json_extract(${schema.pendingUploads.metadataJson}, '$.storePathHash')`;
		const matchingNarInfo = and(
			eq(schema.narInfos.cache, schema.pendingUploads.cache),
			eq(schema.narInfos.storePathHash, pendingStorePathHash)
		);
		const matchingNarInfoQuery = this.context.db
			.select({ storePathHash: schema.narInfos.storePathHash })
			.from(schema.narInfos)
			.where(matchingNarInfo);
		const canonicalR2Key = sql`${narObjectKeyPrefix} || ${schema.pendingUploads.narHash} || ${narObjectKeySuffix}`;
		const reuseCandidate = eq(schema.pendingUploads.r2Key, canonicalR2Key);
		const recoveryCandidate = and(
			ne(schema.pendingUploads.r2Key, canonicalR2Key),
			exists(matchingNarInfoQuery)
		);
		const decodeFreeCandidate =
			kind === 'reuse' ? reuseCandidate : recoveryCandidate;
		const afterCandidate =
			after === undefined ? undefined : gt(schema.pendingUploads.id, after);

		return this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(and(claimableFilter(now), decodeFreeCandidate, afterCandidate))
			.orderBy(asc(schema.pendingUploads.id))
			.limit(limit)
			.all();
	}

	private decodeFreeCandidatePageFromCursor(
		now: Date,
		kind: DecodeFreeCandidateKind,
		cursor: UploadId | undefined,
		limit: number
	): PendingUploadRow[] {
		const afterCursor = this.decodeFreeCandidatePage(now, kind, cursor, limit);

		if (cursor === undefined || afterCursor.length > 0) {
			return afterCursor;
		}

		return this.decodeFreeCandidatePage(now, kind, undefined, limit);
	}

	private async persistDecodeFreeCursor(
		cursor: DecodeFreeCursorState | undefined
	): Promise<void> {
		if (cursor === undefined) {
			await this.context.ctx.storage.delete(pendingDecodeFreeCursorKey);
			return;
		}

		await this.context.ctx.storage.put(pendingDecodeFreeCursorKey, cursor);
	}

	private async commitDecodeFreeClaim(
		candidates: readonly PendingUploadRow[],
		now: Date,
		owner: string,
		cursor: DecodeFreeCursorState | undefined,
		signal?: AbortSignal
	): Promise<void> {
		signal?.throwIfAborted();
		await raceVerificationOperation(
			this.persistDecodeFreeCursor(cursor),
			signal
		);
		signal?.throwIfAborted();
		this.leaseRows(
			candidates.map((pending) => pending.id),
			now,
			owner
		);
	}

	private async claimPendingWithoutDecode(
		limit: number,
		signal?: AbortSignal
	): Promise<{
		readonly owner: string;
		readonly reuse: readonly PendingUploadRow[];
		readonly recoveryCandidates: readonly PendingUploadRow[];
	}> {
		return this.context.criticalSection(async () => {
			signal?.throwIfAborted();
			const now = new Date();
			const owner = crypto.randomUUID();
			const storedCursor = await raceVerificationOperation(
				this.context.ctx.storage.get(pendingDecodeFreeCursorKey),
				signal
			);
			signal?.throwIfAborted();
			const cursor = parseDecodeFreeCursorState(storedCursor);
			let kind = cursor.next;
			let candidates = this.decodeFreeCandidatePageFromCursor(
				now,
				kind,
				cursor[kind],
				limit
			);

			if (candidates.length === 0) {
				kind = otherDecodeFreeCandidateKind(kind);
				candidates = this.decodeFreeCandidatePageFromCursor(
					now,
					kind,
					cursor[kind],
					limit
				);
			}

			const reuse = candidates.filter(
				(pending) => pending.r2Key === narObjectKey(pending.narHash)
			);
			const recoveryCandidates = candidates.filter(
				(pending) => pending.r2Key !== narObjectKey(pending.narHash)
			);

			const lastCandidate = candidates.at(-1);
			await this.commitDecodeFreeClaim(
				candidates,
				now,
				owner,
				lastCandidate === undefined
					? undefined
					: ({
							...cursor,
							[kind]: lastCandidate.id,
							next: otherDecodeFreeCandidateKind(kind)
						} satisfies DecodeFreeCursorState),
				signal
			);

			return { owner, reuse, recoveryCandidates };
		});
	}

	private async committedRecoveryCandidates(
		logger: Logger,
		owner: string,
		candidates: readonly PendingUploadRow[],
		signal?: AbortSignal
	): Promise<PendingUploadRow[]> {
		const classified = await mapWithConcurrency(
			candidates,
			maxOutgoingConnections,
			async (pending): Promise<PendingUploadRow | undefined> => {
				try {
					signal?.throwIfAborted();
					const metadata = parseStoredUploadPathMetadata(
						pending.id,
						pending.metadataJson
					);
					const reserved = this.narInfoRow(
						pending.cache,
						metadata.storePathHash
					);

					if (reserved === undefined) {
						this.releaseLease(pending.id, owner);
						return undefined;
					}

					const isCommitted = await raceVerificationOperation(
						this.commitPipeline.isGenerationCommitted(
							pending.cache,
							metadata,
							reserved.generation
						),
						signal
					);

					if (!this.ownsActiveClaim(owner, pending.id, signal)) {
						return undefined;
					}

					if (!isCommitted) {
						this.releaseLease(pending.id, owner);
						return undefined;
					}

					return pending;
				} catch {
					signal?.throwIfAborted();
					this.releaseLease(pending.id, owner);
					logger.warn('pending upload recovery probe failed', {
						kind: 'committed-recovery',
						reason: 'commit-state-probe-failed'
					});
					return undefined;
				}
			}
		);

		return classified.filter(
			(candidate): candidate is PendingUploadRow => candidate !== undefined
		);
	}

	// Release a claim after a transient fault so the next pass need not wait for
	// the lease to expire. A crashed pass never reaches this method; its claims
	// become available when their leases expire.
	private releaseLease(uploadId: UploadId, owner: string): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ claimedAt: sql`null`, claimOwner: sql`null` })
			.where(
				and(
					eq(schema.pendingUploads.id, uploadId),
					eq(schema.pendingUploads.claimOwner, owner)
				)
			)
			.run();
	}

	private async renewClaimsWhile<T>(
		owner: string,
		uploadIds: readonly UploadId[],
		work: (signal: AbortSignal) => Promise<T>,
		outerSignal?: AbortSignal
	): Promise<T> {
		return withRenewedVerificationClaim(
			() => {
				if (!this.renewClaimLeases(owner, uploadIds)) {
					throw new Error(
						'The verification claim is no longer owned by this pass.'
					);
				}

				return Promise.resolve();
			},
			work,
			undefined,
			outerSignal
		);
	}

	private ownsClaim(owner: string, uploadId: UploadId): boolean {
		return this.ownsClaimFor(owner, uploadId);
	}

	private ownsActiveClaim(
		owner: string,
		uploadId: UploadId,
		signal?: AbortSignal
	): boolean {
		return signal?.aborted !== true && this.ownsClaimFor(owner, uploadId);
	}

	private ownsClaimFor(owner: string, uploadId: UploadId): boolean {
		const awaitingFilter = or(
			eq(schema.pendingUploads.verdict, 'pending'),
			eq(schema.pendingUploads.verdict, 'committing')
		);
		return (
			this.context.db
				.select({ id: schema.pendingUploads.id })
				.from(schema.pendingUploads)
				.where(
					and(
						eq(schema.pendingUploads.id, uploadId),
						eq(schema.pendingUploads.claimOwner, owner),
						awaitingFilter
					)
				)
				.get() !== undefined
		);
	}

	/**
	 * Stores each accepted verdict on its upload row. An `abandoned` result
	 * releases the lease so another pass can claim the row.
	 *
	 * Every statement here runs against the Durable Object's own database, and
	 * the writes are synchronous, so the batch is durable before this returns.
	 */
	private holdVerdicts(
		owner: string,
		results: readonly VerificationResult[]
	): void {
		for (const { uploadId, verdict } of results) {
			if (!this.ownsClaim(owner, uploadId)) {
				continue;
			}

			if (verdict.kind === 'abandoned') {
				this.releaseLease(uploadId, owner);
				continue;
			}

			this.context.db
				.update(schema.pendingUploads)
				.set({
					recordedVerdictJson: JSON.stringify({
						owner,
						verdict
					} satisfies RecordedVerdict)
				})
				.where(
					and(
						eq(schema.pendingUploads.id, uploadId),
						eq(schema.pendingUploads.claimOwner, owner)
					)
				)
				.run();
		}
	}

	private heldVerdictPage(
		after: UploadId | undefined,
		limit: number
	): PendingUploadRow[] {
		return this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(
				and(
					isNotNull(schema.pendingUploads.recordedVerdictJson),
					after === undefined ? undefined : gt(schema.pendingUploads.id, after)
				)
			)
			.orderBy(asc(schema.pendingUploads.id))
			.limit(limit)
			.all();
	}

	/**
	 * Reads the upload rows for the verdicts that this pass will apply. The page
	 * starts after the cursor saved by the previous pass.
	 *
	 * A pass reads far fewer rows than a batch can contain. The rotating cursor
	 * prevents a repeatedly failing verdict from blocking every later verdict.
	 *
	 * The method clears a verdict if its owner no longer owns the row or if this
	 * build cannot parse it. Clearing either value makes the row available for a
	 * new claim. The caller applies the remaining verdicts.
	 */
	private heldVerdicts(
		after: UploadId | undefined,
		limit: number
	): HeldVerdictRow[] {
		const page = this.heldVerdictPage(after, limit);
		const rows =
			after === undefined || page.length > 0
				? page
				: this.heldVerdictPage(undefined, limit);
		const held: HeldVerdictRow[] = [];

		for (const pending of rows) {
			const parsed = parseRecordedVerdict(pending.recordedVerdictJson);

			if (parsed?.owner !== pending.claimOwner) {
				this.clearRecordedVerdict(pending);
				continue;
			}

			held.push({ pending, ...parsed });
		}

		return held;
	}

	/**
	 * Clears a recorded verdict only if the upload ID, claim owner and exact
	 * verdict text still match the values read at the start of the pass.
	 *
	 * Verdict application can await before it clears the value. During that time,
	 * a client re-drive can revoke the claim and another consumer can record a
	 * replacement. The comparison prevents this pass from deleting the
	 * replacement and leaving its row leased without a verdict. `heldVerdicts`
	 * uses the same comparison when it clears an unreadable or stale verdict.
	 */
	private clearRecordedVerdict(pending: PendingUploadRow): void {
		const { claimOwner, recordedVerdictJson } = pending;

		if (recordedVerdictJson === null) {
			return;
		}

		this.context.db
			.update(schema.pendingUploads)
			.set({ recordedVerdictJson: sql`null` })
			.where(
				and(
					eq(schema.pendingUploads.id, pending.id),
					claimOwner === null
						? isNull(schema.pendingUploads.claimOwner)
						: eq(schema.pendingUploads.claimOwner, claimOwner),
					eq(schema.pendingUploads.recordedVerdictJson, recordedVerdictJson)
				)
			)
			.run();
	}

	/**
	 * Releases the specified leases only while `owner` still owns them.
	 */
	releaseClaimLeases(owner: string, uploadIds: readonly UploadId[]): void {
		const distinctIds = [...new Set(uploadIds)];

		for (const ids of chunk(distinctIds, maxInClauseValues)) {
			this.context.db
				.update(schema.pendingUploads)
				.set({ claimedAt: sql`null`, claimOwner: sql`null` })
				.where(
					and(
						inArray(schema.pendingUploads.id, ids),
						eq(schema.pendingUploads.claimOwner, owner)
					)
				)
				.run();
		}
	}

	renewClaimLeases(owner: string, uploadIds: readonly UploadId[]): boolean {
		if (uploadIds.length === 0) {
			return true;
		}

		const distinctIds = [...new Set(uploadIds)];
		let renewed = 0;

		for (const ids of chunk(distinctIds, maxInClauseValues)) {
			renewed += this.context.db
				.update(schema.pendingUploads)
				.set({ claimedAt: isoTimestamp(new Date()) })
				.where(
					and(
						inArray(schema.pendingUploads.id, ids),
						eq(schema.pendingUploads.claimOwner, owner)
					)
				)
				.returning({ id: schema.pendingUploads.id })
				.all().length;
		}

		return renewed === distinctIds.length;
	}

	/**
	 * Reconciles the committed paths from one push. {@link verifyBatch} performs
	 * the corresponding periodic scan. The probes run outside the gate, then one
	 * short critical section applies the generation-checked repairs.
	 *
	 * The Durable Object alarm calls this method after negotiating a closure.
	 * This keeps the R2 HEAD requests used for reconciliation out of the
	 * negotiation request. Reconciliation restores a missing narinfo object or
	 * removes a path after its NAR disappears.
	 *
	 * Returns every target that still needs reconciliation. This includes targets
	 * outside the current D1 allowance and targets for which a probe or repair
	 * failed. The caller keeps them in the queue for the next pass.
	 */
	async reconcileTargets(
		logger: Logger,
		targets: readonly ReconcileTarget[],
		origin: RequestOrigin | undefined
	): Promise<readonly ReconcileTarget[]> {
		const rows = targets
			.map((target) => this.narInfoRow(target.cache, target.storePathHash))
			.filter((row): row is NarInfoRow => row !== undefined);

		if (rows.length === 0) {
			return [];
		}

		// Reserve enough D1 statements for the edge query and one removal. The pass
		// can therefore repair at least one probed row when every row needs removal.
		const probeLimit = affordableOperations(
			statementsPerReconcileProbe,
			statementsPerReconcileEdgeQuery + statementsPerReconcileRemoval
		);
		const probed = rows.slice(0, probeLimit);
		const deferred: ReconcileTarget[] = rows.slice(probeLimit);

		const observations = await mapVerificationProbes(probed, (row) =>
			this.probeRow(logger, row, (target) => this.headNarInfoObject(target))
		);
		const committedEdges = await this.committedEdgeKeys(
			reconcileCandidates(observations)
		);

		await this.context.criticalSection(async () => {
			for (const [index, row] of probed.entries()) {
				const observation = observations[index];

				// Keep the target queued when its probe throws. A later pass will probe
				// the row again.
				if (observation === undefined) {
					deferred.push(row);
					continue;
				}

				// Keep a row queued if its repair would exceed the remaining allowance
				// or if the edge query did not cover its store path hash.
				const repair = repairStatements(observation);

				if (
					repair > 0 &&
					(statementsRemaining() < repair ||
						!committedEdges.covered.has(row.storePathHash))
				) {
					deferred.push(row);
					continue;
				}

				const outcome = await this.reconcileObservation(
					logger,
					observation,
					origin,
					committedEdges.keys
				);

				if (outcome === 'failed') {
					deferred.push(row);
				}
			}
		});

		return deferred;
	}

	/**
	 * Scans one page of committed narinfos from the durable cursor, restoring a
	 * missing narinfo object and removing a path after its NAR disappears.
	 *
	 * The preceding settle pass and this scan share one D1 statement allowance.
	 * The remaining allowance determines the page size. The scan advances its
	 * cursor through every row it examines, and the next pass starts at the first
	 * unexamined row. After a failed probe, the scan revisits the row when the
	 * cursor wraps.
	 */
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

		// Reserve one probe statement per row, plus the edge query and one removal.
		// This leaves enough statements to repair at least one row. The page also
		// fits in one `IN (...)` list, so the edge query requires one statement.
		const pageLimit = Math.min(
			limit,
			maxInClauseValues,
			affordableOperations(
				statementsPerReconcileProbe,
				statementsPerReconcileEdgeQuery + statementsPerReconcileRemoval
			)
		);

		// Leave the cursor unchanged when the settle pass used the whole allowance.
		// The next invocation will start the scan at the same row.
		if (pageLimit === 0) {
			return {
				scanned: 0,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: fromHash,
				cursorCache: fromCache,
				wrapped: false
			} satisfies VerifyReport;
		}

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
			.limit(pageLimit)
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
		const observations = await mapVerificationProbes(rows, (row) =>
			this.probeRow(logger, row, resolveObjectPresent)
		);
		const committedEdges = await this.committedEdgeKeys(
			reconcileCandidates(observations)
		);

		// Apply the repairs and advance the cursor in one short critical section.
		// The section contains synchronous SQLite work and an occasional write for
		// an unhealthy row.
		return this.context.criticalSection(async () => {
			let narInfoObjectsRestored = 0;
			let danglingNarInfosRemoved = 0;
			let reconciled = 0;

			for (const [index, row] of rows.entries()) {
				const observation = observations[index];

				if (observation === undefined) {
					// A failed probe cannot determine the row's state. Advance the cursor
					// so this scan can continue; a later scan will reach the row after the
					// cursor wraps.
					reconciled = index + 1;
					continue;
				}

				// A healthy row requires no further D1 work. For an unhealthy row, stop
				// if the repair would exceed the remaining allowance or if the edge
				// query did not cover the row. Leave the cursor before that row so the
				// next scan examines it again.
				const repair = repairStatements(observation);

				if (
					repair > 0 &&
					(statementsRemaining() < repair ||
						!committedEdges.covered.has(row.storePathHash))
				) {
					break;
				}

				const outcome = await this.reconcileObservation(
					logger,
					observation,
					origin,
					committedEdges.keys
				);

				const counts = reconcileCounts(outcome);

				danglingNarInfosRemoved += counts.removed;
				narInfoObjectsRestored += counts.restored;

				reconciled = index + 1;
			}

			// A short batch reaches the end of the scan. `wrapped` reports that the
			// next pass will restart from the lowest hash in the first cache. A page
			// truncated by the allowance has not reached the end.
			const hasWrapped = reconciled === rows.length && rows.length < pageLimit;
			const last = reconciled === 0 ? undefined : rows[reconciled - 1];
			const nextCache = hasWrapped ? '' : (last?.cache ?? fromCache);
			const nextHash = hasWrapped ? '' : (last?.storePathHash ?? fromHash);
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
				scanned: reconciled,
				narInfoObjectsRestored,
				danglingNarInfosRemoved,
				cursor: nextHash,
				cursorCache: nextCache,
				wrapped: hasWrapped
			} satisfies VerifyReport;
		});
	}

	// Claim a bounded batch of fresh rows for the queue consumer to fetch and
	// decode outside the Durable Object. The single writer selects and leases the
	// rows without yielding, which prevents an overlapping alarm or cron pass from
	// claiming the same uploads.
	listPendingForVerify(
		limit: number,
		maxNarBytes: number,
		signal?: AbortSignal
	): PendingVerificationBatch {
		signal?.throwIfAborted();
		const now = new Date();
		const pendings = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(
				and(
					claimableFilter(now),
					ne(
						schema.pendingUploads.r2Key,
						sql`${narObjectKeyPrefix} || ${schema.pendingUploads.narHash} || ${narObjectKeySuffix}`
					)
				)
			)
			.orderBy(asc(schema.pendingUploads.id))
			.limit(limit + 1)
			.all();
		const batch = chunkClaims(pendings, limit, maxNarBytes);
		const owner = crypto.randomUUID();

		signal?.throwIfAborted();
		this.leaseRows(
			batch.claims.map((claim) => claim.uploadId),
			now,
			owner
		);

		return { ...batch, owner };
	}

	hasPendingUploads(): boolean {
		return (
			this.context.db
				.select({ id: schema.pendingUploads.id })
				.from(schema.pendingUploads)
				.where(claimableFilter(new Date()))
				.limit(1)
				.get() !== undefined
		);
	}

	/**
	 * Resolves up to `limit` rows that need no NAR decode. A committed fresh row
	 * can finish crash recovery from its durable reference, and a reuse row can
	 * adopt its canonical object. Other fresh rows remain for the queue consumer.
	 *
	 * The remaining D1 allowance determines the page size. Claiming removes a row
	 * from the pending set, so unclaimed rows remain available to a later pass.
	 * The durable claim cursor records where that pass should resume.
	 */
	async processPendingWithoutDecode(
		logger: Logger,
		limit: number,
		signal?: AbortSignal
	): Promise<number> {
		signal?.throwIfAborted();
		const affordable = Math.min(
			limit,
			affordableOperations(
				statementsPerPendingSettleRow,
				pendingSettlePrefetchStatements
			)
		);

		if (affordable === 0) {
			return 0;
		}

		const { owner, reuse, recoveryCandidates } =
			await this.claimPendingWithoutDecode(affordable, signal);
		const claimedIds = [...reuse, ...recoveryCandidates].map((row) => row.id);

		try {
			const committedRecovery = await this.committedRecoveryCandidates(
				logger,
				owner,
				recoveryCandidates,
				signal
			);
			signal?.throwIfAborted();
			const pendings = [...reuse, ...committedRecovery];

			let settled = 0;
			const ready: PreparedSettle[] = [];

			// Reserve each row and finish the cases that do not require a NAR decode.
			// Collect rows that need shared blob data so the service can read that data
			// in batches before materialisation.
			for (const [index, pending] of pendings.entries()) {
				try {
					signal?.throwIfAborted();
					const prepared = await this.renewClaimsWhile(
						owner,
						pendings.slice(index).map((row) => row.id),
						(claimSignal) =>
							this.prepareWithoutDecode(pending, owner, claimSignal),
						signal
					);

					settled += this.collectPreparedWithoutDecode(
						prepared,
						pending.id,
						owner,
						ready
					);
				} catch (error) {
					signal?.throwIfAborted();
					if (error instanceof UploadedObjectNotFoundError) {
						// A missing canonical object is terminal for this reuse attempt.
						if (await this.recordMissingObject(pending.id, owner, signal)) {
							settled += 1;
						}
						continue;
					}

					// Release the lease after a transient fault so another pass can retry
					// this row while the current pass continues with the others.
					this.releaseLease(pending.id, owner);
					logger.warn('could not settle pending upload without decoding', {
						kind:
							pending.r2Key === narObjectKey(pending.narHash)
								? 'reuse'
								: 'committed-recovery',
						reason: 'prepare-failed'
					});
				}
			}

			if (ready.length === 0) {
				return settled;
			}

			// Read the shared blob rows in chunks, then materialise each upload from that
			// snapshot. The charge transaction remains authoritative, and an over-quota
			// result triggers a fresh probe.
			const prefetched = await this.prefetchedFactsFor(logger, ready, signal);

			for (const [index, item] of ready.entries()) {
				try {
					signal?.throwIfAborted();
					const didApply = await this.renewClaimsWhile(
						owner,
						ready.slice(index).map((row) => row.pending.id),
						(signal) =>
							this.materialiseVerified(
								logger,
								item.pending,
								item.metadata,
								item.generation,
								prefetched?.get(item.metadata.narHash),
								item.owner,
								signal
							),
						signal
					);

					if (didApply) {
						settled += 1;
					}
				} catch {
					signal?.throwIfAborted();
					this.releaseLease(item.pending.id, owner);
					logger.warn('could not apply reuse verdict', {
						kind:
							item.pending.r2Key === narObjectKey(item.pending.narHash)
								? 'reuse'
								: 'committed-recovery',
						reason: 'materialisation-failed'
					});
				}
			}

			return settled;
		} finally {
			this.releaseClaimLeases(owner, claimedIds);
		}
	}

	/**
	 * Accepts one queue batch. It first stores every verdict in the Durable
	 * Object's SQLite database. The synchronous local writes preserve the
	 * consumer's decode results if the remaining D1 allowance covers only part of
	 * the batch.
	 *
	 * A stored verdict prevents another consumer from claiming the row and
	 * decoding the same NAR again. A later pass applies the verdict.
	 *
	 * The method applies as many verdicts as the D1 allowance permits and returns
	 * the number of settled rows. The consumer uses this count to decide whether
	 * to continue a truncated batch.
	 */
	async recordVerifications(
		logger: Logger,
		owner: string,
		results: readonly VerificationResult[],
		signal?: AbortSignal
	): Promise<number> {
		signal?.throwIfAborted();
		this.holdVerdicts(owner, results);
		signal?.throwIfAborted();

		return this.applyRecordedVerdicts(logger, signal);
	}

	/**
	 * Whether any upload row has a recorded verdict awaiting application.
	 *
	 * The alarm calls this before running the verdict drain. The query uses the
	 * Durable Object's local SQLite database.
	 */
	hasRecordedVerdicts(): boolean {
		return (
			this.context.db
				.select({ id: schema.pendingUploads.id })
				.from(schema.pendingUploads)
				.where(isNotNull(schema.pendingUploads.recordedVerdictJson))
				.limit(1)
				.get() !== undefined
		);
	}

	/**
	 * The number of upload rows with a recorded verdict awaiting application.
	 *
	 * The drain compares this count before and after each pass. Applying a verdict
	 * or discarding an inapplicable verdict reduces the count and records
	 * progress.
	 */
	recordedVerdictCount(): number {
		return this.context.db
			.select({ id: schema.pendingUploads.id })
			.from(schema.pendingUploads)
			.where(isNotNull(schema.pendingUploads.recordedVerdictJson))
			.all().length;
	}

	/**
	 * Applies recorded verdicts up to the invocation's D1 allowance. It prepares
	 * the verdicts concurrently and flushes their materialisations together.
	 *
	 * A completed attempt clears the verdict. If the attempt does not settle the
	 * row, clearing the verdict makes the row available for a new claim. An error
	 * leaves the verdict in place, so the next pass retries application without
	 * repeating the decode. The D1 binding can return such an error when the
	 * statement allowance is exhausted.
	 *
	 * Returns how many rows it settled.
	 */
	async applyRecordedVerdicts(
		logger: Logger,
		signal?: AbortSignal
	): Promise<number> {
		signal?.throwIfAborted();
		const affordable = Math.min(
			maxVerificationRpcRows,
			affordableOperations(
				statementsPerRecordedVerdict,
				pendingSettlePrefetchStatements
			)
		);

		if (affordable === 0) {
			return 0;
		}

		const after = parseUploadIdCursor(
			await this.context.ctx.storage.get(recordedVerdictCursorKey)
		);
		const held = this.heldVerdicts(after, affordable);

		if (held.length === 0) {
			await this.context.ctx.storage.delete(recordedVerdictCursorKey);

			return 0;
		}

		// Save the final upload ID in this page. The next pass starts after that ID
		// and eventually wraps to any earlier verdicts that still need application.
		const last = held.at(-1);

		if (last !== undefined) {
			await this.context.ctx.storage.put(
				recordedVerdictCursorKey,
				last.pending.id
			);
		}

		let applied = 0;
		const ready: ReadyRecordedVerdict[] = [];

		await mapWithConcurrency(
			held,
			maxOutgoingConnections,
			async ({ pending, owner, verdict }) => {
				try {
					signal?.throwIfAborted();

					if (verdict.kind === 'missing') {
						if (await this.recordMissingObject(pending.id, owner, signal)) {
							applied += 1;
						}
						this.clearRecordedVerdict(pending);
						return;
					}

					const verification: NarVerification =
						verdict.kind === 'promoted' ? { ok: true } : verdict.verification;
					const promotion: PromotionState =
						verdict.kind === 'promoted' ? 'already-promoted' : 'promote';
					const prepared = await this.prepareRecordedVerdict(
						pending.id,
						verification,
						promotion,
						owner,
						signal
					);

					if (prepared.kind === 'applied') {
						applied += 1;
						this.clearRecordedVerdict(pending);
						return;
					}

					if (prepared.kind === 'ignored') {
						this.clearRecordedVerdict(pending);
						return;
					}

					ready.push({ held: pending, settle: prepared.settle });
				} catch (error) {
					signal?.throwIfAborted();
					if (error instanceof UploadedObjectNotFoundError) {
						if (await this.recordMissingObject(pending.id, owner, signal)) {
							applied += 1;
						}
						this.clearRecordedVerdict(pending);
						return;
					}

					logger.warn('verification verdict not applied', {
						kind: 'fresh',
						reason: 'prepare-failed'
					});
				}
			}
		);
		signal?.throwIfAborted();

		if (ready.length === 0) {
			return applied;
		}

		// Read the shared blob rows in chunks, then materialise each surviving upload
		// from that snapshot.
		const prefetched = await this.prefetchedFactsFor(
			logger,
			ready.map((entry) => entry.settle),
			signal
		);

		await mapWithConcurrency(ready, maxOutgoingConnections, async (entry) => {
			const item = entry.settle;
			try {
				signal?.throwIfAborted();
				const didApply = await this.materialiseVerified(
					logger,
					item.pending,
					item.metadata,
					item.generation,
					prefetched?.get(item.metadata.narHash),
					item.owner,
					signal
				);

				if (didApply) {
					applied += 1;
				}

				this.clearRecordedVerdict(entry.held);
			} catch {
				signal?.throwIfAborted();
				logger.warn('verification verdict not applied', {
					kind: 'fresh',
					reason: 'materialisation-failed'
				});
			}
		});
		signal?.throwIfAborted();

		return applied;
	}

	// A missing private staging object is a terminal mismatch because those bytes
	// cannot reappear. A missing shared object does not invalidate the client's NAR,
	// so remove the reuse row and report `absent` to trigger a new upload.
	async recordMissingObject(
		uploadId: UploadId,
		owner: string,
		signal?: AbortSignal
	): Promise<boolean> {
		signal?.throwIfAborted();
		const pending = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(
				and(
					eq(schema.pendingUploads.id, uploadId),
					eq(schema.pendingUploads.claimOwner, owner)
				)
			)
			.get();

		if (pending === undefined || !isAwaitingVerdict(pending)) {
			return false;
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
					if (!this.ownsActiveClaim(owner, pending.id, signal)) {
						return 'superseded' as const;
					}

					const result = await this.commitPipeline.reclaimReservedRow(
						pending.cache,
						metadata.storePathHash,
						reserved.generation,
						metadata.narHash,
						() => this.ownsActiveClaim(owner, pending.id, signal)
					);

					if (!this.ownsActiveClaim(owner, pending.id, signal)) {
						return 'superseded' as const;
					}

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

				if (!this.ownsActiveClaim(owner, pending.id, signal)) {
					return false;
				}

				// A concurrent pass has already committed this generation, so this
				// missing verdict is stale. Clear the pending row and report `servable`
				// to the waiter without pruning the path's root.
				if (reclaim === 'committed-current') {
					signal?.throwIfAborted();
					const didApply = this.uploadState.clearPendingUpload(
						pending.id,
						owner
					);

					if (didApply) {
						this.notifyWaiters(pending, 'servable');
					}

					return didApply;
				}
			}

			signal?.throwIfAborted();
			const didApply = await this.uploadState.clearPendingUploadAndStaging(
				pending.id,
				pending.r2Key,
				metadata.narHash,
				owner
			);

			if (!didApply) {
				return false;
			}

			this.notifyWaiters(pending, 'absent');

			// A superseded or recommitted row still holds the path, so its
			// retention targets must survive; only a genuinely reclaimed path
			// releases them.
			if (reclaim === 'reclaimed') {
				this.pruneRetentionTargets(pending.cache, metadata.storePathHash);
			}

			return true;
		}

		signal?.throwIfAborted();
		const isSettled = this.uploadState.markUploadTerminal(
			pending.id,
			'mismatch',
			owner
		);

		if (!isSettled) {
			return false;
		}
		this.pruneRetentionTargets(pending.cache, metadata.storePathHash);
		this.notifyWaiters(pending, 'mismatch');
		await this.deleteStagingObjectBestEffort(pending, signal);

		return true;
	}
}
