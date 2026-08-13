import type { NixBuildSettings } from '@cupboard/nix';
import {
	type DerivationBuildRequirements,
	derivationPathOf
} from '@cupboard/nix-store/derivation';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import { type UnverifiableTarget, UnverifiableTargetError } from '../errors.ts';

/** Reads what a derivation in the store asks of the machine that builds it. */
export type DerivationRequirements = (
	drvPath: string
) => Promise<DerivationBuildRequirements>;

export interface VerificationSupportOptions {
	/** Whether the run rebuilds its targets locally once the build succeeds. */
	readonly verifyRebuilds: boolean;
	/** The installables the run declares as its targets. */
	readonly installables: readonly string[];
	/** What the coordinating machine builds, and the builders behind it. */
	readonly building: NixBuildSettings;
	readonly requirements: DerivationRequirements;
}

// How many derivations are read from the store at once. Each read streams one
// derivation over its own daemon connection, so the fan-out is bounded.
const derivationReadConcurrency = 8;

/**
 * Refuses a run whose verification rebuild the coordinating machine could not
 * perform. The rebuild runs with remote builders off, so every declared target
 * has to be one this machine builds itself: its system among the ones this
 * machine covers, and every feature it requires among the ones this machine
 * offers.
 *
 * The refusal is confined to the runs that would hit it. A run that does not
 * verify never rebuilds anything locally, a run with no remote builders
 * configured cannot reach a foreign target's build in the first place, and a
 * machine whose own system is unknown has nothing to compare against. An
 * installable that does not name a derivation in the store, such as a flake
 * attribute, states nothing here to compare either.
 */
export async function requireVerifiableTargets(
	options: VerificationSupportOptions
): Promise<void> {
	const { building } = options;

	if (
		!options.verifyRebuilds ||
		building.builders === undefined ||
		building.systems.length === 0
	) {
		return;
	}

	const drvPaths = [
		...new Set(
			options.installables.flatMap((installable) => {
				const drvPath = derivationPathOf(installable);

				return drvPath === undefined ? [] : [drvPath];
			})
		)
	];
	const targets = await mapWithConcurrency(
		drvPaths,
		derivationReadConcurrency,
		async (drvPath) => ({
			drvPath,
			requirements: await options.requirements(drvPath)
		})
	);
	const unverifiable = targets.flatMap(
		({ drvPath, requirements }): readonly UnverifiableTarget[] => {
			const missingFeatures = requirements.requiredSystemFeatures.filter(
				(feature) => !building.features.includes(feature)
			);

			if (
				building.systems.includes(requirements.system) &&
				missingFeatures.length === 0
			) {
				return [];
			}

			return [{ drvPath, system: requirements.system, missingFeatures }];
		}
	);

	if (unverifiable.length === 0) {
		return;
	}

	throw new UnverifiableTargetError(
		unverifiable,
		building.systems,
		building.features
	);
}
