import type { BuildReceipt } from '@cupboard/protocol/build';

import { isAbortError } from '../abort.ts';
import { BuildCommandFailedError } from '../errors.ts';

import type { BuildInvocation } from './build-push.ts';

export interface CohortSequenceOptions {
	readonly cohorts: readonly BuildInvocation[];
	readonly signal?: AbortSignal;
	/**
	 * Collect the local store at cohort boundaries, so the next cohort
	 * substitutes the earlier shared work from the cache; off unless set, so a
	 * run never deletes the user's paths by default.
	 */
	readonly collectBetweenCohorts?: boolean;
	readonly collectAfterLast?: boolean;
	/**
	 * Continue after an ordinary cohort failure; aborts and signalled children
	 * always stop the sequence. Off unless set.
	 */
	readonly keepGoingCohorts?: boolean;
}

export interface CohortFailure {
	readonly cohort: number;
	readonly error: unknown;
	readonly kind: 'target-build' | 'command';
}

export interface CohortSequenceResult {
	readonly receipts: readonly BuildReceipt[];
	/**
	 * Failed cohorts remain in run order. A fatal failure takes precedence over
	 * target build failures when the caller chooses the run status.
	 */
	readonly failures: readonly CohortFailure[];
}

/**
 * Returns the first fatal failure, or the first target failure if all failures
 * are target builds.
 */
export function cohortSequenceFailure(
	failures: readonly CohortFailure[]
): CohortFailure | undefined {
	return failures.find((failure) => failure.kind === 'command') ?? failures[0];
}

function failureKind(
	error: unknown,
	receipt: BuildReceipt | undefined
): CohortFailure['kind'] {
	return error instanceof BuildCommandFailedError &&
		error.signal === undefined &&
		error.status !== undefined &&
		error.status !== 0 &&
		receipt?.version === 3 &&
		receipt.childExitStatus === error.status &&
		receipt.terminalFailure?.kind === 'target-build' &&
		(receipt.failed?.length ?? 0) === 0
		? 'target-build'
		: 'command';
}

export interface CohortSequenceDependencies {
	readonly runCohort: (
		invocation: BuildInvocation,
		cohort: number
	) => Promise<BuildReceipt>;
	readonly recoverReceipt?: (
		error: unknown,
		cohort: number
	) => Promise<BuildReceipt | undefined>;
	readonly collect?: () => Promise<void>;
}

// Keep-going is a build-failure policy, not a cancellation policy. An abort
// and a child killed by a signal are both the user's request to end the whole
// sequence, so neither may start another cohort after the signal has passed.
function shouldStopSequence(error: unknown): boolean {
	return (
		isAbortError(error) ||
		(error instanceof BuildCommandFailedError && error.signal !== undefined)
	);
}

/**
 * Runs the cohorts sequentially, each one finishing and draining before the
 * next starts, so an earlier cohort's shared paths are already published by the
 * time a later cohort needs them. Collection only runs at a boundary the run
 * opted into: between cohorts when the setting is on, after the last only when
 * additionally configured, and never when the setting is off. An ordinary
 * cohort failure stops the sequence unless the keep-going option is set;
 * cancellation stops it either way. The result reports the failures alongside
 * the receipts produced during the run. Failures without validated target build
 * evidence also contribute a command failure to receipt aggregation.
 */
export async function runCohortSequence(
	options: CohortSequenceOptions,
	dependencies: CohortSequenceDependencies
): Promise<CohortSequenceResult> {
	const receipts: BuildReceipt[] = [];
	const failures: CohortFailure[] = [];

	for (const [index, invocation] of options.cohorts.entries()) {
		options.signal?.throwIfAborted();

		const cohort = index + 1;

		try {
			receipts.push(await dependencies.runCohort(invocation, cohort));
		} catch (error) {
			const receipt = await dependencies.recoverReceipt?.(error, cohort);

			if (receipt !== undefined) {
				receipts.push(receipt);
			}

			const kind = failureKind(error, receipt);

			if (
				kind === 'command' &&
				!(receipt?.version === 3 && receipt.terminalFailure?.kind === 'command')
			) {
				receipts.push({
					version: 3,
					paths: [],
					subjects: [],
					terminalFailure: { kind: 'command' }
				});
			}

			failures.push({ cohort, error, kind });

			if (options.keepGoingCohorts !== true || shouldStopSequence(error)) {
				return { receipts, failures };
			}
		}

		const isLast = index === options.cohorts.length - 1;
		const shouldCollect =
			options.collectBetweenCohorts === true &&
			(!isLast || options.collectAfterLast === true);

		if (shouldCollect) {
			options.signal?.throwIfAborted();
			await dependencies.collect?.();
		}

		options.signal?.throwIfAborted();
	}

	return { receipts, failures };
}
