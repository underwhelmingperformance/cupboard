import type { ParsedBuildReceipt } from '@cupboard/protocol/build';

import type { BuildInvocation } from './build-push.ts';

export interface CohortSequenceOptions {
	/** The cohorts to build, in order; each settles before the next starts. */
	readonly cohorts: readonly BuildInvocation[];
	/**
	 * Collect the local store at cohort boundaries, so the next cohort
	 * substitutes the earlier shared work from the cache; off unless set, so a
	 * run never deletes the user's paths by default.
	 */
	readonly collectBetweenCohorts?: boolean;
	/** Also collect once the final cohort has settled; off unless set. */
	readonly collectAfterLast?: boolean;
	/** Continue with the remaining cohorts after one fails; off unless set. */
	readonly keepGoingCohorts?: boolean;
}

/** One cohort's failure: its position in the run, starting at 1. */
export interface CohortFailure {
	readonly cohort: number;
	readonly error: unknown;
}

export interface CohortSequenceResult {
	/** The settled cohorts' receipts, in run order. */
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
	/** Collects the local store; only called at an opted-in cohort boundary. */
	readonly collect?: () => Promise<void>;
}

/**
 * Runs the cohorts sequentially, one finishing and draining before the next
 * starts, so cupboard carries the shared work across the boundary. Collection
 * only runs at a boundary the run opted into: between cohorts when the
 * setting is on, after the last only when additionally configured, and never
 * when the setting is off. A cohort's failure stops the sequence unless the
 * keep-going option is set; either way the failures are returned alongside
 * the settled receipts, the first failure being the run's verdict.
 */
export async function runCohortSequence(
	options: CohortSequenceOptions,
	dependencies: CohortSequenceDependencies
): Promise<CohortSequenceResult> {
	const receipts: ParsedBuildReceipt[] = [];
	const failures: CohortFailure[] = [];

	for (const [index, invocation] of options.cohorts.entries()) {
		const cohort = index + 1;

		try {
			receipts.push(await dependencies.runCohort(invocation, cohort));
		} catch (error) {
			failures.push({ cohort, error });

			if (options.keepGoingCohorts !== true) {
				return { receipts, failures };
			}
		}

		const isLast = index === options.cohorts.length - 1;
		const shouldCollect =
			options.collectBetweenCohorts === true &&
			(!isLast || options.collectAfterLast === true);

		if (shouldCollect) {
			await dependencies.collect?.();
		}
	}

	return { receipts, failures };
}
