import type { NixDerivedPathString } from '@cupboard/nix';
import type { RootName, StorePathString } from '@cupboard/nix-store/scalars';
import type { ParsedRootEnsureResponse } from '@cupboard/protocol/retention';

import {
	type AvailabilityTarget,
	classify,
	type DestinationProbes
} from './availability-partition.ts';

export type WithdrawnOutcome = 'attachOnly' | 'publishByReference';

export interface WithdrawnTarget {
	readonly installable: NixDerivedPathString;
	readonly storePath: StorePathString;
	readonly outcome: WithdrawnOutcome;
}

export interface AvailabilityReprobeOptions {
	readonly targets: readonly AvailabilityTarget[];
	readonly destinationProbes: DestinationProbes;
}

export interface AvailabilityReprobe {
	readonly buildSet: readonly NixDerivedPathString[];
	readonly withdrawn: readonly WithdrawnTarget[];
}

// The initial partition removes any target whose retained root still serves
// its output. No such target can reach this second probe.
const noRootEnsureResults: ReadonlyMap<RootName, ParsedRootEnsureResponse> =
	new Map();

// Only the initial partition may leave a target with an upstream substituter.
// That decision compares the offered NAR with the local path and applies the
// consumer's signature policy. This probe does not repeat that confirmation.
const noSubstitutableExternal: ReadonlySet<StorePathString> = new Set();

/**
 * Immediately before dispatch, queries the predictable output paths in the
 * destination and reuse view. It removes a target when the destination now
 * serves its path or the reuse view can now supply it for publication by
 * reference. All other targets remain. If availability changes again after
 * this query, Nix reports any resulting build failure normally.
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
