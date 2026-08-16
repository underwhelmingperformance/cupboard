import type {
	Nix,
	NixDaemonTrust,
	NixDerivedPathString,
	NixMissingPartition,
	UnreachableSubstituter
} from '@cupboard/nix';
import {
	type RootName,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	describeUnknownPathsRefusal,
	type PlanStore,
	type UnknownPathCause,
	type UnknownPathDetail
} from '@cupboard/protocol/plan';
import type { ParsedRootEnsureResponse } from '@cupboard/protocol/retention';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import { CliError, transientExitCode } from '../errors.ts';

/**
 * The information needed to classify one manifest target: what `nix build`
 * would realise, the concrete output path when Nix can predict it before
 * building, and the retention root for its `roots.ensure` call. A target with
 * no `expectedPath` is content-addressed or otherwise floating.
 * Its path does not exist yet, so the module cannot query it in the
 * destination, a reuse view or an upstream substituter. It therefore always
 * joins the build set.
 */
export interface AvailabilityTarget {
	/** The manifest attribute that identifies this target to the operator. */
	readonly attr: string;
	readonly installable: NixDerivedPathString;
	readonly expectedPath?: StorePathString;
	/** A planned derivation closure the caller will copy before realisation. */
	readonly plannedLocalDerivation?: StorePathString;
	readonly root: RootName;
}

/**
 * Destination availability that the planner cannot determine from the local
 * store. One query checks the destination cache and the other checks the
 * tenant's configured reuse view. Both accept a batch of paths, matching the
 * existing `availableCachePaths` HTTP probe.
 */
export interface DestinationAnswers {
	readonly destinationServed: (
		paths: readonly StorePathString[]
	) => Promise<ReadonlySet<StorePathString>>;
	readonly viewServed: (
		paths: readonly StorePathString[]
	) => Promise<ReadonlySet<StorePathString>>;
}

/**
 * The maximum number of paths whose availability may remain unknown. The
 * configured value applies after a successful re-query and may be zero. If the
 * store refuses the re-query, the fallback applies because cached misses cannot
 * be distinguished from current upstream misses.
 */
export interface AvailabilityCeilingConfig {
	readonly value: number;
	readonly untrustedFallback: number;
}

/**
 * A target the classification would leave upstream, paired with the path it
 * resolved to, as the confirmation receives it. The installable comes along
 * because a derivation carries its own substitution option, which the store
 * path alone cannot answer for.
 */
export interface LeftUpstreamCandidate {
	readonly installable: NixDerivedPathString;
	readonly storePath: StorePathString;
}

/**
 * The result of confirming a left-upstream candidate. Only `confirmed` leaves
 * the target upstream. Every other result records why the target must be built
 * or published instead.
 */
export type LeftUpstreamVerdict =
	| { readonly kind: 'confirmed' }
	/** The `substitute` setting is off, so Nix would not fetch the path. */
	| { readonly kind: 'substitution-disabled' }
	/** The derivation disables substitutes and no setting overrides it. */
	| { readonly kind: 'substitutes-not-allowed' }
	/** The derivation could not be read, so its option is unknown. */
	| { readonly kind: 'derivation-unreadable'; readonly errorName: string }
	/**
	 * The daemon does not trust the confirmation's connection. It drops such a
	 * client's settings, so the substituters that answered are the runner's own,
	 * and their answers may come from a narinfo cache the confirmation asked to
	 * bypass. Neither fact shows that a consumer elsewhere could fetch the path.
	 */
	| {
			readonly kind: 'connection-not-trusted';
			readonly trust: NixDaemonTrust;
	  }
	| {
			readonly kind: 'closure-not-served';
			readonly missing: StorePathString;
	  }
	/**
	 * A path in the candidate's closure that this store does not hold, so
	 * there is no closure to prove anything about past it.
	 */
	| {
			readonly kind: 'closure-not-held-locally';
			readonly missing: StorePathString;
	  }
	/**
	 * A substituter offers a path in the closure under a NAR hash other than
	 * the one this store holds, so what a consumer would fetch is not what
	 * this run has.
	 */
	| {
			readonly kind: 'closure-divergent';
			readonly storePath: StorePathString;
			readonly held: string;
			readonly offered: string;
	  }
	/**
	 * A path in the closure carries no signature this configuration would
	 * accept, so a consumer would refuse to fetch it however well the
	 * substituter serves it.
	 */
	| { readonly kind: 'closure-unsigned'; readonly storePath: StorePathString }
	| { readonly kind: 'closure-over-cap'; readonly maxPaths: number };

/** One rejected candidate, as the partition reports it. */
export type LeftUpstreamRejection = Exclude<
	LeftUpstreamVerdict,
	{ readonly kind: 'confirmed' }
> & { readonly storePath: StorePathString };

export type CeilingSource = 'configured' | 'untrusted-fallback';

/** What substituting one path would cost, as an answer measured it. */
export interface SubstitutablePathSize {
	readonly downloadSize: number;
	readonly narSize: number;
}

/**
 * The result of re-querying paths whose availability was unknown. `answered`
 * contains a fresh partition. `already-fresh` means the first query bypassed
 * caches. `refused` explains why the fallback ceiling applies.
 */
export type UnknownRequeryOutcome =
	| {
			readonly kind: 'answered';
			readonly partition: NixMissingPartition;
			/**
			 * Per-path costs for substitutable paths in the fresh partition. They
			 * prevent paths included in both partitions from being counted twice.
			 */
			readonly sizes: ReadonlyMap<StorePathString, SubstitutablePathSize>;
	  }
	| { readonly kind: 'already-fresh' }
	| { readonly kind: 'refused'; readonly reason: string };

export interface AvailabilityCeiling {
	readonly value: number;
	readonly source: CeilingSource;
	readonly fallbackReason?: string;
}

export interface AvailabilityPartitionOptions {
	readonly targets: readonly AvailabilityTarget[];
	/** The kind and URI of the selected store, for refusal diagnostics. */
	readonly storeIdentity: PlanStore;
	/** The selected store's own availability queries; no override applied. */
	readonly store: Pick<
		Nix,
		| 'queryMissing'
		| 'querySubstitutablePaths'
		| 'queryValidPaths'
		| 'unreachableSubstituters'
	>;
	readonly destinationAnswers: DestinationAnswers;
	/**
	 * Which of the given paths the destination cache holds build provenance
	 * for. A plan that requires attested availability sets this field, and a
	 * destination-served path with no provenance then joins the build set.
	 * When the field is unset, a target is attach-only whenever the destination
	 * cache serves its path.
	 */
	readonly attestedServed?: (
		paths: readonly StorePathString[]
	) => Promise<ReadonlySet<StorePathString>>;
	/** One `roots.ensure` result per target root, keyed by root name. */
	readonly rootEnsureResults: ReadonlyMap<RootName, ParsedRootEnsureResponse>;
	/**
	 * Re-queries paths whose availability remained unknown, bypassing any cache
	 * used by the first query. Called only when at least one path is unknown.
	 */
	readonly requeryUnknown: (
		storePaths: readonly StorePathString[]
	) => Promise<UnknownRequeryOutcome>;
	/**
	 * Verifies that a candidate is available from substituters a consumer
	 * elsewhere could reach, and that Nix would fetch it rather than build it.
	 * Asked only of the targets the classification would otherwise leave
	 * upstream. Other targets do not require this verification.
	 */
	readonly confirmLeftUpstream: (
		candidate: LeftUpstreamCandidate
	) => Promise<LeftUpstreamVerdict>;
	readonly ceiling: AvailabilityCeilingConfig;
}

/**
 * The realisation and publication partition of a manifest's targets: which
 * require only attachment to an already-servable root, which the
 * tenant already holds elsewhere and can be published by reference, which an
 * upstream substituter already serves and are deliberately left there, and
 * which must actually be built. `nix build` realises every installable it is
 * given, so `buildSet` is the only part ever handed to it.
 */
export interface AvailabilityPartition {
	readonly attachOnly: readonly StorePathString[];
	readonly publishByReference: readonly StorePathString[];
	readonly leftUpstream: readonly StorePathString[];
	/**
	 * The candidates the confirmation refused, with the reason each was
	 * refused. Every one of them joins `buildSet` instead.
	 */
	readonly leftUpstreamRejections: readonly LeftUpstreamRejection[];
	readonly buildSet: readonly NixDerivedPathString[];
	/**
	 * Paths the destination cache serves without holding build provenance for
	 * them. A run that asked for attested availability builds these targets, so
	 * each of them is in `buildSet` by its installable and absent from
	 * `attachOnly`. The list is empty for every other run.
	 */
	readonly unattested: readonly StorePathString[];
	readonly counts: {
		readonly willBuild: number;
		readonly willSubstitute: number;
		readonly unknown: number;
	};
	readonly downloadSize: number;
	readonly narSize: number;
	/**
	 * The targets this store already held when the plan ran. A run that builds
	 * afterwards realised everything else it publishes, so a receipt claiming
	 * what the run built claims none of these.
	 */
	readonly alreadyValid: readonly StorePathString[];
	/** Equal to `counts.unknown`, flattened for a capacity preflight to read directly. */
	readonly unknownCount: number;
	readonly ceiling: AvailabilityCeiling;
	/**
	 * Configured substituters that could not be queried. Availability results
	 * exclude these substituters, so a reported miss is incomplete when this
	 * list is non-empty.
	 */
	readonly unreachableSubstituters: readonly UnreachableSubstituter[];
}

/**
 * Raised when the final availability check leaves more unresolved paths than
 * the configured limit permits.
 */
export class UnknownPathsCeilingError extends CliError {
	public readonly unknownCount: number;

	constructor(
		public readonly unknownPaths: readonly UnknownPathDetail[],
		public readonly ceiling: AvailabilityCeiling,
		public readonly downloadSize: number,
		public readonly narSize: number,
		public readonly store: PlanStore,
		public readonly unreachableSubstituters: readonly string[]
	) {
		super(
			describeUnknownPathsRefusal({
				unknownPaths,
				ceiling,
				store,
				unreachableSubstituters
			})
		);
		this.name = 'UnknownPathsCeilingError';
		this.unknownCount = unknownPaths.length;
	}

	// A different attempt, a trusted connection, or a cleared narinfo
	// negative cache can all resolve what today's answer could not, so this
	// is the CLI's transient category rather than a bare unclassified exit.
	override get exitCode(): number {
		return transientExitCode;
	}
}

/**
 * Partitions a manifest's targets by what realising and publishing each one
 * actually requires. Machine-independent facts (destination- and
 * view-serving) come from the caller's HTTP probes; everything else is asked
 * of the selected store directly, batched into as few daemon round trips as
 * the three availability questions allow.
 */
export async function partitionAvailability(
	options: AvailabilityPartitionOptions
): Promise<AvailabilityPartition> {
	const knownPaths = options.targets
		.map((target) => target.expectedPath)
		.filter((path): path is StorePathString => path !== undefined);
	const installables = options.targets.map((target) => target.installable);

	const [destinationServedPaths, viewServedPaths, validPaths, queriedMissing] =
		await Promise.all([
			options.destinationAnswers.destinationServed(knownPaths),
			options.destinationAnswers.viewServed(knownPaths),
			options.store.queryValidPaths(knownPaths),
			options.store.queryMissing(installables)
		]);
	const missing = accountForLocalDerivations(queriedMissing, options.targets);

	// Only a path this store already holds valid is a "leave it upstream"
	// candidate: asking whether a path Nix still needs to build or fetch is
	// already available elsewhere answers a question that does not apply to
	// it yet.
	const substitutableRaw =
		await options.store.querySubstitutablePaths(validPaths);
	const substitutableExternal = new Set(
		substitutableRaw
			.map((path) => storePathSchema.parse(path))
			.filter(
				(path) =>
					!destinationServedPaths.has(path) && !viewServedPaths.has(path)
			)
	);

	const { partition: settled, ceiling } = await settleUnknowns(
		missing,
		options
	);
	const unreachableSubstituters = await options.store.unreachableSubstituters();

	if (settled.unknown.length > ceiling.value) {
		throw new UnknownPathsCeilingError(
			unknownPathDetails(settled.unknown, options.targets, ceiling),
			ceiling,
			settled.downloadSize,
			settled.narSize,
			options.storeIdentity,
			unreachableSubstituters.map(({ uri }) => uri)
		);
	}

	const attachOnly: StorePathString[] = [];
	const publishByReference: StorePathString[] = [];
	const leftUpstream: StorePathString[] = [];
	const buildSet: NixDerivedPathString[] = [];
	const buckets = { attachOnly, publishByReference, leftUpstream, buildSet };
	const classified = options.targets.map((target) => ({
		target,
		classification: classify(
			target,
			destinationServedPaths,
			viewServedPaths,
			substitutableExternal,
			options.rootEnsureResults
		)
	}));
	const rejections = await confirmCandidates(classified, options);
	const rejectedPaths = new Set(
		rejections.map((rejection) => rejection.storePath)
	);
	const unattested = await unattestedPaths(classified, options);

	for (const { target, classification } of classified) {
		addToBucket(
			buckets,
			target,
			builtWhenUnattested(confirmed(classification, rejectedPaths), unattested)
		);
	}

	return {
		attachOnly,
		publishByReference,
		leftUpstream,
		leftUpstreamRejections: rejections,
		buildSet,
		unattested: unattested.values().toArray().toSorted(byCodeUnit),
		counts: {
			willBuild: settled.willBuild.length,
			willSubstitute: settled.willSubstitute.length,
			unknown: settled.unknown.length
		},
		downloadSize: settled.downloadSize,
		narSize: settled.narSize,
		alreadyValid: validPaths
			.map((storePath) => storePathSchema.parse(storePath))
			.toSorted(byCodeUnit),
		unknownCount: settled.unknown.length,
		ceiling,
		unreachableSubstituters
	};
}

function unknownPathDetails(
	unknownPaths: readonly StorePathString[],
	targets: readonly AvailabilityTarget[],
	ceiling: AvailabilityCeiling
): readonly UnknownPathDetail[] {
	return [...unknownPaths].toSorted(byCodeUnit).map((unknownPath) => ({
		path: unknownPath,
		cause: unknownPathCause(unknownPath, ceiling),
		targets: targets.flatMap((target) =>
			isTargetPath(target, unknownPath)
				? [{ attr: target.attr, installable: target.installable }]
				: []
		)
	}));
}

function unknownPathCause(
	storePath: StorePathString,
	ceiling: AvailabilityCeiling
): UnknownPathCause {
	if (storePath.endsWith('.drv')) {
		return { kind: 'missing-derivation' };
	}

	if (ceiling.fallbackReason !== undefined) {
		return {
			kind: 'substituter-result-not-refreshed',
			reason: ceiling.fallbackReason
		};
	}

	return { kind: 'not-in-store-or-substituters' };
}

function isTargetPath(
	target: AvailabilityTarget,
	storePath: StorePathString
): boolean {
	const selection = target.installable.indexOf('^');
	const installablePath =
		selection === -1
			? target.installable
			: target.installable.slice(0, selection);

	return [
		installablePath,
		target.expectedPath,
		target.plannedLocalDerivation
	].includes(storePath);
}

// A remote store cannot inspect a derivation that is absent from that store,
// so queryMissing reports the derivation itself as unknown and stops walking.
// A caller that promises to materialise the complete planned derivation
// closure locally and copy it before realisation has already settled that
// uncertainty: after the copy, this is ordinary build work. Paths that carry
// no such evidence remain unknown and retain the ceiling's fail-closed
// behaviour.
function accountForLocalDerivations(
	missing: NixMissingPartition,
	targets: readonly AvailabilityTarget[]
): NixMissingPartition {
	const localDerivations = new Set(
		targets.flatMap(({ plannedLocalDerivation }) =>
			plannedLocalDerivation === undefined ? [] : [plannedLocalDerivation]
		)
	);
	const localMissing = missing.unknown.filter((storePath) =>
		localDerivations.has(storePath)
	);

	if (localMissing.length === 0) {
		return missing;
	}

	const accountedFor = new Set(localMissing);

	return {
		...missing,
		willBuild: eachOnce(missing.willBuild, localMissing),
		unknown: missing.unknown.filter((storePath) => !accountedFor.has(storePath))
	};
}

/**
 * Where one target belongs once the three availability questions have been
 * answered for it: a named bucket with the path that answers for it, or the
 * build set.
 */
export type Classification =
	| {
			readonly bucket: 'attachOnly' | 'publishByReference' | 'leftUpstream';
			readonly path: StorePathString;
	  }
	| { readonly bucket: 'buildSet' };

interface ClassifiedTarget {
	readonly target: AvailabilityTarget;
	readonly classification: Classification;
}

/**
 * How many candidates are confirmed at once. Each confirmation walks a
 * closure over its own daemon connections, so the fan-out stays small.
 */
const maximumConcurrentConfirmations = 4;

// Only a target the classification would leave upstream is worth confirming.
// A path answer is shared, but the derivation's substitution option belongs to
// the installable, so every distinct path-and-installable pair needs an answer.
async function confirmCandidates(
	classified: readonly ClassifiedTarget[],
	options: AvailabilityPartitionOptions
): Promise<readonly LeftUpstreamRejection[]> {
	const candidates = new Map<
		StorePathString,
		Map<NixDerivedPathString, LeftUpstreamCandidate>
	>();

	for (const { target, classification } of classified) {
		if (classification.bucket !== 'leftUpstream') {
			continue;
		}

		const aliases =
			candidates.get(classification.path) ??
			new Map<NixDerivedPathString, LeftUpstreamCandidate>();
		aliases.set(target.installable, {
			installable: target.installable,
			storePath: classification.path
		});
		candidates.set(classification.path, aliases);
	}
	const distinctCandidates = candidates
		.values()
		.flatMap((aliases) => aliases.values())
		.toArray();

	const verdicts = await mapWithConcurrency(
		distinctCandidates,
		maximumConcurrentConfirmations,
		async (candidate) => ({
			storePath: candidate.storePath,
			verdict: await options.confirmLeftUpstream(candidate)
		})
	);

	return verdicts.flatMap(({ storePath, verdict }) =>
		verdict.kind === 'confirmed' ? [] : [{ ...verdict, storePath }]
	);
}

// A candidate the confirmation refused is not left upstream: it falls back to
// the build set, where it would have gone had no substituter offered it.
function confirmed(
	classification: Classification,
	rejectedPaths: ReadonlySet<StorePathString>
): Classification {
	if (
		classification.bucket !== 'leftUpstream' ||
		!rejectedPaths.has(classification.path)
	) {
		return classification;
	}

	return { bucket: 'buildSet' };
}

/**
 * The attach-only paths the destination cache serves without an attestation.
 * The set is empty when the run did not ask for attested availability. Only an
 * attach-only classification can change, so the query asks about the
 * attach-only paths and no others.
 */
async function unattestedPaths(
	classified: readonly ClassifiedTarget[],
	options: AvailabilityPartitionOptions
): Promise<ReadonlySet<StorePathString>> {
	const attestedServed = options.attestedServed;

	if (attestedServed === undefined) {
		return new Set();
	}

	const attachOnlyPaths = new Set(
		classified.flatMap(({ classification }) =>
			classification.bucket === 'attachOnly' ? [classification.path] : []
		)
	);

	if (attachOnlyPaths.size === 0) {
		return new Set();
	}

	const attested = await attestedServed(attachOnlyPaths.values().toArray());

	return new Set(
		attachOnlyPaths.values().filter((storePath) => !attested.has(storePath))
	);
}

// Attaching a target to its root publishes the path the destination cache
// already serves. When that cache holds no attestation for the path, the
// published target has no provenance, so a run that requires attested
// availability puts the target in the build set and attaches an attestation to
// the output it builds.
function builtWhenUnattested(
	classification: Classification,
	unattested: ReadonlySet<StorePathString>
): Classification {
	if (
		classification.bucket !== 'attachOnly' ||
		!unattested.has(classification.path)
	) {
		return classification;
	}

	return { bucket: 'buildSet' };
}

/**
 * Places one target given the destination, view and substitutability answers
 * that apply to it, in the order the partition settles them. Exported so a
 * later confirmation over a subset of the same targets classifies by these
 * rules and no others.
 */
export function classify(
	target: AvailabilityTarget,
	destinationServedPaths: ReadonlySet<StorePathString>,
	viewServedPaths: ReadonlySet<StorePathString>,
	substitutableExternal: ReadonlySet<StorePathString>,
	rootEnsureResults: ReadonlyMap<RootName, ParsedRootEnsureResponse>
): Classification {
	const path = target.expectedPath;

	if (path === undefined) {
		return { bucket: 'buildSet' };
	}

	if (
		destinationServedPaths.has(path) ||
		isServedByRootEnsure(target, rootEnsureResults)
	) {
		return { bucket: 'attachOnly', path };
	}

	if (viewServedPaths.has(path)) {
		return { bucket: 'publishByReference', path };
	}

	if (substitutableExternal.has(path)) {
		return { bucket: 'leftUpstream', path };
	}

	return { bucket: 'buildSet' };
}

interface Buckets {
	readonly attachOnly: StorePathString[];
	readonly publishByReference: StorePathString[];
	readonly leftUpstream: StorePathString[];
	readonly buildSet: NixDerivedPathString[];
}

function addToBucket(
	buckets: Buckets,
	target: AvailabilityTarget,
	classification: Classification
): void {
	if (classification.bucket === 'buildSet') {
		buckets.buildSet.push(target.installable);
		return;
	}

	buckets[classification.bucket].push(classification.path);
}

// `roots.ensure` already probes the exact list a root last reconciled: a
// retained root serves every one of its targets, and a build-required
// answer still names, in `unavailable`, only the ones that do not.
function isServedByRootEnsure(
	target: AvailabilityTarget,
	rootEnsureResults: ReadonlyMap<RootName, ParsedRootEnsureResponse>
): boolean {
	const result = rootEnsureResults.get(target.root);

	if (result === undefined || target.expectedPath === undefined) {
		return false;
	}

	if (result.status === 'retained') {
		return true;
	}

	return !result.unavailable.includes(target.expectedPath);
}

interface SettledMissing {
	readonly willBuild: readonly StorePathString[];
	readonly willSubstitute: readonly StorePathString[];
	readonly unknown: readonly StorePathString[];
	readonly downloadSize: number;
	readonly narSize: number;
}

// An unknown path is one no substituter offered. That answer may have come
// from a cache holding an earlier absence, so the store is given one more
// chance to answer it afresh.
async function settleUnknowns(
	missing: Awaited<ReturnType<Nix['queryMissing']>>,
	options: AvailabilityPartitionOptions
): Promise<{
	readonly partition: SettledMissing;
	readonly ceiling: AvailabilityCeiling;
}> {
	const configured = {
		value: options.ceiling.value,
		source: 'configured' as const
	};

	if (missing.unknown.length === 0) {
		return { partition: missing, ceiling: configured };
	}

	const outcome = await options.requeryUnknown(missing.unknown);

	if (outcome.kind === 'refused') {
		return {
			partition: missing,
			ceiling: {
				value: options.ceiling.untrustedFallback,
				source: 'untrusted-fallback',
				fallbackReason: outcome.reason
			}
		};
	}

	if (outcome.kind === 'already-fresh') {
		return { partition: missing, ceiling: configured };
	}

	const requery = outcome.partition;
	const toBuild = eachOnce(missing.willBuild, requery.willBuild);
	const toSubstitute = eachOnce(missing.willSubstitute, requery.willSubstitute);
	const settled = new Set([...toBuild, ...toSubstitute]);
	const twice = bytesSettledTwice(missing, requery, outcome.sizes);

	return {
		partition: {
			willBuild: toBuild,
			willSubstitute: toSubstitute,
			// The fresh answer walks the closures of the paths it resolved, which
			// reaches paths the first answer settled by another route. One
			// settled either way is settled, whichever answer left it unknown.
			unknown: requery.unknown.filter((storePath) => !settled.has(storePath)),
			downloadSize:
				missing.downloadSize + requery.downloadSize - twice.downloadSize,
			narSize: missing.narSize + requery.narSize - twice.narSize
		},
		ceiling: configured
	};
}

/**
 * The bytes both answers counted: what each states is one total over the paths
 * it settled, so a path both settled is in both totals and belongs in the
 * merged one once.
 *
 * The fresh answer's per-path figures are enough to take it out exactly. A
 * path in both totals is by definition one the fresh answer settled, so its
 * figures are always the ones that came back with it, and the first answer
 * needs none of its own. A path whose figures did not come back stays in both
 * totals, since the merged total is read as the number of bytes that
 * substitution would fetch, and a guessed figure could put that total below the
 * true one.
 */
function bytesSettledTwice(
	missing: SettledMissing,
	requery: NixMissingPartition,
	sizes: ReadonlyMap<StorePathString, SubstitutablePathSize>
): SubstitutablePathSize {
	const freshlySettled = new Set(requery.willSubstitute);
	const settledTwice = new Set(
		missing.willSubstitute.filter((storePath) => freshlySettled.has(storePath))
	);
	let downloadSize = 0;
	let narSize = 0;

	for (const storePath of settledTwice) {
		const size = sizes.get(storePath);

		downloadSize += size?.downloadSize ?? 0;
		narSize += size?.narSize ?? 0;
	}

	return { downloadSize, narSize };
}

// Every path listed by either answer, included once each, in the order the
// paths first appear.
function eachOnce(
	first: readonly StorePathString[],
	second: readonly StorePathString[]
): readonly StorePathString[] {
	return [...new Set([...first, ...second])];
}
