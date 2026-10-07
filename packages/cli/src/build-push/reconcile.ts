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
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	autoBuildStore,
	type BuildReceiptV3,
	buildReceiptV3Schema,
	type BuildSubjectV3Input,
	type DerivationPath,
	type NixStoreUri,
	type TargetFailureReason,
	type TargetOutcomeInput,
	type TerminalBuildFailureInput
} from '@cupboard/protocol/build';
import type { RootRetentionRequest } from '@cupboard/protocol/retention';
import {
	type UploadAttachRootInput,
	type UploadDecision
} from '@cupboard/protocol/upload';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import type { CommitOptions } from '../client/client.ts';
import type { CommitOutcome, CommitSession } from '../client/commit-socket.ts';
import { commitOverSession } from '../client/commit-via.ts';
import {
	PushNarMetadataMismatchError,
	UploadVerificationFailedError
} from '../errors.ts';
import { compressNarToStream } from '../nix/blob.ts';
import { NarArchive, type NarDigest } from '../nix/nar.ts';
import { prepareStorePathNegotiation } from '../nix/nix-store.ts';
import {
	exactUploadDecisions,
	type NegotiatedPath,
	publishJustInTime
} from '../push/negotiation.ts';
import { publishedSubjects } from '../push/origin.ts';
import {
	type CompressNar,
	defaultUploadConcurrency,
	type PushClient,
	type PushNarArchive
} from '../push/push.ts';
import { sendUpload, type UploadClock } from '../push/upload-transfer.ts';

import type { BatchPathOutcome } from './batching.ts';
import { requireMatchingBuildOutput } from './divergence.ts';

export interface ReconcileTarget {
	readonly installable: NixDerivedPathString;
	readonly expectedPath?: StorePathString;
	readonly root?: RootName;
}

/**
 * Preserves the planner's pre-build classifications. `leftUpstream` remains
 * authoritative even if another target realises the same path during this
 * build, keeping root contents independent of which targets share a cohort.
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

export interface DerivationSnapshot {
	readonly derivations: ReadonlyMap<NixDerivedPathString, DerivationPath>;
	/**
	 * Recorded in the receipt because a cold evaluation of a large flake can take
	 * minutes and form a material part of the run's cost.
	 */
	readonly evaluationTimeMs?: number;
}

export interface ReconcileOptions {
	readonly targets: readonly ReconcileTarget[];
	readonly partition?: ReconcilePartition;
	readonly outcomes: ReadonlyMap<StorePathString, BatchPathOutcome>;
	readonly candidates: readonly StorePathString[];
	readonly snapshot: DerivationSnapshot;
	readonly buildResults?: readonly NixBuildResult[];
	readonly intermediatePaths?: readonly StorePathString[];
	readonly store: Pick<
		Nix,
		'queryValidPathsInfo' | 'queryDerivationOutputPaths'
	>;
	readonly client: PushClient;
	readonly runRoot?: UploadAttachRootInput;
	readonly retention?: RootRetentionRequest;
	readonly wait?: boolean;
	readonly commitOptions?: CommitOptions;
	/**
	 * Reuse the streaming phase's commit session so the server applies one credit
	 * budget across all phases.
	 */
	readonly session?: CommitSession;
	readonly createNarArchive?: (storePath: string) => PushNarArchive;
	readonly compressNar?: CompressNar;
	readonly uploadConcurrency?: number;
	/**
	Times uploads and schedules their renewals. Defaults to the system clock.
	*/
	readonly uploadClock?: UploadClock;
	readonly onUploaded?: (
		storePath: StorePathString,
		durationMs: number
	) => void;
	readonly childExitStatus?: number;
	readonly terminalFailure?: TerminalBuildFailureInput;
	/**
	 * Subjects established before reconciliation take precedence over store
	 * metadata read afterward.
	 */
	readonly subjects?: readonly BuildSubjectV3Input[];
	readonly copiedFrom?: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
}

export interface ReconciledRoot {
	readonly root: RootName;
	readonly applied: boolean;
	readonly targets: readonly StorePathString[];
}

export interface ReconcileFailure {
	readonly storePath: StorePathString;
	readonly reason: TargetFailureReason;
	readonly cause: unknown;
}

export interface ReconcileResult {
	readonly receipt: BuildReceiptV3;
	readonly roots: readonly ReconciledRoot[];
	readonly failures: readonly ReconcileFailure[];
}

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

// When a target produces no output, report its predicted path if available;
// otherwise report the derivation portion of the installable.
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

// Resolve in order from the direct build result, outputs registered for the
// pre-build derivation, then the predicted path. A prediction must not override
// an observed build result.
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

// A store may return no outputs or reject an unregistered derivation. Treat
// both as unavailable evidence so resolution can try the predicted path.
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

// Track final availability separately from paths published by this run.
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

// A source store can report collection through its typed error or through
// `ENOENT` when a filesystem NAR read starts after the path disappears.
function isVanishedPathError(error: unknown): boolean {
	if (error instanceof NixStorePathNotFoundError) {
		return true;
	}

	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// Destination confirmation makes loss of the local copy harmless. Otherwise,
// report a missing target as failed and a missing intermediate as collected.
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
	UploadDecision,
	{ action: 'upload' | 'commit' }
>;

async function isBuildOutputServed(
	info: NixValidPathInfo,
	client: PushClient
): Promise<boolean> {
	const paths = [prepareStorePathNegotiation(info)];
	const preview = await client.preview({ paths });
	const [decision] = exactUploadDecisions(paths, preview.uploads);

	if (decision?.action !== 'skip') {
		return false;
	}

	requireMatchingBuildOutput(info, { ...decision, action: 'skip' });
	return true;
}

// The verdict for an acknowledged commit, or the error that refused the
// commit itself.
type Verdict =
	| { readonly kind: 'servable' }
	| { readonly kind: 'failed'; readonly error: unknown };

interface AcknowledgedPath {
	readonly info: NixValidPathInfo;
	readonly verdict: Promise<Verdict>;
}

async function verdictOf(outcome: CommitOutcome): Promise<Verdict> {
	try {
		await outcome.settled;
	} catch (error) {
		return { kind: 'failed', error };
	}

	return { kind: 'servable' };
}

// Upload and commit one negotiated decision, returning once the server has
// acknowledged the commit. Uploads verify streamed NAR metadata before commit.
// If the path is collected during the read, preserve any destination
// confirmation or report the missing target or intermediate. The verdict is
// awaited later, so a slow verification does not keep this upload worker
// busy.
async function uploadAndAcknowledge(
	decision: PublishableDecision,
	info: NixValidPathInfo,
	isTarget: boolean,
	options: ReconcileOptions,
	ledger: PublicationLedger
): Promise<AcknowledgedPath | undefined> {
	const compressNar = options.compressNar ?? compressNarToStream;
	const createNarArchive =
		options.createNarArchive ??
		((storePath: string) => new NarArchive(storePath));

	if (decision.action === 'upload') {
		try {
			const upload = compressNar(createNarArchive(info.storePath));

			const durationMs = await sendUpload(
				options.session,
				decision.uploadId,
				() => options.client.uploadNar(decision.r2Key, upload.body),
				options.uploadClock
			);
			assertNarMetadata(info, upload.digest());
			options.onUploaded?.(info.storePath, durationMs);
		} catch (error) {
			if (isVanishedPathError(error)) {
				settleLocallyMissing(info.storePath, isTarget, options, ledger);
				return undefined;
			}

			ledger.published.delete(info.storePath);
			recordFailure(ledger, info.storePath, 'upload', error);
			return undefined;
		}
	}

	let outcome: CommitOutcome;

	try {
		outcome = await commitOverSession(options, {
			uploadId: decision.uploadId,
			storePathHash: decision.storePathHash,
			narHash: decision.narHash
		});
	} catch (error) {
		return { info, verdict: Promise.resolve({ kind: 'failed', error }) };
	}

	if (outcome.status !== 'already-present') {
		ledger.published.add(info.storePath);
	}

	if (outcome.status === 'pending' && options.wait === false) {
		return undefined;
	}

	return { info, verdict: verdictOf(outcome) };
}

// Record an acknowledged path's verdict. An absent verdict can mean that
// another upload of the same path won publication, so confirm it against the
// destination before reporting a failure.
async function recordVerdict(
	acknowledged: AcknowledgedPath,
	options: ReconcileOptions,
	ledger: PublicationLedger
): Promise<void> {
	const { info } = acknowledged;
	const verdict = await acknowledged.verdict;

	if (verdict.kind === 'servable') {
		ledger.servable.add(info.storePath);
		return;
	}

	ledger.published.delete(info.storePath);

	if (
		verdict.error instanceof UploadVerificationFailedError &&
		verdict.error.status === 'absent'
	) {
		try {
			if (await isBuildOutputServed(info, options.client)) {
				ledger.servable.add(info.storePath);
				return;
			}
		} catch (confirmationError) {
			recordFailure(ledger, info.storePath, 'verification', confirmationError);
			return;
		}
	}

	recordFailure(ledger, info.storePath, 'verification', verdict.error);
}

// Handle one path from just-in-time negotiation. A refused negotiation is an
// upload failure for every path in its group.
async function publishNegotiated(
	item: NegotiatedPath<NixValidPathInfo, UploadDecision>,
	required: ReadonlyMap<StorePathString, boolean>,
	options: ReconcileOptions,
	ledger: PublicationLedger,
	acknowledged: AcknowledgedPath[]
): Promise<void> {
	const info = item.path;

	if (item.kind === 'refused') {
		recordFailure(ledger, info.storePath, 'upload', item.error);
		return;
	}

	const { decision } = item;

	if (decision.action === 'skip') {
		try {
			requireMatchingBuildOutput(info, decision);
		} catch (error) {
			recordFailure(ledger, info.storePath, 'verification', error);
			return;
		}

		ledger.servable.add(info.storePath);
		return;
	}

	const acknowledgement = await uploadAndAcknowledge(
		decision,
		info,
		required.get(info.storePath) === true,
		options,
		ledger
	);

	if (acknowledgement !== undefined) {
		acknowledged.push(acknowledgement);
	}
}

// Read current store metadata for every path required after streaming, then
// renegotiate each path with the destination. Existing destination paths become
// skip decisions, while failed streaming publications retry the normal upload
// and commit flow. Paths are negotiated in small groups as upload workers
// become free. A rejected negotiation refuses only the paths of its group, and
// later groups continue. Verdicts are awaited after every upload has been
// acknowledged. Return the same store metadata for receipt provenance.
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

	const concurrency = options.uploadConcurrency ?? defaultUploadConcurrency;
	const acknowledged: AcknowledgedPath[] = [];

	await publishJustInTime(
		{
			paths: infos,
			concurrency,
			negotiationOf: (info) => prepareStorePathNegotiation(info),
			negotiate: async (paths) => {
				const negotiation = await options.client.negotiate({
					paths: [...paths],
					...(options.runRoot !== undefined && { attachRoot: options.runRoot })
				});

				return {
					uploads: negotiation.uploads,
					hasUploadGraceFacts: negotiation.hasUploadGraceFacts ?? true
				};
			}
		},
		(item) => publishNegotiated(item, required, options, ledger, acknowledged)
	);

	await mapWithConcurrency(acknowledged, concurrency, (path) =>
		recordVerdict(path, options, ledger)
	);

	return infos;
}

function targetOutcome(
	resolved: ResolvedTarget,
	ledger: PublicationLedger
): TargetOutcomeInput {
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

	return {
		outcome: isPublished ? 'built' : 'destination-served',
		storePath: first
	};
}

// Root replacement requires every `publish` target to resolve to servable
// paths. Other planner classifications require no publication in this run.
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

function resolvedPathsOf(resolved: ResolvedTarget): readonly StorePathString[] {
	if (resolved.resolution.kind === 'resolved') {
		return resolved.resolution.paths;
	}

	return [fallbackPath(resolved.target)];
}

function rootContentsOf(resolved: ResolvedTarget): readonly StorePathString[] {
	if (resolved.classification === 'left-upstream') {
		return [];
	}

	return resolvedPathsOf(resolved);
}

// Replace a target root only after every target is confirmed. Preserve its
// prior contents if any target is unconfirmed. A group classified entirely as
// `left-upstream` deliberately replaces the root with an empty list. Run roots
// are attached during commit and are not handled here.
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
		const resolvedPaths = group.flatMap((item) => resolvedPathsOf(item));

		if (group.some((item) => !isConfirmed(item, ledger))) {
			roots.push({ root, applied: false, targets });
			continue;
		}

		try {
			await options.client.setRoot(root, {
				targets: [...targets],
				retention: options.retention ?? { kind: 'inherit' }
			});
			roots.push({ root, applied: true, targets });
		} catch (error) {
			// Attribute a rejected replacement to every resolved target. The new
			// root contents can be empty.
			for (const storePath of resolvedPaths) {
				recordFailure(ledger, storePath, 'retention', error);
			}

			roots.push({ root, applied: false, targets });
		}
	}

	return roots;
}

// Streaming records prior progress but is not the source of truth. Re-negotiate
// every required path and await its required verdict before replacing roots.
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

	// Deduplicate every path whose final availability must be checked: resolved
	// publish targets, streaming outcomes and candidates, and declared
	// intermediates. The boolean records target membership so local collection is
	// reported as a target failure only when appropriate.
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

	// Preserve publication provenance from streaming. `publishRequired`
	// independently confirms final availability.
	for (const [storePath, streamed] of options.outcomes) {
		if (streamed.outcome !== 'published') {
			continue;
		}

		ledger.published.add(storePath);
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
