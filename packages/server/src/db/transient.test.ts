import { afterEach, describe, expect, it, vi } from 'vitest';

import { boundedSubrequest, withDeadlineBudget } from '../do/deadline.ts';
import { SubrequestTimeoutError } from '../errors.ts';

import {
	d1AccountThrottleMessage,
	d1QueueOverloadMessage
} from './transient.test-support.ts';
import { isD1Overload, readWithOneRetry } from './transient.ts';

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

	const transientFailure = new Error('transient failure');

	it.each([
		{
			failure: 'a read that the deadline refuses after the budget has gone',
			error: transientFailure,
			elapsedMs: budgetMs,
			attempts: 1,
			isTimeout: true
		},
		{
			failure: 'a read that fails with less budget left than the retry delay',
			error: transientFailure,
			elapsedMs: budgetMs - 50,
			attempts: 1,
			isTimeout: false
		},
		{
			failure: 'a read that fails while budget remains',
			error: transientFailure,
			elapsedMs: 0,
			attempts: 2,
			isTimeout: false
		},
		{
			failure: 'a read that fails with the D1 queue overload',
			error: new Error(d1QueueOverloadMessage),
			elapsedMs: 0,
			attempts: 1,
			isTimeout: false
		},
		{
			failure: 'a read that fails with the account throttle',
			error: new Error(d1AccountThrottleMessage),
			elapsedMs: 0,
			attempts: 1,
			isTimeout: false
		},
		{
			failure: 'a read that fails with the account throttle in a cause',
			error: new Error('query failed', {
				cause: new Error(d1AccountThrottleMessage)
			}),
			elapsedMs: 0,
			attempts: 1,
			isTimeout: false
		}
	])(
		'makes $attempts attempts at $failure',
		async ({ error, elapsedMs, attempts, isTimeout }) => {
			vi.useFakeTimers();
			const calls = { count: 0 };
			const read = (): Promise<never> => {
				calls.count += 1;

				return boundedSubrequest(() => Promise.reject(error), 'd1.all');
			};
			const settled = failureOf(
				withDeadlineBudget(budgetMs, async () => {
					await elapse(elapsedMs);
					await readWithOneRetry(read);
				})
			);
			await vi.runAllTimersAsync();
			const failure = await settled;

			expect({
				attempts: calls.count,
				isTimeout: failure instanceof SubrequestTimeoutError
			}).toStrictEqual({ attempts, isTimeout });
		}
	);
});

describe('isD1Overload', () => {
	const wrapped = (cause: unknown): Error =>
		new Error('query failed', { cause });

	it.each([
		{
			name: 'the queue overload',
			error: new Error(d1QueueOverloadMessage),
			expected: true
		},
		{
			name: 'the account throttle',
			error: new Error(d1AccountThrottleMessage),
			expected: true
		},
		{
			name: 'the account throttle without its second sentence',
			error: new Error(
				'D1_ERROR: Your account is generating too much load on D1 DBs'
			),
			expected: true
		},
		{
			name: 'the account throttle in a cause',
			error: wrapped(new Error(d1AccountThrottleMessage)),
			expected: true
		},
		{
			name: 'the Durable Object stub throttle',
			error: new Error(
				'Your account is generating too much load on Durable Objects. Please back off and try again later.'
			),
			expected: false
		},
		{
			name: 'another D1 error',
			error: new Error('D1_ERROR: no such table: tenant'),
			expected: false
		},
		{
			name: 'an overload message that is not an error',
			error: d1AccountThrottleMessage,
			expected: false
		}
	])('classifies $name as $expected', ({ error, expected }) => {
		expect(isD1Overload(error)).toBe(expected);
	});
});
