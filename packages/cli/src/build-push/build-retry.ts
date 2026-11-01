import { builderFailures, type Nix } from '@cupboard/nix';
import { parseBuildActivities } from '@cupboard/nix/build-observation';

/**
Given the activity log of a failed `nix build` attempt, decides whether
another attempt could succeed. `nix build` exits with status 1 for every
build failure, so the decision repeats Nix's own classification from the log
and the failed derivations.

Nix reports a builder failure on the local machine as permanent when the
derivation is input-addressed or floating content-addressed and the disk was
not full. Every other failure is retried, each for its own reason:

- A fixed-output or impure derivation has network access, so its builder can
  fail because of the network.
- A build that failed because the disk was full may succeed once space is
  freed.
- Nix reports a failure on a remote builder as `MiscFailure`, because it
  cannot tell a failed builder from a lost connection.
- A failure without a builder message has no classification, so it is retried
  as well.
- When the failed derivation cannot be read, for example because garbage
  collection removed it, the failure has no classification either.

An attempt is not retried only when its log reports at least one builder
failure and every one of them is permanent.
*/
export async function canRetryBuild(
	log: string,
	store: Pick<Nix, 'readDerivation'>
): Promise<boolean> {
	const failures = builderFailures(log);

	if (failures.length === 0) {
		return true;
	}

	const machines = new Map(
		parseBuildActivities(log).map((activity) => [
			activity.derivation,
			activity.machine
		])
	);

	for (const failure of failures) {
		if (
			failure.isDiskFull ||
			machines.get(failure.derivation) !== '' ||
			!(await isKnownSandboxed(failure.derivation, store))
		) {
			return true;
		}
	}

	return false;
}

async function isKnownSandboxed(
	derivationPath: string,
	store: Pick<Nix, 'readDerivation'>
): Promise<boolean> {
	try {
		const derivation = await store.readDerivation(derivationPath);

		return derivation.isSandboxed;
	} catch {
		return false;
	}
}
