import { afterEach, describe, expect, it, vi } from 'vitest';

import { boundedSubrequest, withDeadlineBudget } from '../do/deadline.ts';
import { SubrequestTimeoutError } from '../errors.ts';

import { readWithOneRetry } from './transient.ts';

const budgetMs = 1000;

function elapse(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function failureOf(pending: Promise<unknown>): Promise<unknown> {
	try {
		await pending;
	} catch (error) {
		return error;
	}

	return undefined;
}

describe('readWithOneRetry', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		{
			failure: 'a read that the deadline refuses after the budget has gone',
			elapsedMs: budgetMs,
			attempts: 1,
			isTimeout: true
		},
		{
			failure: 'a read that fails with less budget left than the retry delay',
			elapsedMs: budgetMs - 50,
			attempts: 1,
			isTimeout: false
		},
		{
			failure: 'a read that fails while budget remains',
			elapsedMs: 0,
			attempts: 2,
			isTimeout: false
		}
	])(
		'makes $attempts attempts at $failure',
		async ({ elapsedMs, attempts, isTimeout }) => {
			vi.useFakeTimers();
			const calls = { count: 0 };
			const read = (): Promise<never> => {
				calls.count += 1;

				return boundedSubrequest(
					() => Promise.reject(new Error('transient failure')),
					'd1.all'
				);
			};
			const settled = failureOf(
				withDeadlineBudget(budgetMs, async () => {
					await elapse(elapsedMs);
					await readWithOneRetry(read);
				})
			);
			await vi.runAllTimersAsync();
			const error = await settled;

			expect({
				attempts: calls.count,
				isTimeout: error instanceof SubrequestTimeoutError
			}).toStrictEqual({ attempts, isTimeout });
		}
	);
});
