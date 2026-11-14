import {
	builderFailures,
	buildFailureStatuses,
	type Nix,
	unreachableBuilders
} from '@cupboard/nix';
import { parseBuildActivities } from '@cupboard/nix/build-observation';
import type { StorePathString } from '@cupboard/nix-store/scalars';

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

The log has no record of Nix's `BuildResult` status, but Nix words each
failure status differently. {@link buildFailureStatuses} recovers the status
from that wording. These statuses are not retried:

- `not-deterministic`, which `--rebuild` and `--check` report when the outputs
  differ. A later identical build can pass, and that would hide the
  non-determinism from the verification that the flag exists for. No other
  failure in the log changes this.
- `log-limit-exceeded` and `output-rejected`, which repeat on every attempt.
  This includes the output-rejected failure of a fixed-output derivation,
  which the network rule above would otherwise retry.
- `timed-out`, because a retry costs another full timeout. The exception is
  a stalled download that `max-silent-time` ended, which can succeed on a
  retry. A local timeout message does not include a derivation, and the
  build activity of the derivation has already stopped when Nix logs the
  message, so the log cannot show which build timed out. The exception
  therefore applies when any derivation that the log shows as built locally
  is a fixed-output or impure derivation. The build hook's message for a
  remote timeout includes the derivation, and the exception applies when that
  derivation is a fixed-output or impure derivation.
- `input-rejected`, which Nix reports when no machine has the required system
  or system features. A retry does not add the missing machine or feature.
  The exception is a log in which the build hook failed to use a remote
  machine ({@link unreachableBuilders}). Nix then stops using that machine,
  and it reports the same status when no enabled machine is left. A retry
  tries the machine again.
- `dependency-failed` passes on the failure of a dependency. The log also
  has the dependency's own failure, and that failure decides the retry. A
  log that has only the `dependency-failed` message has no classification.

An attempt is not retried when its log reports a non-deterministic build, or
when it reports at least one other failure and every one of them is permanent.
*/
export async function canRetryBuild(
	log: string,
	store: Pick<Nix, 'readDerivation'>
): Promise<boolean> {
	const statuses = buildFailureStatuses(log).filter(
		(status) => status.kind !== 'dependency-failed'
	);

	if (statuses.some((status) => status.kind === 'not-deterministic')) {
		return false;
	}

	const hasUnreachableBuilder = unreachableBuilders(log).length > 0;
	const localDerivations = parseBuildActivities(log)
		.filter((activity) => activity.machine === '')
		.map((activity) => activity.derivation);

	for (const status of statuses) {
		if (hasUnreachableBuilder && status.kind === 'input-rejected') {
			return true;
		}

		if (status.kind !== 'timed-out') {
			continue;
		}

		const timedOut =
			status.derivation === undefined ? localDerivations : [status.derivation];

		if (await hasNetworkAccess(timedOut, store)) {
			return true;
		}
	}

	const rejected = new Set(statuses.map((status) => status.derivation));
	const failures = builderFailures(log).filter(
		(failure) => !rejected.has(failure.derivation)
	);

	if (failures.length === 0) {
		return statuses.length === 0;
	}

	const machines = new Map<StorePathString, string>(
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

async function hasNetworkAccess(
	derivations: readonly string[],
	store: Pick<Nix, 'readDerivation'>
): Promise<boolean> {
	for (const derivation of derivations) {
		if (!(await isKnownSandboxed(derivation, store))) {
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
