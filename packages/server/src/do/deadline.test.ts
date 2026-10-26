import { startCapture } from '@cupboard/logger/testing';
import { describe, expect, it, vi } from 'vitest';

import { SubrequestTimeoutError } from '../errors.ts';

import {
	boundedSubrequest,
	criticalSectionBudgetMs,
	unboundedCapMs,
	withDeadlineBudget
} from './deadline.ts';

function never(): Promise<never> {
	return Promise.race([]);
}

describe('boundedSubrequest', () => {
	it.each([false, true])(
		'observes late cleanup without replacing the timeout (cleanup rejects=%s)',
		async (rejectsCleanup) => {
			const capture = startCapture();
			const operation = Promise.withResolvers<string>();
			const cleanup = vi.fn((_result: string) =>
				rejectsCleanup
					? Promise.reject(new Error('cleanup failed'))
					: Promise.resolve()
			);
			vi.useFakeTimers();
			try {
				const pending = boundedSubrequest(
					() => operation.promise,
					'r2.get',
					10,
					cleanup
				);
				const rejected = expect(pending).rejects.toBeInstanceOf(
					SubrequestTimeoutError
				);
				await vi.advanceTimersByTimeAsync(10);
				await rejected;
				operation.resolve('late');
				await vi.advanceTimersByTimeAsync(0);
				expect({
					cleanups: cleanup.mock.calls,
					cleanupFailures: capture.logs
						.filter(
							(log) => log.message === 'storage late-result cleanup failed'
						)
						.map((log) => log.properties.operation)
				}).toStrictEqual({
					cleanups: [['late']],
					cleanupFailures: rejectsCleanup ? ['r2.get'] : []
				});
			} finally {
				capture.stop();
				vi.useRealTimers();
			}
		}
	);

	it('cleans a result that settles during enclosing deadline expiry', async () => {
		vi.useFakeTimers();
		const operation = Promise.withResolvers<string>();
		const cleanup = vi.fn((_result: string) => Promise.resolve());
		try {
			const pending = withDeadlineBudget(10, () => {
				setTimeout(() => {
					operation.resolve('expired');
				}, 10);
				return boundedSubrequest(
					() => operation.promise,
					'r2.get',
					10,
					cleanup
				);
			});
			const rejected = expect(pending).rejects.toMatchObject({
				name: 'SubrequestTimeoutError',
				subrequest: 'r2.get'
			});
			await vi.advanceTimersByTimeAsync(10);
			await rejected;
			expect(cleanup.mock.calls).toStrictEqual([['expired']]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([false, true])(
		'records a late storage result after timeout (failed=%s)',
		async (hasFailed) => {
			const capture = startCapture();
			vi.useFakeTimers();
			const operation = Promise.withResolvers<string>();

			try {
				const pending = boundedSubrequest(
					() => operation.promise,
					'r2.get',
					10
				);
				const rejected = expect(pending).rejects.toBeInstanceOf(
					SubrequestTimeoutError
				);
				await vi.advanceTimersByTimeAsync(10);
				await rejected;

				if (hasFailed) {
					operation.reject(new Error('late R2 failure'));
				} else {
					operation.resolve('late');
				}

				await Promise.resolve();

				expect(
					capture.logs
						.filter((log) => log.category.join('.') === 'cupboard.storage')
						.map(({ message, properties }) => ({
							message,
							operation: properties.operation,
							capMs: properties.capMs,
							deadlineMs: properties.deadlineMs,
							disposition: properties.disposition
						}))
				).toStrictEqual([
					{
						message: 'storage request started',
						operation: 'r2.get',
						capMs: 10,
						deadlineMs: 10,
						disposition: undefined
					},
					{
						message: 'storage request failed',
						operation: 'r2.get',
						capMs: 10,
						deadlineMs: 10,
						disposition: 'timeout'
					},
					{
						message: hasFailed
							? 'storage request failed after timeout'
							: 'storage request completed after timeout',
						operation: 'r2.get',
						capMs: 10,
						deadlineMs: 10,
						disposition: undefined
					}
				]);
			} finally {
				capture.stop();
				vi.useRealTimers();
			}
		}
	);

	it('resolves when the operation settles within the budget', async () => {
		const result = await withDeadlineBudget(criticalSectionBudgetMs, () =>
			boundedSubrequest(() => Promise.resolve('ok'), 'r2.get')
		);

		expect(result).toBe('ok');
	});

	it('includes the subrequest name when the section budget expires', async () => {
		vi.useFakeTimers();

		try {
			const pending = withDeadlineBudget(50, () =>
				boundedSubrequest(never, 'r2.delete')
			);
			const rejects = expect(pending).rejects.toMatchObject({
				name: 'SubrequestTimeoutError',
				subrequest: 'r2.delete'
			});

			await vi.advanceTimersByTimeAsync(50);
			await rejects;
		} finally {
			vi.useRealTimers();
		}
	});

	it('bounds a nested budget by the tighter outer deadline', async () => {
		vi.useFakeTimers();

		try {
			const pending = withDeadlineBudget(50, () =>
				withDeadlineBudget(10_000, () => boundedSubrequest(never, 'd1.batch'))
			);
			const rejects = expect(pending).rejects.toBeInstanceOf(
				SubrequestTimeoutError
			);

			await vi.advanceTimersByTimeAsync(50);
			await rejects;
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		{
			name: 'a late result',
			settle: (operation: PromiseWithResolvers<string>) => {
				operation.resolve('late');
			}
		},
		{
			name: 'a different late error',
			settle: (operation: PromiseWithResolvers<string>) => {
				operation.reject(new Error('late storage failure'));
			}
		}
	])('keeps the deadline authoritative over $name', async ({ settle }) => {
		vi.useFakeTimers();

		try {
			const operation = Promise.withResolvers<string>();
			const pending = withDeadlineBudget(
				50,
				() => operation.promise,
				'verification.record'
			);
			const rejects = expect(pending).rejects.toMatchObject({
				name: 'SubrequestTimeoutError',
				subrequest: 'verification.record'
			});

			await vi.advanceTimersByTimeAsync(50);
			settle(operation);

			await rejects;
		} finally {
			vi.useRealTimers();
		}
	});

	it('sets no timer for an unbounded byte-transfer call outside a scope', () => {
		vi.useFakeTimers();

		try {
			void boundedSubrequest(never, 'r2.get', unboundedCapMs);

			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('caps a metadata call outside any scope at the per-call limit', async () => {
		vi.useFakeTimers();

		try {
			const pending = boundedSubrequest(never, 'r2.delete');
			const rejects = expect(pending).rejects.toBeInstanceOf(
				SubrequestTimeoutError
			);

			await vi.advanceTimersByTimeAsync(15_000);
			await rejects;
		} finally {
			vi.useRealTimers();
		}
	});

	it('exposes a promise that resolves after the timed-out operation settles', async () => {
		vi.useFakeTimers();

		try {
			const operation = Promise.withResolvers<string>();

			const pending = withDeadlineBudget(50, () =>
				boundedSubrequest(() => operation.promise, 'r2.get')
			);
			const rejects = expect(pending).rejects.toBeInstanceOf(
				SubrequestTimeoutError
			);

			await vi.advanceTimersByTimeAsync(50);
			await rejects;

			let error: unknown;

			try {
				await pending;
			} catch (error_) {
				error = error_;
			}

			if (!(error instanceof SubrequestTimeoutError)) {
				throw new Error('expected a SubrequestTimeoutError');
			}

			expect(error.abandoned).toBeInstanceOf(Promise);

			operation.resolve('done');

			await expect(error.abandoned).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('omits abandoned when the budget is already exhausted', async () => {
		vi.useFakeTimers();

		try {
			const pending = withDeadlineBudget(0, async () => {
				vi.advanceTimersByTime(1);

				return boundedSubrequest(never, 'r2.get');
			});

			let error: unknown;

			try {
				await pending;
			} catch (error_) {
				error = error_;
			}

			if (!(error instanceof SubrequestTimeoutError)) {
				throw new Error('expected a SubrequestTimeoutError');
			}

			expect(error).toMatchObject({
				name: 'SubrequestTimeoutError',
				subrequest: 'r2.get',
				abandoned: undefined
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
