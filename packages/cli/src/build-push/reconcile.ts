import {
	type Nix,
	type NixBuildResult,
	type NixDerivedPathString,
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from '@cupboard/nix';
import {
	type RootName,
	storePathSchema,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import {
	autoBuildStore,
	buildReceiptV3Schema,
	type BuildSubjectV3,
	type DerivationPath,
	type NixStoreUri,
	type ParsedBuildReceiptV3,
	type TargetFailureReason,
	type TargetOutcome,
	type TerminalBuildFailure
} from '@cupboard/protocol/build';
import {
	commitBatchMaxEntries,
	type ParsedUploadDecision,
	type UploadAttachRoot
} from '@cupboard/protocol/upload';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import type { CommitOptions } from '../client/client.ts';
import { PushNarMetadataMismatchError } from '../errors.ts';
import { compressNarToStream } from '../nix/blob.ts';
import { NarArchive, type NarDigest } from '../nix/nar.ts';
import { prepareStorePathNegotiation } from '../nix/nix-store.ts';
import { exactUploadDecisions } from '../push/negotiation.ts';
import { publishedSubjects } from '../push/origin.ts';
import {
	type CompressNar,
	defaultUploadConcurrency,
	type PushClient,
	type PushNarArchive
} from '../push/push.ts';

import type { BatchPathOutcome } from './batching.ts';

/**
 * One manifest target as reconciliation sees it: the installable the build
 * realises, the output path Nix could predict before building, and the
 * retention root this target contributes to when the run declares one.
 */
export interface ReconcileTarget {
	readonly installable: NixDerivedPathString;
	readonly expectedPath?: StorePathString;
	readonly root?: RootName;
}

/**
 * The publication split the planner settled before the build. Reconciliation
 * treats it as authoritative: a target the planner left upstream stays left
 * upstream even when another target's build realised it, so root contents do
 * not depend on which targets share a run.
 */
export interface ReconcilePartition {
	readonly attachOnly: readonly StorePathString[];
	readonly publishByReference: readonly StorePathString[];
	readonly leftUpstream: readonly StorePathString[];
	readonly counts: {
		readonly willBuild: number;
		readonly willSubstitute: number;
		readonly unknown: number;
	};
	readonly downloadSize: number;
	readonly narSize: number;
}

/**
 * The derivation graph captured before the build: the derivation each
 * installable resolved to, and how long the evaluation that captured it took,
 * recorded in the receipt because a cold evaluation on a large flake costs
 * minutes.
 */
export interface DerivationSnapshot {
	readonly derivations: ReadonlyMap<NixDerivedPathString, DerivationPath>;
	readonly evaluationTimeMs?: number;
}

export interface ReconcileOptions {
	readonly targets: readonly ReconcileTarget[];
	readonly partition?: ReconcilePartition;
	/**
	The streaming session's terminal per-path outcomes.
	*/
	readonly outcomes: ReadonlyMap<StorePathString, BatchPathOutcome>;
	/**
	Paths that failed to publish during streaming and await reconciliation.
	*/
	readonly candidates: readonly StorePathString[];
	readonly snapshot: DerivationSnapshot;
	/**
	Exact per-target results when the run drove the build itself.
	*/
	readonly buildResults?: readonly NixBuildResult[];
	/**
	Paths published alongside the targets without joining any target root.
	*/
	readonly intermediatePaths?: readonly StorePathString[];
	readonly store: Pick<
		Nix,
		'queryValidPathsInfo' | 'queryDerivationOutputPaths'
	>;
	readonly client: PushClient;
	/**
	The run root re-driven publications bind at negotiate, exactly as a flush does.
	*/
	readonly runRoot?: UploadAttachRoot;
	readonly ttlSeconds?: TtlSeconds;
	/**
	Whether deferred verification verdicts are awaited; defaults to true.
	*/
	readonly wait?: boolean;
	readonly commitOptions?: CommitOptions;
	readonly createNarArchive?: (storePath: string) => PushNarArchive;
	readonly compressNar?: CompressNar;
	readonly uploadConcurrency?: number;
	readonly childExitStatus?: number;
	readonly terminalFailure?: TerminalBuildFailure;
	/**
	 * The subjects the run attributed to its own build. The receipt describes
	 * every other published path from that path's store metadata.
	 */
	readonly subjects?: readonly BuildSubjectV3[];
	/**
	The stores the run watched each path being copied from.
	*/
	readonly copiedFrom?: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
}

/**
One declared target root's reconciliation: replaced, or left untouched.
*/
export interface ReconciledRoot {
	readonly root: RootName;
	readonly applied: boolean;
	readonly targets: readonly StorePathString[];
}

/**
 * One path whose publication the run could not complete, with the failure that
 * stopped it, kept so the command layer can classify the run's exit.
 */
export interface ReconcileFailure {
	readonly storePath: StorePathString;
	readonly reason: TargetFailureReason;
	readonly cause: unknown;
}

export interface ReconcileResult {
	readonly receipt: ParsedBuildReceiptV3;
	readonly roots: readonly ReconciledRoot[];
	readonly failures: readonly ReconcileFailure[];
}

// How the planner classified one target before the build. A `publish` target is
// this run's to realise and publish; every other classification was decided
// before the build.
type TargetClassification =
	'publish' | 'attach-only' | 'publish-by-reference' | 'left-upstream';

type TargetResolution =
	| { readonly kind: 'resolved'; readonly paths: readonly StorePathString[] }
	| { readonly kind: 'build-failed'; readonly message?: string };

interface ResolvedTarget {
	readonly target: ReconcileTarget;
	readonly classification: TargetClassification;
	readonly resolution: TargetResolution;
}

// The store path an outcome reports for a target that realised nothing: the
// predicted output path when there was one, otherwise the derivation part of
// the installable, which is itself a store path.
function fallbackPath(target: ReconcileTarget): StorePathString {
	if (target.expectedPath !== undefined) {
		return target.expectedPath;
	}

	const [derivation] = target.installable.split('^', 1);

	return storePathSchema.parse(derivation);
}

function classify(
	target: ReconcileTarget,
	partition: ReconcilePartition | undefined
): TargetClassification {
	const path = target.expectedPath;

	if (partition === undefined || path === undefined) {
		return 'publish';
	}

	if (partition.leftUpstream.includes(path)) {
		return 'left-upstream';
	}

	if (partition.attachOnly.includes(path)) {
		return 'attach-only';
	}

	if (partition.publishByReference.includes(path)) {
		return 'publish-by-reference';
	}

	return 'publish';
}

// Resolves one target to the output paths the selected store registered for it.
// Three sources are tried in order: the build result when the run drove the
// build itself, then the outputs the store reports for the snapshot's
// derivation, then the pre-build prediction.
async function resolveTarget(
	target: ReconcileTarget,
	options: ReconcileOptions,
	buildResultByTarget: ReadonlyMap<NixDerivedPathString, NixBuildResult>
): Promise<TargetResolution> {
	const result = buildResultByTarget.get(target.installable);

	if (result !== undefined) {
		if (!('outputs' in result.outcome)) {
			return { kind: 'build-failed', message: result.outcome.message };
		}

		return {
			kind: 'resolved',
			paths: Object.values(result.outcome.outputs).toSorted(byCodeUnit)
		};
	}

	const derivation = options.snapshot.derivations.get(target.installable);

	if (derivation !== undefined) {
		const outputs = await queryRegisteredOutputs(options.store, derivation);

		if (outputs.length > 0) {
			return { kind: 'resolved', paths: outputs };
		}
	}

	if (target.expectedPath !== undefined) {
		return { kind: 'resolved', paths: [target.expectedPath] };
	}

	return { kind: 'build-failed' };
}

// A derivation with no registered outputs answers an empty list; a store that
// refuses the query for an unregistered derivation answers the same way, so a
// later source can still resolve the target.
async function queryRegisteredOutputs(
	store: ReconcileOptions['store'],
	derivation: DerivationPath
): Promise<readonly StorePathString[]> {
	try {
		const outputs = await store.queryDerivationOutputPaths([derivation]);

		return outputs.map((output) => storePathSchema.parse(output));
	} catch {
		return [];
	}
}

function assertNarMetadata(info: NixValidPathInfo, digest: NarDigest): void {
	const expected = info.narHash.toString();
	const actual = digest.narHash.toString();

	if (expected === actual && info.narSize === digest.narSize) {
		return;
	}

	throw new PushNarMetadataMismatchError(
		info.storePath,
		expected,
		actual,
		info.narSize,
		digest.narSize
	);
}

// The mutable record the publication pass fills in: which paths ended
// servable, which this run published, which failed and why, and which
// intermediates the store collected before publication.
interface PublicationLedger {
	readonly servable: Set<StorePathString>;
	readonly published: Set<StorePathString>;
	readonly failures: Map<
		StorePathString,
		{ readonly reason: TargetFailureReason; readonly cause: unknown }
	>;
	readonly collected: Set<StorePathString>;
}

function recordFailure(
	ledger: PublicationLedger,
	storePath: StorePathString,
	reason: TargetFailureReason,
	cause: unknown
): void {
	if (ledger.failures.has(storePath)) {
		return;
	}

	ledger.failures.set(storePath, { reason, cause });
}

// Whether a NAR read failed because the store no longer holds the path: the
// store client's typed refusal, or the filesystem's for a read that started
// after the path was collected.
function isVanishedPathError(error: unknown): boolean {
	if (error instanceof NixStorePathNotFoundError) {
		return true;
	}

	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// A path the local store no longer holds: collected for an intermediate, a
// failure for a target, unless the streaming session already confirmed it
// against the destination, in which case its local copy is no longer needed.
function settleLocallyMissing(
	storePath: StorePathString,
	isTarget: boolean,
	options: ReconcileOptions,
	ledger: PublicationLedger
): void {
	const streamed = options.outcomes.get(storePath);

	if (
		streamed?.outcome === 'published' ||
		streamed?.outcome === 'destination-served'
	) {
		ledger.servable.add(storePath);
		return;
	}

	if (isTarget) {
		recordFailure(ledger, storePath, 'collected', undefined);
		return;
	}

	ledger.collected.add(storePath);
}

type PublishableDecision = Extract<
	ParsedUploadDecision,
	{ action: 'upload' | 'commit' }
>;

// Publishes one negotiated path the way a streaming flush does: stream and
// check the NAR for an upload decision, then commit, awaiting a deferred
// verdict when the run waits. A path that vanished mid-read settles as
// locally missing; an upload loss and a verification loss are recorded under
// their own reasons so a build failure can never be mistaken for either.
async function publishDecision(
	decision: PublishableDecision,
	info: NixValidPathInfo,
	isTarget: boolean,
	options: ReconcileOptions,
	ledger: PublicationLedger
): Promise<void> {
	const compressNar = options.compressNar ?? compressNarToStream;
	const createNarArchive =
		options.createNarArchive ??
		((storePath: string) => new NarArchive(storePath));

	if (decision.action === 'upload') {
		try {
			const upload = compressNar(createNarArchive(info.storePath));

			await options.client.uploadNar(decision.r2Key, upload.body);
			assertNarMetadata(info, upload.digest());
		} catch (error) {
			if (isVanishedPathError(error)) {
				settleLocallyMissing(info.storePath, isTarget, options, ledger);
				return;
			}

			ledger.published.delete(info.storePath);
			recordFailure(ledger, info.storePath, 'upload', error);
			return;
		}
	}

	try {
		const outcome = await options.client.commit(
			{
				uploadId: decision.uploadId,
				storePathHash: decision.storePathHash,
				narHash: decision.narHash
			},
			options.commitOptions ?? {}
		);

		if (outcome.status !== 'already-present') {
			ledger.published.add(info.storePath);
		}

		if (outcome.status === 'pending' && options.wait === false) {
			return;
		}

		await outcome.settled;
		ledger.servable.add(info.storePath);
	} catch (error) {
		ledger.published.delete(info.storePath);
		recordFailure(ledger, info.storePath, 'verification', error);
	}
}

async function publishInfoBatch(
	infos: readonly NixValidPathInfo[],
	required: ReadonlyMap<StorePathString, boolean>,
	options: ReconcileOptions,
	ledger: PublicationLedger
): Promise<void> {
	const paths = infos.map((info) => prepareStorePathNegotiation(info));
	let decisions: readonly ParsedUploadDecision[];

	try {
		const negotiation = await options.client.negotiate({
			paths,
			...(options.runRoot !== undefined && { attachRoot: options.runRoot })
		});

		decisions = exactUploadDecisions(paths, negotiation.uploads);
	} catch (error) {
		for (const info of infos) {
			recordFailure(ledger, info.storePath, 'upload', error);
		}

		return;
	}

	const infoByHash = new Map(
		infos.map((info) => [StorePath.hash(info.storePath), info])
	);
	const publishable: {
		readonly decision: PublishableDecision;
		readonly info: NixValidPathInfo;
	}[] = [];

	for (const decision of decisions) {
		const info = infoByHash.get(decision.storePathHash);

		if (info === undefined) {
			continue;
		}

		if (decision.action === 'skip') {
			ledger.servable.add(info.storePath);
			continue;
		}

		publishable.push({ decision, info });
	}

	await mapWithConcurrency(
		publishable,
		options.uploadConcurrency ?? defaultUploadConcurrency,
		({ decision, info }) =>
			publishDecision(
				decision,
				info,
				required.get(info.storePath) === true,
				options,
				ledger
			)
	);
}

// Re-queries the destination for every path that must be available when the
// run completes. A path already uploaded during the build receives a cheap
// skip decision. A failed streaming upload instead goes through the ordinary
// upload and commit steps. Each negotiation covers a bounded batch, so one
// failed response does not prevent later batches from being published.
//
// The function returns the store metadata it read so the receipt can describe
// every published path without querying the store again.
async function publishRequired(
	required: ReadonlyMap<StorePathString, boolean>,
	options: ReconcileOptions,
	ledger: PublicationLedger
): Promise<readonly NixValidPathInfo[]> {
	if (required.size === 0) {
		return [];
	}

	let infos: readonly NixValidPathInfo[];

	try {
		infos = await options.store.queryValidPathsInfo(required.keys().toArray());
	} catch (error) {
		for (const storePath of required.keys()) {
			recordFailure(ledger, storePath, 'upload', error);
		}

		return [];
	}

	const present = new Set(infos.map((info) => info.storePath));

	for (const [storePath, isTarget] of required) {
		if (!present.has(storePath)) {
			settleLocallyMissing(storePath, isTarget, options, ledger);
		}
	}

	for (const batch of chunk(infos, commitBatchMaxEntries)) {
		await publishInfoBatch(batch, required, options, ledger);
	}

	return infos;
}

function targetOutcome(
	resolved: ResolvedTarget,
	ledger: PublicationLedger
): TargetOutcome {
	const { target, classification, resolution } = resolved;

	if (classification === 'left-upstream') {
		return { outcome: 'left-upstream', storePath: fallbackPath(target) };
	}

	if (classification === 'attach-only') {
		return { outcome: 'destination-served', storePath: fallbackPath(target) };
	}

	if (classification === 'publish-by-reference') {
		return {
			outcome: 'published-by-reference',
			storePath: fallbackPath(target)
		};
	}

	if (resolution.kind === 'build-failed') {
		return {
			outcome: 'failed',
			storePath: fallbackPath(target),
			reason: 'build'
		};
	}

	for (const path of resolution.paths) {
		const failure = ledger.failures.get(path);

		if (failure !== undefined) {
			return { outcome: 'failed', storePath: path, reason: failure.reason };
		}
	}

	const isPublished = resolution.paths.some((path) =>
		ledger.published.has(path)
	);
	const [first] = resolution.paths;

	if (first === undefined) {
		return {
			outcome: 'failed',
			storePath: fallbackPath(target),
			reason: 'build'
		};
	}

	return isPublished
		? { outcome: 'built', storePath: first }
		: { outcome: 'destination-served', storePath: first };
}

// Whether a target is confirmed: every target of a declared root must be
// confirmed before the root is replaced. A target the planner classified as
// anything other than `publish` was decided before the build, so it counts as
// confirmed without this run publishing anything for it. That includes a
// left-upstream target, which the destination deliberately does not serve and
// which contributes nothing to the root's contents.
function isConfirmed(
	resolved: ResolvedTarget,
	ledger: PublicationLedger
): boolean {
	if (resolved.classification !== 'publish') {
		return true;
	}

	if (resolved.resolution.kind === 'build-failed') {
		return false;
	}

	return resolved.resolution.paths.every((path) => ledger.servable.has(path));
}

// The paths a target resolves to, whichever cache ends up serving them.
function answeredPathsOf(resolved: ResolvedTarget): readonly StorePathString[] {
	if (resolved.resolution.kind === 'resolved') {
		return resolved.resolution.paths;
	}

	return [fallbackPath(resolved.target)];
}

// The paths a target contributes to its root's contents: what the destination
// is to hold on the root's behalf. A left-upstream target contributes nothing,
// because a consumer fetches it from elsewhere.
function rootContentsOf(resolved: ResolvedTarget): readonly StorePathString[] {
	if (resolved.classification === 'left-upstream') {
		return [];
	}

	return answeredPathsOf(resolved);
}

// Replaces the target list of each declared target root once every one of its
// targets is confirmed, in a single call per root, with the paths the
// destination is to hold; a root with any unconfirmed target is left exactly as
// it was. When every target of a root was left upstream the new list is empty,
// which releases the paths the root previously retained. The run root is not
// among these roots: it was bound at negotiate, commit by commit, and
// reconciliation does not touch it.
async function applyTargetRoots(
	resolvedTargets: readonly ResolvedTarget[],
	options: ReconcileOptions,
	ledger: PublicationLedger
): Promise<readonly ReconciledRoot[]> {
	const groups = new Map<RootName, ResolvedTarget[]>();

	for (const resolved of resolvedTargets) {
		const root = resolved.target.root;

		if (root === undefined) {
			continue;
		}

		const group = groups.get(root) ?? [];
		group.push(resolved);
		groups.set(root, group);
	}

	const roots: ReconciledRoot[] = [];

	for (const [root, group] of groups) {
		const targets = new Set(group.flatMap((item) => rootContentsOf(item)))
			.values()
			.toArray();
		const answered = group.flatMap((item) => answeredPathsOf(item));

		if (group.some((item) => !isConfirmed(item, ledger))) {
			roots.push({ root, applied: false, targets });
			continue;
		}

		try {
			await options.client.setRoot(root, {
				targets: [...targets],
				...(options.ttlSeconds !== undefined && {
					ttlSeconds: options.ttlSeconds
				})
			});
			roots.push({ root, applied: true, targets });
		} catch (error) {
			// Recorded against every path the group's targets answer for, not
			// just the settled contents, so a root that settles over nothing
			// still reports the refusal against the targets it was declared for.
			for (const storePath of answered) {
				recordFailure(ledger, storePath, 'retention', error);
			}

			roots.push({ root, applied: false, targets });
		}
	}

	return roots;
}

/**
 * The final reconciliation of a supervised build: resolves the manifest's
 * targets to their output paths in the selected store, re-queries the
 * destination so already uploaded paths are cheap no-ops, re-drives what
 * streaming lost, waits for deferred verification, applies each declared
 * target root only when every one of its targets confirmed servable, and
 * writes the receipt that records how the run ended. Streaming is an
 * optimisation over this explicit final state, never the source of truth.
 */
export async function reconcileBuild(
	options: ReconcileOptions
): Promise<ReconcileResult> {
	const buildResultByTarget = new Map(
		(options.buildResults ?? []).map((result) => [result.target, result])
	);
	const resolvedTargets: ResolvedTarget[] = [];

	for (const target of options.targets) {
		resolvedTargets.push({
			target,
			classification: classify(target, options.partition),
			resolution: await resolveTarget(target, options, buildResultByTarget)
		});
	}

	// Everything the run must end with servable, in one deduplicated pass: the
	// publish targets' resolved paths, every accepted event's path whether or
	// not its streaming settled, and the declared intermediates. The flag records
	// whether the path belongs to a target, which decides how a vanished copy is
	// reported.
	const required = new Map<StorePathString, boolean>();
	const requireAll = (
		paths: Iterable<StorePathString>,
		isTarget: boolean
	): void => {
		for (const path of paths) {
			required.set(path, required.get(path) === true || isTarget);
		}
	};

	for (const resolved of resolvedTargets) {
		if (
			resolved.classification === 'publish' &&
			resolved.resolution.kind === 'resolved'
		) {
			requireAll(resolved.resolution.paths, true);
		}
	}

	requireAll(options.outcomes.keys(), false);
	requireAll(options.candidates, false);
	requireAll(options.intermediatePaths ?? [], false);

	const ledger: PublicationLedger = {
		servable: new Set(),
		published: new Set(),
		failures: new Map(),
		collected: new Set()
	};

	// A path the streaming session published counts as published by this run; the
	// re-query below confirms that each such path is servable.
	for (const [storePath, streamed] of options.outcomes) {
		if (streamed.outcome === 'published') {
			ledger.published.add(storePath);
		}
	}

	const infos = await publishRequired(required, options, ledger);
	const built = new Map(
		(options.subjects ?? []).map((subject) => [subject.storePath, subject])
	);

	const roots = await applyTargetRoots(resolvedTargets, options, ledger);
	const partition = options.partition;
	const receipt = buildReceiptV3Schema.parse({
		version: 3,
		paths: [...ledger.servable].toSorted(byCodeUnit),
		subjects: publishedSubjects({
			described: built,
			infos,
			servable: ledger.servable,
			buildStore: autoBuildStore,
			copiedFrom: options.copiedFrom ?? new Map()
		}),
		outcomes: resolvedTargets.map((resolved) =>
			targetOutcome(resolved, ledger)
		),
		...(partition !== undefined && {
			planner: {
				willBuild: partition.counts.willBuild,
				willSubstitute: partition.counts.willSubstitute,
				unknown: partition.counts.unknown,
				attached: partition.attachOnly.length,
				adopted: partition.publishByReference.length,
				leftUpstream: partition.leftUpstream.length
			},
			substitutable: {
				downloadSize: partition.downloadSize,
				narSize: partition.narSize
			}
		}),
		...(options.snapshot.evaluationTimeMs !== undefined && {
			evaluationTimeMs: options.snapshot.evaluationTimeMs
		}),
		...(options.childExitStatus !== undefined && {
			childExitStatus: options.childExitStatus
		}),
		...(options.terminalFailure !== undefined && {
			terminalFailure: options.terminalFailure
		}),
		uploaded: [...ledger.published].toSorted(byCodeUnit),
		failed: ledger.failures.keys().toArray().toSorted(byCodeUnit),
		collected: [...ledger.collected].toSorted(byCodeUnit)
	});

	return {
		receipt,
		roots,
		failures: [...ledger.failures].map(([storePath, failure]) => ({
			storePath,
			reason: failure.reason,
			cause: failure.cause
		}))
	};
}
