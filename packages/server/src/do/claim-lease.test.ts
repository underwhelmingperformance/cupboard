import { afterEach, describe, expect, it, vi } from 'vitest';

import { withRenewedClaim } from './claim-lease.ts';

async function observeResult(
	operation: Promise<unknown>,
	results: unknown[]
): Promise<void> {
	try {
		results.push(await operation);
	} catch (error) {
		results.push(error);
	}
}

describe('bounded claim renewal', () => {
	afterEach(() => vi.useRealTimers());

	it('renews at the supplied interval without overlapping renewals', async () => {
		vi.useFakeTimers();
		const work = Promise.withResolvers<string>();
		const renewal = Promise.withResolvers<undefined>();
		const renew = vi
			.fn<() => Promise<void>>()
			.mockResolvedValueOnce()
			.mockImplementation(() => renewal.promise);
		const running = withRenewedClaim(renew, () => work.promise, {
			renewalIntervalMs: 100,
			deadline: { budgetMs: 1000, error: new Error('task deadline') }
		});
		await vi.advanceTimersByTimeAsync(400);
		expect(renew.mock.calls).toStrictEqual([[], []]);
		renewal.resolve(undefined);
		work.resolve('complete');
		await expect(running).resolves.toBe('complete');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('bounds a stalled initial renewal and observes its later rejection', async () => {
		vi.useFakeTimers();
		const renewal = Promise.withResolvers<undefined>();
		const work = vi.fn(() => Promise.resolve());
		const failure = new Error('task deadline');
		const running = withRenewedClaim(() => renewal.promise, work, {
			renewalIntervalMs: 100,
			deadline: { budgetMs: 500, error: failure }
		});
		const rejected = expect(running).rejects.toBe(failure);
		await vi.advanceTimersByTimeAsync(500);
		await rejected;
		expect(work).not.toHaveBeenCalled();
		renewal.reject(new Error('late renewal failure'));
		await Promise.resolve();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([false, true])(
		'bounds uncooperative work with an outer signal: %s',
		async (withOuterSignal) => {
			vi.useFakeTimers();
			const outer = new AbortController();
			const work = Promise.withResolvers<undefined>();
			const renew = vi.fn(() => Promise.resolve());
			const failure = new Error('task deadline');
			const running = withRenewedClaim(renew, () => work.promise, {
				renewalIntervalMs: 100,
				deadline: { budgetMs: 350, error: failure },
				signal: withOuterSignal ? outer.signal : undefined
			});
			const outcomes: unknown[] = [];
			const observed = observeResult(running, outcomes);
			await vi.advanceTimersByTimeAsync(350);
			try {
				expect({
					outcomes: [...outcomes],
					renewals: renew.mock.calls,
					timers: vi.getTimerCount()
				}).toStrictEqual({
					outcomes: [failure],
					renewals: [[], [], [], []],
					timers: 0
				});
			} finally {
				work.reject(new Error('late task failure'));
				await observed;
			}
		}
	);

	it.each(['deadline', 'caller'] as const)(
		'keeps %s cancellation while completed work awaits a stalled renewal',
		async (source) => {
			vi.useFakeTimers();
			const renewal = Promise.withResolvers<undefined>();
			const work = Promise.withResolvers<undefined>();
			const failure = new Error('task deadline');
			const outer = new AbortController();
			const renew = vi
				.fn<() => Promise<void>>()
				.mockResolvedValueOnce()
				.mockImplementation(() => renewal.promise);
			const running = withRenewedClaim(renew, () => work.promise, {
				renewalIntervalMs: 100,
				deadline:
					source === 'deadline' ? { budgetMs: 350, error: failure } : undefined,
				signal: source === 'caller' ? outer.signal : undefined
			});
			const outcomes: unknown[] = [];
			const observed = observeResult(running, outcomes);
			await vi.advanceTimersByTimeAsync(100);
			work.resolve(undefined);
			await vi.advanceTimersByTimeAsync(300);
			if (source === 'caller') {
				outer.abort(failure);
				await vi.advanceTimersByTimeAsync(0);
			}
			try {
				expect([...outcomes]).toStrictEqual([failure]);
			} finally {
				renewal.reject(new Error('late renewal failure'));
				await observed;
			}
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('does not start renewal or work after the caller has cancelled', async () => {
		const controller = new AbortController();
		const failure = new Error('caller cancelled');
		controller.abort(failure);
		const renew = vi.fn(() => Promise.resolve());
		const work = vi.fn(() => Promise.resolve());
		await expect(
			withRenewedClaim(renew, work, {
				renewalIntervalMs: 100,
				signal: controller.signal
			})
		).rejects.toBe(failure);
		expect({ renewals: renew.mock.calls, work: work.mock.calls }).toStrictEqual(
			{ renewals: [], work: [] }
		);
	});

	it.each([0, -1, 1.5, NaN, Infinity])(
		'rejects an invalid renewal interval %s before starting work',
		async (renewalIntervalMs) => {
			const renew = vi.fn(() => Promise.resolve());
			const work = vi.fn(() => Promise.resolve());
			await expect(
				withRenewedClaim(renew, work, { renewalIntervalMs })
			).rejects.toThrow(RangeError);
			expect({
				renewals: renew.mock.calls,
				work: work.mock.calls
			}).toStrictEqual({ renewals: [], work: [] });
		}
	);
});
