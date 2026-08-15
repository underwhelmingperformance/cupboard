import type { ParsedBuildReceipt } from '@cupboard/protocol/build';

import { isAbortError } from '../abort.ts';
import { BuildCommandFailedError } from '../errors.ts';

import type { BuildInvocation } from './build-push.ts';

export interface CohortSequenceOptions {
	/**
	The cohorts to build, in order; each finishes before the next starts.
	*/
	readonly cohorts: readonly BuildInvocation[];
	/**
	The enclosing CLI run's cancellation signal.
	*/
	readonly signal?: AbortSignal;
	/**
	 * Collect the local store at cohort boundaries, so the next cohort
	 * substitutes the earlier shared work from the cache; off unless set, so a
	 * run never deletes the user's paths by default.
	 */
	readonly collectBetweenCohorts?: boolean;
	/**
	Also collect once the final cohort has finished; off unless set.
	*/
	readonly collectAfterLast?: boolean;
	/**
	 * Continue after an ordinary cohort failure; aborts and signalled children
	 * always stop the sequence. Off unless set.
	 */
	readonly keepGoingCohorts?: boolean;
}

/**
One cohort's failure: its position in the run, starting at 1.
*/
export interface CohortFailure {
	readonly cohort: number;
	readonly error: unknown;
}

export interface CohortSequenceResult {
	/**
	The finished cohorts' receipts, in run order.
	*/
	readonly receipts: readonly ParsedBuildReceipt[];
	/**
	 * The failed cohorts, in run order. The first entry carries the error the
	 * run exits with, so the failed cohort's status is the run's status.
	 */
	readonly failures: readonly CohortFailure[];
}

export interface CohortSequenceDependencies {
	/**
	 * Runs one cohort to completion: supervise, drain, reconcile, receipt. A
	 * failed cohort surfaces as its typed exit-contract error.
	 */
	readonly runCohort: (
		invocation: BuildInvocation,
		cohort: number
	) => Promise<ParsedBuildReceipt>;
	/**
	 * Recovers the receipt a failed cohort had already produced, or `undefined`
	 * when it produced none.
	 */
	readonly recoverReceipt?: (
		error: unknown,
		cohort: number
	) => Promise<ParsedBuildReceipt | undefined>;
	/**
	Collects the local store; only called at an opted-in cohort boundary.
	*/
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
 * the receipts the run did produce, and the caller exits with the first
 * failure's error.
 */
export async function runCohortSequence(
	options: CohortSequenceOptions,
	dependencies: CohortSequenceDependencies
): Promise<CohortSequenceResult> {
	const receipts: ParsedBuildReceipt[] = [];
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

			failures.push({ cohort, error });

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
