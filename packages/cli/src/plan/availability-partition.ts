import type {
	Nix,
	NixDaemonTrust,
	NixDerivedPathString,
	NixMissingPartition,
	NixSubstitutablePathInfo,
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

import { CliError, CliUsageError, transientExitCode } from '../errors.ts';

/**
 * A target with no `expectedPath` is content-addressed or otherwise floating.
 * Its path does not exist yet, so the module cannot query it in the
 * destination, a reuse view or an upstream substituter. It therefore always
 * joins the build set.
 */
export interface AvailabilityTarget {
	readonly attr: string;
	readonly installable: NixDerivedPathString;
	readonly expectedPath?: StorePathString;
	readonly plannedLocalDerivation?: StorePathString;
	readonly root: RootName;
}

export interface DestinationProbes {
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
 * The candidate includes the installable because a
 * derivation can disable substitutes for its own outputs, and that setting
 * cannot be read from the store path alone.
 */
export interface UpstreamAvailabilityCandidate {
	readonly installable: NixDerivedPathString;
	readonly storePath: StorePathString;
}

/**
 * Only `confirmed` excludes the target from publication. Every other result
 * records why the target must be built or published.
 */
export type UpstreamAvailabilityVerdict =
	| { readonly kind: 'confirmed' }
	| { readonly kind: 'substitution-disabled' }
	| { readonly kind: 'substitutes-not-allowed' }
	| { readonly kind: 'derivation-unreadable'; readonly errorName: string }
	/**
	 * The daemon does not trust the confirmation's connection. It drops such a
	 * client's settings, so the runner's substituters answer instead. Their
	 * responses may also come from a narinfo cache despite the confirmation's
	 * bypass setting. Neither fact shows that an external consumer could fetch
	 * the path.
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
	 * The selected store has no local NAR hash for a path in the candidate's
	 * closure. Confirmation cannot compare the upstream offer with this run's
	 * content.
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
	 * The consumer's policy accepts none of the signatures on a narinfo in the
	 * candidate's closure, so the consumer would refuse that path.
	 */
	| { readonly kind: 'closure-unsigned'; readonly storePath: StorePathString }
	| { readonly kind: 'closure-over-cap'; readonly maxPaths: number };

export type LeftUpstreamRejection = Exclude<
	UpstreamAvailabilityVerdict,
	{ readonly kind: 'confirmed' }
> & { readonly storePath: StorePathString };

export type CeilingSource = 'configured' | 'untrusted-fallback';

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

/**
 * An SSH store preserves the remote daemon's settings, so its policy
 * is unknown until the derivation has been copied. For an unknown policy, the
 * plan accounts for both the build and substitution branches.
 */
export type PlannedSubstitutionPolicy =
	| {
			readonly kind: 'known';
			readonly substitute: boolean;
			readonly alwaysAllowSubstitutes: boolean;
	  }
	| { readonly kind: 'unknown' };

export interface AvailabilityPartitionOptions {
	readonly targets: readonly AvailabilityTarget[];
	readonly plannedLocalClosure?: ReadonlySet<StorePathString>;
	readonly plannedSubstitutableDerivations?: ReadonlySet<StorePathString>;
	readonly plannedFloatingOutputs?: ReadonlySet<NixDerivedPathString>;
	readonly plannedSubstitutionPolicy: PlannedSubstitutionPolicy;
	readonly plannedLocalOutputs?: ReadonlyMap<
		StorePathString,
		readonly NixDerivedPathString[]
	>;
	readonly storeIdentity: PlanStore;
	readonly store: Pick<
		Nix,
		| 'queryMissing'
		| 'querySubstitutablePathInfos'
		| 'querySubstitutablePaths'
		| 'queryValidPaths'
		| 'unreachableSubstituters'
	>;
	readonly destinationProbes: DestinationProbes;
	/**
	 * Returns the given paths with build provenance in the destination cache. A
	 * plan that requires attested availability sets this field, and a
	 * destination-served path with no provenance then joins the build set.
	 * When the field is unset, a target is attach-only whenever the destination
	 * cache serves its path.
	 */
	readonly attestedServed?: (
		paths: readonly StorePathString[]
	) => Promise<ReadonlySet<StorePathString>>;
	readonly rootEnsureResults: ReadonlyMap<RootName, ParsedRootEnsureResponse>;
	/**
	 * Re-queries paths whose availability remained unknown, bypassing any cache
	 * used by the first query. Called only when at least one path is unknown.
	 */
	readonly requeryUnknown: (
		storePaths: readonly StorePathString[]
	) => Promise<UnknownRequeryOutcome>;
	/**
	 * Confirms that permitted upstream substituters offer the same closure held
	 * locally and that the consumer's policy accepts every offer. Called only
	 * for a candidate that the raw substitutability result would leave upstream.
	 */
	readonly confirmUpstreamAvailability: (
		candidate: UpstreamAvailabilityCandidate
	) => Promise<UpstreamAvailabilityVerdict>;
	readonly ceiling: AvailabilityCeilingConfig;
}

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
	 * Outputs to realise before the targets in `buildSet` that require them. The
	 * `requiredBy` lets the action remove dependencies used only by targets that
	 * the final probe withdraws.
	 */
	readonly dependencyBuilds: readonly AvailabilityDependencyBuild[];
	/**
	 * Local closure paths to copy before realising the targets that require them.
	 * `requiredBy` lets the action omit paths used only by withdrawn targets.
	 */
	readonly dependencyCopies: readonly AvailabilityDependencyCopy[];
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
	/**
	 * The estimated substitution capacity, including complete substitute
	 * closures that become usable after their derivations are copied. When the
	 * remote daemon's substitution policy is unknown, this is the conservative
	 * substitution branch of the estimate.
	 */
	readonly downloadSize: number;
	readonly narSize: number;
	/**
	 * The targets already present in this store when the plan ran. A later build
	 * realises every other target that it publishes, so its build receipt must
	 * exclude these paths.
	 */
	readonly alreadyValid: readonly StorePathString[];
	readonly unknownCount: number;
	readonly ceiling: AvailabilityCeiling;
	/**
	 * Configured substituters that could not be queried. Availability results
	 * exclude these substituters, so a reported miss is incomplete when this
	 * list is non-empty.
	 */
	readonly unreachableSubstituters: readonly UnreachableSubstituter[];
}

export interface AvailabilityDependencyBuild {
	readonly path: StorePathString;
	readonly installables: readonly [
		NixDerivedPathString,
		...NixDerivedPathString[]
	];
	readonly requiredBy: readonly [
		NixDerivedPathString,
		...NixDerivedPathString[]
	];
}

export interface AvailabilityDependencyCopy {
	readonly path: StorePathString;
	readonly requiredBy: readonly [
		NixDerivedPathString,
		...NixDerivedPathString[]
	];
}

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

	// A later attempt may use a trusted connection or a refreshed narinfo cache
	// and resolve these paths. Report the refusal as transient.
	override get exitCode(): number {
		return transientExitCode;
	}
}

export class RemoteFloatingOutputUnsupportedError extends CliUsageError {
	constructor(
		public readonly targets: readonly {
			readonly attr: string;
			readonly installable: NixDerivedPathString;
			readonly floatingOutputs: readonly NixDerivedPathString[];
		}[]
	) {
		super(
			`Remote builds cannot safely publish floating outputs. Nix reports each output path only after the build, and Cupboard must protect the path from garbage collection in a separate step. Garbage collection could remove the output between these steps. Build and publish these targets from the local store: ${targets.map(({ attr }) => attr).join(', ')}`
		);
		this.name = 'RemoteFloatingOutputUnsupportedError';
	}
}

function emptyMissingPartition(): NixMissingPartition {
	return {
		willBuild: [],
		willSubstitute: [],
		unknown: [],
		downloadSize: 0,
		narSize: 0
	};
}

function shouldQueryAvailabilityForTarget(
	target: AvailabilityTarget,
	destinationServedPaths: ReadonlySet<StorePathString>,
	viewServedPaths: ReadonlySet<StorePathString>,
	attestedServedPaths: ReadonlySet<StorePathString> | undefined,
	rootEnsureResults: ReadonlyMap<RootName, ParsedRootEnsureResponse>
): boolean {
	if (target.expectedPath === undefined) {
		return true;
	}

	const isTargetServedByDestination =
		destinationServedPaths.has(target.expectedPath) ||
		isServedByRootEnsure(target, rootEnsureResults);

	if (isTargetServedByDestination) {
		return (
			attestedServedPaths !== undefined &&
			!attestedServedPaths.has(target.expectedPath)
		);
	}

	return !viewServedPaths.has(target.expectedPath);
}

/**
 * Partitions a manifest's targets by what realising and publishing each one
 * actually requires. Machine-independent facts (destination- and
 * view-serving) come from the caller's HTTP probes. The selected store reports
 * local validity, build work, and raw substitutability through batched daemon
 * queries. Upstream confirmation then checks the exact offered closure and the
 * consumer's signature policy.
 */
export async function partitionAvailability(
	options: AvailabilityPartitionOptions
): Promise<AvailabilityPartition> {
	const floatingTargets = options.targets.flatMap((target) => {
		const floatingOutputs = selectedFloatingOutputs(
			target,
			options.plannedFloatingOutputs
		);

		return floatingOutputs.length === 0
			? []
			: [
					{
						attr: target.attr,
						installable: target.installable,
						floatingOutputs
					}
				];
	});

	if (floatingTargets.length > 0) {
		throw new RemoteFloatingOutputUnsupportedError(floatingTargets);
	}

	const knownPaths = options.targets
		.map((target) => target.expectedPath)
		.filter((path): path is StorePathString => path !== undefined);
	const [destinationServedPaths, viewServedPaths, validPaths] =
		await Promise.all([
			options.destinationProbes.destinationServed(knownPaths),
			options.destinationProbes.viewServed(knownPaths),
			options.store.queryValidPaths(knownPaths)
		]);
	const servedPaths = options.targets.flatMap((target) => {
		if (target.expectedPath === undefined) {
			return [];
		}

		return destinationServedPaths.has(target.expectedPath) ||
			isServedByRootEnsure(target, options.rootEnsureResults)
			? [target.expectedPath]
			: [];
	});
	const attestedServedPaths =
		options.attestedServed === undefined
			? undefined
			: await options.attestedServed([...new Set(servedPaths)]);
	const availabilityTargets = options.targets.filter((target) =>
		shouldQueryAvailabilityForTarget(
			target,
			destinationServedPaths,
			viewServedPaths,
			attestedServedPaths,
			options.rootEnsureResults
		)
	);
	const queriedMissing =
		availabilityTargets.length === 0
			? emptyMissingPartition()
			: await options.store.queryMissing(
					availabilityTargets.map((target) => target.installable)
				);
	const supplemented = await includeMissingSubstituteReferences(
		queriedMissing,
		options,
		availabilityTargets
	);
	const initiallyAccounted = accountForLocalDerivations(
		supplemented.partition,
		options.targets,
		options.plannedLocalClosure,
		options.plannedLocalOutputs,
		supplemented.dependencyOwners,
		false
	);

	// Check substitutability only for paths that this store already holds. The
	// confirmation compares each substituter's offer with the NAR hash recorded
	// by this store, which is not available for a path that Nix still has to
	// build or fetch.
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

	const classifiedUnknowns = await classifyUnknowns(
		initiallyAccounted.partition,
		supplemented.dependencyOwners,
		options
	);
	const finallyAccounted = accountForLocalDerivations(
		classifiedUnknowns.partition,
		options.targets,
		options.plannedLocalClosure,
		options.plannedLocalOutputs,
		classifiedUnknowns.dependencyOwners,
		true
	);
	const partition = finallyAccounted.partition;
	const ceiling = classifiedUnknowns.ceiling;
	const unreachableSubstituters = await options.store.unreachableSubstituters();

	if (partition.unknown.length > ceiling.value) {
		throw new UnknownPathsCeilingError(
			unknownPathDetails(partition.unknown, options.targets, ceiling),
			ceiling,
			partition.downloadSize,
			partition.narSize,
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
	const unattested = unattestedPaths(classified, attestedServedPaths);

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
		dependencyBuilds: finallyAccounted.dependencyBuilds,
		dependencyCopies: finallyAccounted.dependencyCopies,
		unattested: unattested.values().toArray().toSorted(byCodeUnit),
		counts: {
			willBuild: partition.willBuild.length,
			willSubstitute: partition.willSubstitute.length,
			unknown: partition.unknown.length
		},
		downloadSize: partition.downloadSize,
		narSize: partition.narSize,
		alreadyValid: validPaths
			.map((storePath) => storePathSchema.parse(storePath))
			.toSorted(byCodeUnit),
		unknownCount: partition.unknown.length,
		ceiling,
		unreachableSubstituters
	};
}

// A derived-path query stops when the selected store lacks the derivation. Ask
// about its known output paths separately so Nix can inspect their substitute
// closures. The caller will copy the missing derivation before realisation.
async function includeMissingSubstituteReferences(
	missing: NixMissingPartition,
	options: AvailabilityPartitionOptions,
	targets: readonly AvailabilityTarget[]
): Promise<{
	readonly partition: NixMissingPartition;
	readonly dependencyOwners: ReadonlyMap<
		StorePathString,
		ReadonlySet<NixDerivedPathString>
	>;
}> {
	if (
		options.plannedLocalOutputs === undefined &&
		options.plannedLocalClosure === undefined
	) {
		return {
			partition: missing,
			dependencyOwners: new Map()
		};
	}
	const plannedLocalOutputs = options.plannedLocalOutputs ?? new Map();

	const unknown = new Set(missing.unknown);
	const candidates = targets.flatMap((target) => {
		if (target.plannedLocalDerivation === undefined) {
			return [];
		}
		const expected = expectedPathsForTarget(
			target,
			plannedLocalOutputs,
			options.plannedFloatingOutputs
		);

		if (expected.paths.length === 0) {
			return [];
		}

		return [
			{
				expectedPaths: expected.paths,
				installable: target.installable,
				outputsDeclared: expected.outputsDeclared,
				plannedLocalDerivation: target.plannedLocalDerivation,
				substitution: expected.outputsDeclared
					? plannedSubstitutionVerdict(
							options.plannedSubstitutionPolicy,
							options.plannedSubstitutableDerivations?.has(
								target.plannedLocalDerivation
							) === true
						)
					: 'refused',
				stoppedAtDerivation: unknown.has(target.plannedLocalDerivation)
			}
		];
	});
	if (candidates.length === 0) {
		return {
			partition: missing,
			dependencyOwners: new Map()
		};
	}

	const stoppedCandidates = candidates.filter(
		(candidate) => candidate.stoppedAtDerivation
	);
	const stoppedExpectedPaths = [
		...new Set(
			stoppedCandidates.flatMap((candidate) => candidate.expectedPaths)
		)
	];
	const [outputAvailability, validExpectedPaths] =
		stoppedExpectedPaths.length === 0
			? ([undefined, []] as const)
			: await Promise.all([
					options.store.queryMissing(stoppedExpectedPaths),
					options.store.queryValidPaths(stoppedExpectedPaths)
				]);
	type Candidate = (typeof candidates)[number];
	interface CandidateAnswer {
		readonly candidate: Candidate;
		readonly partition: NixMissingPartition;
	}
	// The combined query reports the outputs and substitute closures for all
	// stopped candidates. Reuse that result only when every candidate contributes
	// to the estimate. Otherwise query each candidate so a refused derivation
	// cannot add its output sizes through another candidate's result.
	const refusedCandidateCount = stoppedCandidates.filter(
		(candidate) => candidate.substitution === 'refused'
	).length;
	const shouldQueryIndividualOutputs =
		stoppedCandidates.length > 1 &&
		((outputAvailability?.unknown.length ?? 0) > 0 ||
			(refusedCandidateCount > 0 &&
				refusedCandidateCount < stoppedCandidates.length));
	const stoppedAnswers: readonly CandidateAnswer[] =
		outputAvailability === undefined
			? []
			: shouldQueryIndividualOutputs
				? await mapWithConcurrency(
						stoppedCandidates,
						maximumConcurrentConfirmations,
						async (candidate) => ({
							candidate,
							partition: await options.store.queryMissing(
								candidate.expectedPaths
							)
						})
					)
				: stoppedCandidates.map((candidate) => ({
						candidate,
						partition: outputAvailability
					}));
	const validExpected = new Set(validExpectedPaths);
	const resolvedAnswers = stoppedAnswers.filter(({ candidate, partition }) => {
		if (candidate.expectedPaths.every((path) => validExpected.has(path))) {
			return candidate.outputsDeclared;
		}

		if (candidate.substitution === 'refused') {
			return false;
		}

		const offered = new Set(partition.willSubstitute);

		return candidate.expectedPaths.every(
			(path) => validExpected.has(path) || offered.has(path)
		);
	});
	const substitutionAnswers = resolvedAnswers.filter(({ candidate }) =>
		candidate.expectedPaths.some((path) => !validExpected.has(path))
	);
	const resolvedCandidates = new Set(
		resolvedAnswers.map(({ candidate }) => candidate)
	);
	const dependencyOwners = new Map<
		StorePathString,
		Set<NixDerivedPathString>
	>();
	const addDependency = (
		storePath: StorePathString,
		owner: NixDerivedPathString
	): void => {
		const owners = dependencyOwners.get(storePath) ?? new Set();

		owners.add(owner);
		dependencyOwners.set(storePath, owners);
	};

	const hasAccountableUnknowns = missing.unknown.some(
		(storePath) =>
			plannedLocalOutputs.has(storePath) ||
			options.plannedLocalClosure?.has(storePath) === true
	);
	const presentCandidates = candidates.filter(
		(candidate) => !candidate.stoppedAtDerivation
	);
	const presentAnswers: readonly CandidateAnswer[] = hasAccountableUnknowns
		? candidates.length === 1
			? presentCandidates.map((candidate) => ({
					candidate,
					partition: missing
				}))
			: await mapWithConcurrency(
					presentCandidates,
					maximumConcurrentConfirmations,
					async (candidate) => ({
						candidate,
						partition: await options.store.queryMissing([candidate.installable])
					})
				)
		: [];
	const referenceAnswers = [...substitutionAnswers, ...presentAnswers];

	for (const { candidate, partition } of referenceAnswers) {
		for (const storePath of partition.unknown) {
			if (
				!candidate.expectedPaths.includes(storePath) &&
				storePath !== candidate.plannedLocalDerivation
			) {
				addDependency(storePath, candidate.installable);
			}
		}
	}

	if (outputAvailability === undefined) {
		return { partition: missing, dependencyOwners };
	}
	const substitutingPaths = [
		...new Set(
			substitutionAnswers.flatMap(({ partition }) => partition.willSubstitute)
		)
	];
	const alreadyCounted = new Set(missing.willSubstitute);
	const newlySubstituting = substitutingPaths.filter(
		(storePath) => !alreadyCounted.has(storePath)
	);
	const newOffers =
		newlySubstituting.length === 0
			? []
			: await options.store.querySubstitutablePathInfos(newlySubstituting);
	const newBytes = sumSubstitutableBytes(newOffers);
	const candidatesByDerivation = Map.groupBy(
		stoppedCandidates,
		(candidate) => candidate.plannedLocalDerivation
	);
	const substitutingDerivations = new Set(
		candidatesByDerivation
			.entries()
			.filter(([, derivationCandidates]) =>
				derivationCandidates.every((candidate) => {
					const isAlreadyValid =
						candidate.outputsDeclared &&
						candidate.expectedPaths.every((path) => validExpected.has(path));

					return (
						isAlreadyValid ||
						(candidate.substitution === 'allowed' &&
							resolvedCandidates.has(candidate))
					);
				})
			)
			.map(([derivation]) => derivation)
	);

	return {
		partition: {
			...missing,
			willSubstitute: eachOnce(missing.willSubstitute, substitutingPaths),
			unknown: eachOnce(
				missing.unknown.filter(
					(storePath) => !substitutingDerivations.has(storePath)
				),
				dependencyOwners.keys().toArray()
			),
			downloadSize: missing.downloadSize + newBytes.downloadSize,
			narSize: missing.narSize + newBytes.narSize
		},
		dependencyOwners
	};
}

function plannedSubstitutionVerdict(
	policy: PlannedSubstitutionPolicy,
	canDerivationSubstitute: boolean
): 'allowed' | 'refused' | 'unknown' {
	if (policy.kind === 'unknown') {
		return 'unknown';
	}

	if (!policy.substitute) {
		return 'refused';
	}

	if (policy.alwaysAllowSubstitutes) {
		return 'allowed';
	}

	return canDerivationSubstitute ? 'allowed' : 'refused';
}

function expectedPathsForTarget(
	target: AvailabilityTarget,
	plannedLocalOutputs: ReadonlyMap<
		StorePathString,
		readonly NixDerivedPathString[]
	>,
	plannedFloatingOutputs: ReadonlySet<NixDerivedPathString> | undefined
): {
	readonly paths: readonly StorePathString[];
	readonly outputsDeclared: boolean;
} {
	if (target.plannedLocalDerivation === undefined) {
		return {
			paths: target.expectedPath === undefined ? [] : [target.expectedPath],
			outputsDeclared: false
		};
	}

	const selection = target.installable.split('^', 2)[1];
	const selectedNames =
		selection === undefined || selection === '*'
			? undefined
			: new Set(selection.split(','));
	const hasFloatingOutput =
		selectedFloatingOutputs(target, plannedFloatingOutputs).length > 0;
	const paths: StorePathString[] = [];

	for (const [path, installables] of plannedLocalOutputs) {
		const isSelectedOutput = installables.some((installable) => {
			const [derivation, outputName] = installable.split('^', 2);

			return (
				derivation === target.plannedLocalDerivation &&
				outputName !== undefined &&
				(selectedNames === undefined || selectedNames.has(outputName))
			);
		});

		if (isSelectedOutput) {
			paths.push(path);
		}
	}

	if (
		target.expectedPath !== undefined &&
		!paths.includes(target.expectedPath)
	) {
		paths.push(target.expectedPath);
	}

	if (paths.length > 0) {
		return { paths, outputsDeclared: !hasFloatingOutput };
	}

	return {
		paths: target.expectedPath === undefined ? [] : [target.expectedPath],
		outputsDeclared: !hasFloatingOutput
	};
}

function selectedFloatingOutputs(
	target: AvailabilityTarget,
	plannedFloatingOutputs: ReadonlySet<NixDerivedPathString> | undefined
): readonly NixDerivedPathString[] {
	if (target.plannedLocalDerivation === undefined) {
		return [];
	}

	const selection = target.installable.split('^', 2)[1];
	const selectedNames =
		selection === undefined || selection === '*'
			? undefined
			: new Set(selection.split(','));

	return [...(plannedFloatingOutputs ?? [])].filter((installable) => {
		const [derivation, outputName] = installable.split('^', 2);

		return (
			derivation === target.plannedLocalDerivation &&
			outputName !== undefined &&
			(selectedNames === undefined || selectedNames.has(outputName))
		);
	});
}

function sumSubstitutableBytes(
	offers: readonly NixSubstitutablePathInfo[]
): SubstitutablePathSize {
	let downloadSize = 0;
	let narSize = 0;

	for (const offer of offers) {
		downloadSize += offer.downloadSize;
		narSize += offer.narSize;
	}

	return { downloadSize, narSize };
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

// A remote store cannot inspect a derivation that it does not hold.
// `queryMissing` therefore reports that derivation as unknown and does not
// traverse its references. Paths in `plannedLocalClosure` can be copied before
// realisation when the plan records a target that requires them. The action can
// realise unknown outputs listed in `plannedLocalOutputs`. All other unknown
// paths still count against the ceiling.
function accountForLocalDerivations(
	missing: NixMissingPartition,
	targets: readonly AvailabilityTarget[],
	plannedLocalClosure: ReadonlySet<StorePathString> | undefined,
	plannedLocalOutputs:
		ReadonlyMap<StorePathString, readonly NixDerivedPathString[]> | undefined,
	dependencyOwners: ReadonlyMap<
		StorePathString,
		ReadonlySet<NixDerivedPathString>
	>,
	shouldAccountDependencies: boolean
): {
	readonly partition: NixMissingPartition;
	readonly dependencyBuilds: readonly AvailabilityDependencyBuild[];
	readonly dependencyCopies: readonly AvailabilityDependencyCopy[];
} {
	const localDerivations = new Set(
		targets.flatMap(({ plannedLocalDerivation }) =>
			plannedLocalDerivation === undefined ? [] : [plannedLocalDerivation]
		)
	);
	const copiedMissing = missing.unknown.filter((storePath) => {
		const isOwnedClosurePath =
			plannedLocalClosure?.has(storePath) === true &&
			dependencyOwners.has(storePath);

		if (isOwnedClosurePath) {
			return shouldAccountDependencies;
		}

		return localDerivations.has(storePath);
	});
	const buildableMissing = shouldAccountDependencies
		? missing.unknown.filter((storePath) => {
				const requiredBy = dependencyOwners.get(storePath);

				return (
					plannedLocalOutputs?.has(storePath) === true &&
					requiredBy !== undefined &&
					requiredBy.size > 0
				);
			})
		: [];
	const accountedMissing = eachOnce(copiedMissing, buildableMissing);
	const buildsByPath = new Map<
		StorePathString,
		{
			readonly installables: readonly NixDerivedPathString[];
			readonly requiredBy: Set<NixDerivedPathString>;
		}
	>();

	for (const storePath of buildableMissing) {
		const installables = plannedLocalOutputs?.get(storePath);

		if (installables === undefined || installables.length === 0) {
			continue;
		}

		const requiredBy = dependencyOwners.get(storePath) ?? new Set();
		const build = buildsByPath.get(storePath) ?? {
			installables,
			requiredBy: new Set<NixDerivedPathString>()
		};

		for (const owner of requiredBy) {
			build.requiredBy.add(owner);
		}

		buildsByPath.set(storePath, build);
	}

	const dependencyBuilds = [...buildsByPath].flatMap(
		([path, { installables, requiredBy }]) => {
			const [firstInstallable, ...remainingInstallables] = installables;
			const [firstOwner, ...remainingOwners] = requiredBy;

			return firstInstallable === undefined || firstOwner === undefined
				? []
				: [
						{
							path,
							installables: [
								firstInstallable,
								...remainingInstallables
							] as const,
							requiredBy: [firstOwner, ...remainingOwners] as const
						}
					];
		}
	);
	const dependencyCopies = copiedMissing.flatMap((path) => {
		if (plannedLocalOutputs?.has(path) === true) {
			return [];
		}

		const requiredBy = dependencyOwners.get(path);
		const [firstOwner, ...remainingOwners] = requiredBy ?? [];

		return firstOwner === undefined
			? []
			: [{ path, requiredBy: [firstOwner, ...remainingOwners] as const }];
	});
	const buildableDerivations = dependencyBuilds.map(({ installables }) => {
		const installable = installables[0];
		const selection = installable.indexOf('^');

		return storePathSchema.parse(
			selection === -1 ? installable : installable.slice(0, selection)
		);
	});

	if (accountedMissing.length === 0) {
		return { partition: missing, dependencyBuilds, dependencyCopies };
	}

	const accountedFor = new Set(accountedMissing);
	const missingTargetDerivations = copiedMissing.filter((storePath) =>
		localDerivations.has(storePath)
	);

	return {
		partition: {
			...missing,
			willBuild: eachOnce(
				missing.willBuild,
				eachOnce(missingTargetDerivations, buildableDerivations)
			),
			unknown: missing.unknown.filter(
				(storePath) => !accountedFor.has(storePath)
			)
		},
		dependencyBuilds,
		dependencyCopies
	};
}

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

// Each confirmation walks a closure over its own daemon connections, so keep
// the fan-out small.
const maximumConcurrentConfirmations = 4;

// Raw substitutability only identifies candidates for upstream availability.
// Confirm each path-and-installable pair because aliases can share a path while
// their derivations apply different substitution policies.
async function confirmCandidates(
	classified: readonly ClassifiedTarget[],
	options: AvailabilityPartitionOptions
): Promise<readonly LeftUpstreamRejection[]> {
	const candidates = new Map<
		StorePathString,
		Map<NixDerivedPathString, UpstreamAvailabilityCandidate>
	>();

	for (const { target, classification } of classified) {
		if (classification.bucket !== 'leftUpstream') {
			continue;
		}

		const aliases =
			candidates.get(classification.path) ??
			new Map<NixDerivedPathString, UpstreamAvailabilityCandidate>();
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
			verdict: await options.confirmUpstreamAvailability(candidate)
		})
	);

	return verdicts.flatMap(({ storePath, verdict }) =>
		verdict.kind === 'confirmed' ? [] : [{ ...verdict, storePath }]
	);
}

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

function unattestedPaths(
	classified: readonly ClassifiedTarget[],
	attestedServedPaths: ReadonlySet<StorePathString> | undefined
): ReadonlySet<StorePathString> {
	if (attestedServedPaths === undefined) {
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

	return new Set(
		attachOnlyPaths
			.values()
			.filter((storePath) => !attestedServedPaths.has(storePath))
	);
}

// Attaching a target to its root publishes a path already served by the
// destination cache. When that cache holds no attestation for the path, the
// published target has no provenance, so a run that requires attested
// availability puts the target in the build set and attaches an attestation to
// the newly built output.
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
 * Classifies one target from the destination, view and substitutability
 * answers that apply to it, checked in that order of precedence. Exported so a
 * later re-probe over a subset of the same targets classifies by these rules
 * and no others.
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

// `roots.ensure` reports the exact target list from the root's last
// reconciliation. A `retained` answer means the cache serves all of those
// targets. Every other answer lists unserved targets in `unavailable`, so any
// target absent from that list is served.
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

// The first query can classify a path as unknown from a cached narinfo miss.
// Re-query unknown paths without that cache before enforcing the ceiling.
async function classifyUnknowns(
	missing: Awaited<ReturnType<Nix['queryMissing']>>,
	dependencyOwners: ReadonlyMap<
		StorePathString,
		ReadonlySet<NixDerivedPathString>
	>,
	options: AvailabilityPartitionOptions
): Promise<{
	readonly partition: NixMissingPartition;
	readonly ceiling: AvailabilityCeiling;
	readonly dependencyOwners: ReadonlyMap<
		StorePathString,
		ReadonlySet<NixDerivedPathString>
	>;
}> {
	const configured = {
		value: options.ceiling.value,
		source: 'configured' as const
	};

	if (missing.unknown.length === 0) {
		return { partition: missing, ceiling: configured, dependencyOwners };
	}

	const groupsByOwners = new Map<
		string,
		{
			readonly paths: StorePathString[];
			readonly requiredBy: readonly NixDerivedPathString[];
		}
	>();

	for (const storePath of missing.unknown) {
		const requiredBy = [...(dependencyOwners.get(storePath) ?? [])].toSorted(
			byCodeUnit
		);
		const key = JSON.stringify(requiredBy);
		const group = groupsByOwners.get(key) ?? { paths: [], requiredBy };

		group.paths.push(storePath);
		groupsByOwners.set(key, group);
	}

	const answers = await mapWithConcurrency(
		groupsByOwners.values().toArray(),
		maximumConcurrentConfirmations,
		async (group) => ({
			...group,
			outcome: await options.requeryUnknown(group.paths)
		})
	);
	const refused = answers.find(({ outcome }) => outcome.kind === 'refused');

	if (refused?.outcome.kind === 'refused') {
		return {
			partition: missing,
			ceiling: {
				value: options.ceiling.untrustedFallback,
				source: 'untrusted-fallback',
				fallbackReason: refused.outcome.reason
			},
			dependencyOwners
		};
	}

	let partition = missing;
	const refreshedOwners = new Map<StorePathString, Set<NixDerivedPathString>>(
		[...dependencyOwners].map(([storePath, requiredBy]) => [
			storePath,
			new Set(requiredBy)
		])
	);

	for (const { paths, requiredBy, outcome } of answers) {
		if (outcome.kind !== 'answered') {
			continue;
		}

		partition = mergeRequeryAnswer(partition, paths, outcome);

		for (const storePath of outcome.partition.unknown) {
			const owners = refreshedOwners.get(storePath) ?? new Set();

			for (const owner of requiredBy) {
				owners.add(owner);
			}

			if (owners.size > 0) {
				refreshedOwners.set(storePath, owners);
			}
		}
	}

	return {
		partition,
		ceiling: configured,
		dependencyOwners: refreshedOwners
	};
}

function mergeRequeryAnswer(
	missing: NixMissingPartition,
	queriedPaths: readonly StorePathString[],
	outcome: Extract<UnknownRequeryOutcome, { readonly kind: 'answered' }>
): NixMissingPartition {
	const requery = outcome.partition;
	const toBuild = eachOnce(missing.willBuild, requery.willBuild);
	const toSubstitute = eachOnce(missing.willSubstitute, requery.willSubstitute);
	const classified = new Set([...toBuild, ...toSubstitute]);
	const twice = bytesCountedTwice(missing, requery, outcome.sizes);
	const queried = new Set(queriedPaths);

	return {
		willBuild: toBuild,
		willSubstitute: toSubstitute,
		unknown: eachOnce(
			missing.unknown.filter(
				(storePath) => !queried.has(storePath) && !classified.has(storePath)
			),
			requery.unknown.filter((storePath) => !classified.has(storePath))
		),
		downloadSize:
			missing.downloadSize + requery.downloadSize - twice.downloadSize,
		narSize: missing.narSize + requery.narSize - twice.narSize
	};
}

/**
 * The download and NAR bytes included in both answers. Each answer reports one
 * total for its substitutable paths, so adding the totals counts their
 * intersection twice. The caller subtracts what this function returns.
 *
 * The per-path figures come from the re-query, which is enough on its own: a
 * path in both totals is one the re-query classified as substitutable, so the
 * re-query asked for its size. A path whose size did not come back stays
 * counted twice, because the merged total is read as the bytes substitution
 * would fetch and subtracting a guess could put it below the true figure.
 */
function bytesCountedTwice(
	missing: NixMissingPartition,
	requery: NixMissingPartition,
	sizes: ReadonlyMap<StorePathString, SubstitutablePathSize>
): SubstitutablePathSize {
	const freshlySubstitutable = new Set(requery.willSubstitute);
	const countedTwice = new Set(
		missing.willSubstitute.filter((storePath) =>
			freshlySubstitutable.has(storePath)
		)
	);
	let downloadSize = 0;
	let narSize = 0;

	for (const storePath of countedTwice) {
		const size = sizes.get(storePath);

		downloadSize += size?.downloadSize ?? 0;
		narSize += size?.narSize ?? 0;
	}

	return { downloadSize, narSize };
}

function eachOnce(
	first: readonly StorePathString[],
	second: readonly StorePathString[]
): readonly StorePathString[] {
	return [...new Set([...first, ...second])];
}
