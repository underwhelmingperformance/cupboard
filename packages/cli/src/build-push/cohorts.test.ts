import { storePathSchema } from '@cupboard/nix-store/scalars';
import {
	buildReceiptSchema,
	type ParsedBuildReceipt
} from '@cupboard/protocol/build';
import { describe, expect, it } from 'vitest';

import { BuildCommandFailedError, CliAbortError } from '../errors.ts';

import type { BuildInvocation } from './build-push.ts';
import { type CohortSequenceOptions, runCohortSequence } from './cohorts.ts';

const pathA = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);

function cohortInvocation(ordinal: number): BuildInvocation {
	return { kind: 'command', command: ['sh', '-c', `exit ${String(ordinal)}`] };
}

// One cohort's receipt, distinguishable by the evaluation time it records so
// aggregation order is visible in the assertions.
function receiptFor(cohort: number): ParsedBuildReceipt {
	return buildReceiptSchema.parse({
		version: 2,
		paths: [pathA],
		subjects: [],
		outcomes: [],
		evaluationTimeMs: cohort,
		childExitStatus: 0,
		uploaded: [],
		failed: [],
		collected: []
	});
}

interface SequenceRun {
	readonly events: readonly string[];
	readonly result: Awaited<ReturnType<typeof runCohortSequence>>;
}

async function runSequence(
	options: Omit<CohortSequenceOptions, 'cohorts'> & {
		readonly cohorts: number;
		readonly failing?: readonly number[];
		readonly failuresWithReceipts?: readonly number[];
	}
): Promise<SequenceRun> {
	const events: string[] = [];
	const failing = new Set(options.failing);
	const failuresWithReceipts = new Set(options.failuresWithReceipts);
	const invocations = Array.from({ length: options.cohorts }, (_, index) =>
		cohortInvocation(index + 1)
	);

	const result = await runCohortSequence(
		{
			cohorts: invocations,
			...(options.collectBetweenCohorts !== undefined && {
				collectBetweenCohorts: options.collectBetweenCohorts
			}),
			...(options.collectAfterLast !== undefined && {
				collectAfterLast: options.collectAfterLast
			}),
			...(options.keepGoingCohorts !== undefined && {
				keepGoingCohorts: options.keepGoingCohorts
			})
		},
		{
			runCohort: async (_invocation, cohort) => {
				events.push(`cohort:${String(cohort)}`);
				await Promise.resolve();

				if (failing.has(cohort)) {
					throw new BuildCommandFailedError(cohort, undefined, cohort);
				}

				return receiptFor(cohort);
			},
			recoverReceipt: (_error, cohort) =>
				Promise.resolve(
					failuresWithReceipts.has(cohort) ? receiptFor(cohort) : undefined
				),
			collect: async () => {
				events.push('collect');
				await Promise.resolve();
			}
		}
	);

	return { events, result };
}

describe('runCohortSequence', () => {
	it('runs the cohorts in order, never collecting when the setting is off', async () => {
		const run = await runSequence({ cohorts: 3 });

		expect(run).toStrictEqual({
			events: ['cohort:1', 'cohort:2', 'cohort:3'],
			result: {
				receipts: [receiptFor(1), receiptFor(2), receiptFor(3)],
				failures: []
			}
		});
	});

	it('collects between cohorts when opted in, never after the last', async () => {
		const run = await runSequence({ cohorts: 3, collectBetweenCohorts: true });

		expect(run).toStrictEqual({
			events: ['cohort:1', 'collect', 'cohort:2', 'collect', 'cohort:3'],
			result: {
				receipts: [receiptFor(1), receiptFor(2), receiptFor(3)],
				failures: []
			}
		});
	});

	it('collects after the last cohort only when additionally configured', async () => {
		const run = await runSequence({
			cohorts: 2,
			collectBetweenCohorts: true,
			collectAfterLast: true
		});

		expect(run).toStrictEqual({
			events: ['cohort:1', 'collect', 'cohort:2', 'collect'],
			result: {
				receipts: [receiptFor(1), receiptFor(2)],
				failures: []
			}
		});
	});

	it('stops the sequence at a failed cohort, returning its typed error', async () => {
		const run = await runSequence({
			cohorts: 3,
			collectBetweenCohorts: true,
			failing: [2]
		});
		const [failure] = run.result.failures;

		expect({
			events: run.events,
			receipts: run.result.receipts,
			failures: run.result.failures.map(({ cohort }) => cohort),
			isTypedError: failure?.error instanceof BuildCommandFailedError
		}).toStrictEqual({
			events: ['cohort:1', 'collect', 'cohort:2'],
			receipts: [receiptFor(1)],
			failures: [2],
			isTypedError: true
		});
	});

	it('continues past a failed cohort with keep-going, aggregating the rest', async () => {
		const run = await runSequence({
			cohorts: 3,
			collectBetweenCohorts: true,
			keepGoingCohorts: true,
			failing: [2]
		});

		expect({
			events: run.events,
			receipts: run.result.receipts,
			failures: run.result.failures.map(({ cohort }) => cohort)
		}).toStrictEqual({
			events: ['cohort:1', 'collect', 'cohort:2', 'collect', 'cohort:3'],
			receipts: [receiptFor(1), receiptFor(3)],
			failures: [2]
		});
	});

	it.each([
		{
			name: 'an abort error',
			error: new DOMException('cancelled', 'AbortError')
		},
		{
			name: 'a signalled child',
			error: new BuildCommandFailedError(undefined, 'SIGTERM', 143)
		}
	])('stops keep-going after $name', async ({ error }) => {
		const events: string[] = [];
		const result = await runCohortSequence(
			{
				cohorts: [cohortInvocation(1), cohortInvocation(2)],
				collectBetweenCohorts: true,
				keepGoingCohorts: true
			},
			{
				runCohort: (_invocation, cohort) => {
					events.push(`cohort:${String(cohort)}`);

					return Promise.reject(error);
				},
				collect: () => {
					events.push('collect');

					return Promise.resolve();
				}
			}
		);

		expect({ events, result }).toStrictEqual({
			events: ['cohort:1'],
			result: {
				receipts: [],
				failures: [{ cohort: 1, error }]
			}
		});
	});

	it.each(['SIGINT', 'SIGTERM'] as const)(
		'stops before the next cohort when collection receives %s',
		async (signal) => {
			const events: string[] = [];
			const error = new BuildCommandFailedError(
				undefined,
				signal,
				signal === 'SIGINT' ? 130 : 143
			);
			const run = runCohortSequence(
				{
					cohorts: [
						cohortInvocation(1),
						cohortInvocation(2),
						cohortInvocation(3)
					],
					collectBetweenCohorts: true,
					keepGoingCohorts: true
				},
				{
					runCohort: (_invocation, cohort) => {
						events.push(`cohort:${String(cohort)}`);

						return Promise.resolve(receiptFor(cohort));
					},
					collect: () => {
						events.push('collect');

						return Promise.reject(error);
					}
				}
			);

			await expect(run).rejects.toBe(error);
			expect(events).toStrictEqual(['cohort:1', 'collect']);
		}
	);

	it.each([
		{
			name: 'before the first cohort',
			abortAt: 'before-cohort' as const,
			expectedEvents: []
		},
		{
			name: 'before collection',
			abortAt: 'before-collection' as const,
			expectedEvents: ['cohort:1']
		},
		{
			name: 'after collection',
			abortAt: 'after-collection' as const,
			expectedEvents: ['cohort:1', 'collect']
		},
		{
			name: 'after the final cohort',
			abortAt: 'after-final-cohort' as const,
			expectedEvents: ['cohort:1', 'collect', 'cohort:2']
		}
	])(
		'stops on cancellation $name without starting more work',
		async ({ abortAt, expectedEvents }) => {
			const events: string[] = [];
			const controller = new AbortController();
			const reason = new CliAbortError();

			if (abortAt === 'before-cohort') {
				controller.abort(reason);
			}

			const run = runCohortSequence(
				{
					cohorts: [cohortInvocation(1), cohortInvocation(2)],
					collectBetweenCohorts: true,
					signal: controller.signal
				},
				{
					runCohort: (_invocation, cohort) => {
						events.push(`cohort:${String(cohort)}`);

						if (
							abortAt === 'before-collection' ||
							(abortAt === 'after-final-cohort' && cohort === 2)
						) {
							controller.abort(reason);
						}

						return Promise.resolve(receiptFor(cohort));
					},
					collect: () => {
						events.push('collect');

						if (abortAt === 'after-collection') {
							controller.abort(reason);
						}

						return Promise.resolve();
					}
				}
			);

			await expect(run).rejects.toBe(reason);
			expect(events).toStrictEqual(expectedEvents);
		}
	);

	it('keeps a failed cohort receipt in run order when the cohort produced one', async () => {
		const run = await runSequence({
			cohorts: 3,
			failing: [2],
			failuresWithReceipts: [2],
			keepGoingCohorts: true
		});

		expect({
			receipts: run.result.receipts,
			failures: run.result.failures.map(({ cohort }) => cohort)
		}).toStrictEqual({
			receipts: [receiptFor(1), receiptFor(2), receiptFor(3)],
			failures: [2]
		});
	});
});
