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
