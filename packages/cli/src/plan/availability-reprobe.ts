import type { NixDerivedPathString } from '@cupboard/nix';
import type { RootName, StorePathString } from '@cupboard/nix-store/scalars';
import type { ParsedRootEnsureResponse } from '@cupboard/protocol/retention';

import {
	type AvailabilityTarget,
	classify,
	type DestinationAnswers
} from './availability-partition.ts';

/** The bucket a withdrawn target moved into, named as the partition names it. */
export type WithdrawnOutcome = 'attachOnly' | 'publishByReference';

/**
 * One target the re-probe took out of the build set: the installable Nix is no
 * longer asked to realise, the store path that is now available, and the bucket
 * the target moved into.
 */
export interface WithdrawnTarget {
	readonly installable: NixDerivedPathString;
	readonly storePath: StorePathString;
	readonly outcome: WithdrawnOutcome;
}

export interface AvailabilityReprobeOptions {
	/** The build set as it stands, one entry per target Nix is about to realise. */
	readonly targets: readonly AvailabilityTarget[];
	readonly destinationAnswers: DestinationAnswers;
}

/** The build set as the re-probe leaves it, with what it took out of it. */
export interface AvailabilityReprobe {
	readonly buildSet: readonly NixDerivedPathString[];
	readonly withdrawn: readonly WithdrawnTarget[];
}

// The re-probe asks the destination and the reuse view, never a retention
// root: the first partition already classified a target that a root serves as
// attach-only, so such a target is not in the build set to begin with.
const noRootEnsureResults: ReadonlyMap<RootName, ParsedRootEnsureResponse> =
	new Map();

// Only the partition's confirmation may leave a target upstream: it proves a
// consumer could fetch exactly what this run holds before anyone is sent to a
// substituter for it. The re-probe therefore passes an empty substitutable
// set, so it never leaves a target upstream itself.
const noSubstitutableExternal: ReadonlySet<StorePathString> = new Set();

/**
 * Confirms, immediately before the build set is dispatched, that every target
 * in it still needs realising. The exact requested outputs are asked of the
 * destination and of the reuse view, in one batch per question however large
 * the build set is. A target either of them has gained since the partition
 * settled is withdrawn, to be attached to its root or published by reference.
 * Every other target keeps its place in the build set. Availability is racy: a
 * path can disappear again immediately after the answer, and Nix reports the
 * resulting failure as it reports any other.
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

	const [destinationServedPaths, viewServedPaths] = await Promise.all([
		options.destinationAnswers.destinationServed(knownPaths),
		options.destinationAnswers.viewServed(knownPaths)
	]);

	const buildSet: NixDerivedPathString[] = [];
	const withdrawn: WithdrawnTarget[] = [];

	for (const target of options.targets) {
		const classification = classify(
			target,
			destinationServedPaths,
			viewServedPaths,
			noSubstitutableExternal,
			noRootEnsureResults
		);

		if (
			classification.bucket !== 'attachOnly' &&
			classification.bucket !== 'publishByReference'
		) {
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
