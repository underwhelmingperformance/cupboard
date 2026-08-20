import type { NixDerivedPathString } from '@cupboard/nix';
import type { RootName, StorePathString } from '@cupboard/nix-store/scalars';
import type { ParsedRootEnsureResponse } from '@cupboard/protocol/retention';

import {
	type AvailabilityTarget,
	classify,
	type DestinationProbes
} from './availability-partition.ts';

/**
The destination bucket assigned to a target removed from the build set.
*/
export type WithdrawnOutcome = 'attachOnly' | 'publishByReference';

/**
 * One target removed from the build set. This includes the installable no
 * longer passed to Nix, the now-available store path, and the destination
 * bucket.
 */
export interface WithdrawnTarget {
	readonly installable: NixDerivedPathString;
	readonly storePath: StorePathString;
	readonly outcome: WithdrawnOutcome;
}

export interface AvailabilityReprobeOptions {
	/**
	The current build set, with one entry for each target Nix will realise.
	*/
	readonly targets: readonly AvailabilityTarget[];
	readonly destinationProbes: DestinationProbes;
}

/**
The remaining build set and the targets removed from it.
*/
export interface AvailabilityReprobe {
	readonly buildSet: readonly NixDerivedPathString[];
	readonly withdrawn: readonly WithdrawnTarget[];
}

// The re-probe asks the destination and the reuse view, never a retention
// root: the first partition already classified a target that a root serves as
// attach-only, so such a target is not in the build set to begin with.
const noRootEnsureResults: ReadonlyMap<RootName, ParsedRootEnsureResponse> =
	new Map();

// Only the initial partition can exclude a target from publication because an
// upstream substituter serves it. That decision requires confirmation that a
// consumer can fetch the exact path held by this run. The re-probe therefore
// passes an empty set of substitutable paths.
const noSubstitutableExternal: ReadonlySet<StorePathString> = new Set();

/**
 * Immediately before dispatch, queries the predictable output paths in the
 * destination and reuse view. A target that has become available is removed
 * from the build set so it can be attached to its root or published by
 * reference. All other targets remain. Availability can change again after
 * this query, in which case Nix reports the resulting build failure normally.
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
		options.destinationProbes.destinationServed(knownPaths),
		options.destinationProbes.viewServed(knownPaths)
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
