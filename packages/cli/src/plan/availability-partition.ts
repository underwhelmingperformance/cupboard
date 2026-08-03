import type { Nix, NixDaemonTrust, NixDerivedPathString } from '@cupboard/nix';
import {
	type RootName,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import type { ParsedRootEnsureResponse } from '@cupboard/protocol/retention';

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
 * answer settles: the configured value applies whenever the daemon
 * connection is trusted (and may be zero, for a fixture that requires every
 * path to resolve), and the nonzero fallback applies otherwise, since an
 * untrusted connection cannot be relied on to honour the bypass client's
 * negative-cache override.
 */
export interface AvailabilityCeilingConfig {
	readonly value: number;
	readonly untrustedFallback: number;
}

export type CeilingSource = 'configured' | 'untrusted-fallback';

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
		'queryMissing' | 'querySubstitutablePaths' | 'queryValidPaths'
	>;
	readonly destinationAnswers: DestinationAnswers;
	/** One `roots.ensure` result per target root, keyed by root name. */
	readonly rootEnsureResults: ReadonlyMap<RootName, ParsedRootEnsureResponse>;
	readonly daemonTrust: () => Promise<NixDaemonTrust>;
	/**
	 * Opens a daemon connection carrying a `narinfo-cache-negative-ttl=0`
	 * override, built by the caller on `Nix.openDaemon`. Reached only when
	 * `daemonTrust()` reports `'trusted'`, since the daemon silently drops an
	 * untrusted client's overrides.
	 */
	readonly openReQueryClient: () => Pick<Nix, 'queryMissing'>;
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
	readonly buildSet: readonly NixDerivedPathString[];
	readonly counts: {
		readonly willBuild: number;
		readonly willSubstitute: number;
		readonly unknown: number;
	};
	readonly downloadSize: number;
	readonly narSize: number;
	/** Equal to `counts.unknown`, flattened for a capacity preflight to read directly. */
	readonly unknownCount: number;
	readonly ceiling: AvailabilityCeiling;
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

const untrustedFallbackReason =
	'the daemon connection is not fully trusted, so its narinfo-cache-negative-ttl override cannot be relied on to take effect';

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

	for (const target of options.targets) {
		const classification = classify(
			target,
			destinationServedPaths,
			viewServedPaths,
			substitutableExternal,
			options.rootEnsureResults
		);

		addToBucket(buckets, target, classification);
	}

	return {
		attachOnly,
		publishByReference,
		leftUpstream,
		buildSet,
		counts: {
			willBuild: settled.willBuild.length,
			willSubstitute: settled.willSubstitute.length,
			unknown: settled.unknown.length
		},
		downloadSize: settled.downloadSize,
		narSize: settled.narSize,
		unknownCount: settled.unknown.length,
		ceiling
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

// A trusted connection gets one more chance to resolve what negative-cached
// narinfo answers left unknown, through a dedicated client carrying the
// bypass override; an untrusted one is not asked at all, since the daemon
// would silently drop the override that makes the re-query meaningful.
async function settleUnknowns(
	missing: Awaited<ReturnType<Nix['queryMissing']>>,
	options: AvailabilityPartitionOptions
): Promise<{
	readonly partition: SettledMissing;
	readonly ceiling: AvailabilityCeiling;
}> {
	if (missing.unknown.length === 0) {
		return {
			partition: missing,
			ceiling: { value: options.ceiling.value, source: 'configured' }
		};
	}

	const trust = await options.daemonTrust();

	if (trust !== 'trusted') {
		return {
			partition: missing,
			ceiling: {
				value: options.ceiling.untrustedFallback,
				source: 'untrusted-fallback',
				fallbackReason: untrustedFallbackReason
			}
		};
	}

	const requery = await options
		.openReQueryClient()
		.queryMissing(missing.unknown);

	return {
		partition: {
			willBuild: [...missing.willBuild, ...requery.willBuild],
			willSubstitute: [...missing.willSubstitute, ...requery.willSubstitute],
			unknown: requery.unknown,
			downloadSize: missing.downloadSize + requery.downloadSize,
			narSize: missing.narSize + requery.narSize
		},
		ceiling: { value: options.ceiling.value, source: 'configured' }
	};
}
