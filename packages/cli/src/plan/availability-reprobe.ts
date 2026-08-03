import type { Nix, NixDerivedPathString } from '@cupboard/nix';
import {
	type RootName,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import type { ParsedRootEnsureResponse } from '@cupboard/protocol/retention';

import {
	type AvailabilityTarget,
	classify,
	type DestinationAnswers
} from './availability-partition.ts';

/** The bucket a withdrawn target moved into, named as the partition names it. */
export type WithdrawnOutcome =
	'attachOnly' | 'publishByReference' | 'leftUpstream';

/**
 * One target the re-probe took out of the build set: the installable Nix is no
 * longer asked to realise, the path that answers for it, and the outcome the
 * partition's own rules give it now that it is available.
 */
export interface WithdrawnTarget {
	readonly installable: NixDerivedPathString;
	readonly storePath: StorePathString;
	readonly outcome: WithdrawnOutcome;
}

export interface AvailabilityReprobeOptions {
	/** The build set as it stands, one entry per target Nix is about to realise. */
	readonly targets: readonly AvailabilityTarget[];
	/** The store the build itself will run against; no override applied. */
	readonly store: Pick<Nix, 'querySubstitutablePaths' | 'queryValidPaths'>;
	readonly destinationAnswers: DestinationAnswers;
}

/** The build set as the re-probe leaves it, with what it took out of it. */
export interface AvailabilityReprobe {
	readonly buildSet: readonly NixDerivedPathString[];
	readonly withdrawn: readonly WithdrawnTarget[];
}

// The re-probe asks the store and the destination, never a retention root: a
// target a root already served was answered by the first partition and is not
// in the build set to begin with.
const noRootEnsureResults: ReadonlyMap<RootName, ParsedRootEnsureResponse> =
	new Map();

/**
 * Confirms, immediately before the build set is dispatched, that every target
 * in it still needs realising. The exact requested outputs are asked of the
 * store the build will run against, and of the destination and reuse view, in
 * one batch per question however large the build set is. A target that has
 * become available since the partition settled is withdrawn under the same
 * rules the partition applied, so it takes the outcome it would have had had
 * the partition seen it. Availability is racy: a path can go again straight
 * after the answer, and Nix reports that failure the way it reports any other.
 */
export async function reprobeAvailability(
	options: AvailabilityReprobeOptions
): Promise<AvailabilityReprobe> {
	const knownPaths = options.targets
		.map((target) => target.expectedPath)
		.filter((path): path is StorePathString => path !== undefined);

	if (knownPaths.length === 0) {
		return {
			buildSet: options.targets.map((target) => target.installable),
			withdrawn: []
		};
	}

	const [destinationServedPaths, viewServedPaths, validPaths] =
		await Promise.all([
			options.destinationAnswers.destinationServed(knownPaths),
			options.destinationAnswers.viewServed(knownPaths),
			options.store.queryValidPaths(knownPaths)
		]);

	// The same restriction the partition applies: only a path this store already
	// holds valid is a "leave it upstream" candidate.
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

	const buildSet: NixDerivedPathString[] = [];
	const withdrawn: WithdrawnTarget[] = [];

	for (const target of options.targets) {
		const classification = classify(
			target,
			destinationServedPaths,
			viewServedPaths,
			substitutableExternal,
			noRootEnsureResults
		);

		if (classification.bucket === 'buildSet') {
			buildSet.push(target.installable);
			continue;
		}

		withdrawn.push({
			installable: target.installable,
			storePath: classification.path,
			outcome: classification.bucket
		});
	}

	return { buildSet, withdrawn };
}
