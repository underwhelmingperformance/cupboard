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
import type { ParsedRootEnsureResponse } from '@cupboard/protocol/retention';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import { CliError, transientExitCode } from '../errors.ts';

/**
 * One manifest target from the availability partition's point of view: what
 * `nix build` would realise, the concrete output path when Nix can predict
 * it before building, and the retention root that target's own
 * `roots.ensure` call answers for. A target with no `expectedPath` is
 * content-addressed or otherwise floating: nothing in this module can check
 * whether the destination, a reuse view, or an upstream substituter already
 * holds a path that does not exist yet, so it always joins the build set.
 */
export interface AvailabilityTarget {
	readonly installable: NixDerivedPathString;
	readonly expectedPath?: StorePathString;
	readonly root: RootName;
}

/**
 * The destination-side facts the planner cannot get from the local store: is
 * a path already served by the destination cache, and is it served by the
 * tenant's configured reuse view. Both answer over a batch of paths at once,
 * mirroring the existing HTTP probe (`availableCachePaths`) that already
 * answers the destination question for the interim actions planner.
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
 * The unknown-count ceiling this partition enforces once a `queryMissing`
 * answer settles: the configured value applies whenever the unknowns are as
 * settled as the store can make them (and may be zero, for a fixture that
 * requires every path to resolve), and the nonzero fallback applies when a
 * re-query was refused, since unknowns left behind a cache the plan could
 * not read past cannot be told from unknowns that are really unknown.
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
 * What confirming a left-upstream candidate settled on. Only `confirmed`
 * leaves the target upstream; every other verdict says why the target is
 * built or published instead, so a plan records the reason rather than
 * silently reclassifying.
 */
export type LeftUpstreamVerdict =
	| { readonly kind: 'confirmed' }
	/** The `substitute` setting is off, so nothing would be fetched at all. */
	| { readonly kind: 'substitution-disabled' }
	/** The derivation sets `allowSubstitutes = false` and nothing overrules it. */
	| { readonly kind: 'substitutes-not-allowed' }
	/** The derivation could not be read, so its option is unknown. */
	| { readonly kind: 'derivation-unreadable'; readonly errorName: string }
	/**
	 * The daemon does not trust the confirmation's connection. It drops such a
	 * client's settings, so the substituters that answered are the runner's own
	 * and their answers may come from a narinfo cache the confirmation asked to
	 * bypass; neither says anything about what an upstream serves.
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
			readonly missing: StorePathString;
			readonly held: string;
			readonly offered: string;
	  }
	/**
	 * A path in the closure carries no signature this configuration would
	 * accept, so a consumer would refuse to fetch it however well the
	 * substituter serves it.
	 */
	| { readonly kind: 'closure-unsigned'; readonly missing: StorePathString }
	| { readonly kind: 'closure-over-cap'; readonly maxPaths: number };

/** One rejected candidate, as the partition reports it. */
export type LeftUpstreamRejection = Exclude<
	LeftUpstreamVerdict,
	{ readonly kind: 'confirmed' }
> & { readonly storePath: StorePathString };

export type CeilingSource = 'configured' | 'untrusted-fallback';

/**
 * How a re-query of the unknown paths settled. `answered` carries what the
 * fresh look found; `already-fresh` says the first answer was uncached, so
 * there is nothing to look past; `refused` names why the store would not
 * give a fresh answer, which is what puts the plan on its fallback ceiling.
 */
export type UnknownRequeryOutcome =
	| { readonly kind: 'answered'; readonly partition: NixMissingPartition }
	| { readonly kind: 'already-fresh' }
	| { readonly kind: 'refused'; readonly reason: string };

export interface AvailabilityCeiling {
	readonly value: number;
	readonly source: CeilingSource;
	readonly fallbackReason?: string;
}

export interface AvailabilityPartitionOptions {
	readonly targets: readonly AvailabilityTarget[];
	/** The selected store's own availability queries; no override applied. */
	readonly store: Pick<
		Nix,
		| 'queryMissing'
		| 'querySubstitutablePaths'
		| 'queryValidPaths'
		| 'unreachableSubstituters'
	>;
	readonly destinationAnswers: DestinationAnswers;
	/** One `roots.ensure` result per target root, keyed by root name. */
	readonly rootEnsureResults: ReadonlyMap<RootName, ParsedRootEnsureResponse>;
	/**
	 * Asks the store about the paths the first pass left unknown, past
	 * whatever cache stood in front of that answer. Reached only when there
	 * are unknowns, since there is otherwise nothing to ask about.
	 */
	readonly requeryUnknown: (
		storePaths: readonly StorePathString[]
	) => Promise<UnknownRequeryOutcome>;
	/**
	 * Proves that a candidate really is held by substituters a consumer
	 * elsewhere could reach, and that Nix would fetch it rather than build it.
	 * Asked only of the targets the classification would otherwise leave
	 * upstream, since no other target's answer would be used.
	 */
	readonly confirmLeftUpstream: (
		candidate: LeftUpstreamCandidate
	) => Promise<LeftUpstreamVerdict>;
	readonly ceiling: AvailabilityCeilingConfig;
}

/**
 * The realisation and publication partition of a manifest's targets: which
 * need nothing but attaching to their already-servable root, which the
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
	 * The configured substituters nothing could be asked of while this
	 * partition was worked out. Every availability answer above was given
	 * without them, so a path counted as held nowhere is held nowhere among
	 * the substituters that answered.
	 */
	readonly unreachableSubstituters: readonly UnreachableSubstituter[];
}

/**
 * Raised when the final unknown count, after a trusted re-query has had its
 * chance to resolve as many as it can, still exceeds the effective ceiling.
 * A loud plan failure: an unresolved path's availability is a genuine
 * unknown, not a routine transient the run should build through silently.
 */
export class UnknownPathsCeilingError extends CliError {
	constructor(
		public readonly unknownCount: number,
		public readonly ceiling: AvailabilityCeiling,
		public readonly downloadSize: number,
		public readonly narSize: number
	) {
		super(
			`${String(unknownCount)} path(s) have unknown availability, over the ` +
				`${ceiling.source} ceiling of ${String(ceiling.value)}` +
				(ceiling.fallbackReason === undefined
					? ''
					: ` (${ceiling.fallbackReason})`)
		);
		this.name = 'UnknownPathsCeilingError';
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

	const [destinationServedPaths, viewServedPaths, validPaths, missing] =
		await Promise.all([
			options.destinationAnswers.destinationServed(knownPaths),
			options.destinationAnswers.viewServed(knownPaths),
			options.store.queryValidPaths(knownPaths),
			options.store.queryMissing(installables)
		]);

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

	if (settled.unknown.length > ceiling.value) {
		throw new UnknownPathsCeilingError(
			settled.unknown.length,
			ceiling,
			settled.downloadSize,
			settled.narSize
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

	for (const { target, classification } of classified) {
		addToBucket(buckets, target, confirmed(classification, rejectedPaths));
	}

	return {
		attachOnly,
		publishByReference,
		leftUpstream,
		leftUpstreamRejections: rejections,
		buildSet,
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
		unreachableSubstituters: await options.store.unreachableSubstituters()
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

// Only a target the classification would leave upstream is worth confirming,
// and one candidate per distinct path: two targets resolving to the same path
// get the same answer.
async function confirmCandidates(
	classified: readonly ClassifiedTarget[],
	options: AvailabilityPartitionOptions
): Promise<readonly LeftUpstreamRejection[]> {
	const candidates = new Map<StorePathString, LeftUpstreamCandidate>();

	for (const { target, classification } of classified) {
		if (classification.bucket !== 'leftUpstream') {
			continue;
		}

		candidates.set(classification.path, {
			installable: target.installable,
			storePath: classification.path
		});
	}

	const verdicts = await mapWithConcurrency(
		candidates.values().toArray(),
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

	return {
		partition: {
			willBuild: [...missing.willBuild, ...requery.willBuild],
			willSubstitute: [...missing.willSubstitute, ...requery.willSubstitute],
			unknown: requery.unknown,
			downloadSize: missing.downloadSize + requery.downloadSize,
			narSize: missing.narSize + requery.narSize
		},
		ceiling: configured
	};
}
