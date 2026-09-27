import { describe, expect, it, vi } from 'vitest';

import {
	bestEffort,
	discardResponseBody,
	withCleanup,
	withCleanups,
	withCleanupSync
} from './cleanup.ts';

describe('withCleanup', () => {
	it('preserves an operation failure when cleanup also fails', async () => {
		const primary = new Error('operation failed');
		const cleanup = vi.fn(() => Promise.reject(new Error('cleanup failed')));

		await expect(
			withCleanup(() => Promise.reject(primary), cleanup)
		).rejects.toBe(primary);
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it('surfaces a cleanup failure after a successful operation', async () => {
		const cleanupFailure = new Error('cleanup failed');

		await expect(
			withCleanup(
				() => Promise.resolve('complete'),
				() => Promise.reject(cleanupFailure)
			)
		).rejects.toBe(cleanupFailure);
	});
});

describe('withCleanupSync', () => {
	it.each<{
		readonly name: string;
		readonly operationFails: boolean;
		readonly expected: 'operation' | 'cleanup';
	}>([
		{
			name: 'preserves an operation failure when cleanup also fails',
			operationFails: true,
			expected: 'operation'
		},
		{
			name: 'surfaces a cleanup failure after a successful operation',
			operationFails: false,
			expected: 'cleanup'
		}
	])('$name', ({ operationFails, expected }) => {
		const failures = {
			operation: new Error('operation failed'),
			cleanup: new Error('cleanup failed')
		};
		const cleanup = vi.fn(() => {
			throw failures.cleanup;
		});
		let caught: unknown;

		try {
			withCleanupSync(() => {
				if (operationFails) {
					throw failures.operation;
				}

				return 'complete';
			}, cleanup);
		} catch (error) {
			caught = error;
		}

		expect({
			caught: caught === failures[expected] ? expected : 'other',
			cleanups: cleanup.mock.calls.length
		}).toStrictEqual({ caught: expected, cleanups: 1 });
	});
});

describe('withCleanups', () => {
	it('preserves the primary failure while every cleanup still runs', async () => {
		const primary = new Error('operation failed');
		const calls: string[] = [];

		await expect(
			withCleanups(
				() => Promise.reject(primary),
				[
					() => {
						calls.push('first');
						return Promise.reject(new Error('first cleanup failed'));
					},
					() => {
						calls.push('second');
						return Promise.resolve();
					}
				]
			)
		).rejects.toBe(primary);
		expect(calls).toStrictEqual(['first', 'second']);
	});
});

describe('bestEffort', () => {
	it('settles after its operation fails', async () => {
		await expect(
			bestEffort(() => Promise.reject(new Error('discard failed')))
		).resolves.toBeUndefined();
	});

	it('does not surface a rejected response cancellation', async () => {
		const response = new Response(
			new ReadableStream({
				cancel: () => Promise.reject(new Error('cancel failed'))
			})
		);

		await expect(discardResponseBody(response)).resolves.toBeUndefined();
	});
});
