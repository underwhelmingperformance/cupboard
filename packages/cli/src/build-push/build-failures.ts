import { builderFailures } from '@cupboard/nix';
import { parseBuildActivities } from '@cupboard/nix/build-observation';
import type { StorePathString } from '@cupboard/nix-store/scalars';

import type { SupervisedAttempt } from './supervisor.ts';

/**
Lists failed builders across the run, excluding derivations built by a later
successful attempt. Results follow the order of the remaining failures.
*/
export function failedDerivations(
	attempts: readonly Pick<SupervisedAttempt, 'log' | 'exit'>[]
): readonly StorePathString[] {
	const failed = new Set<StorePathString>();

	for (const attempt of attempts) {
		if (attempt.exit.status === 0) {
			for (const activity of parseBuildActivities(attempt.log)) {
				failed.delete(activity.derivation);
			}

			continue;
		}

		for (const failure of builderFailures(attempt.log)) {
			failed.add(failure.derivation);
		}
	}

	return failed.values().toArray();
}
