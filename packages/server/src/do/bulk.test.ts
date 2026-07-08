import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from './bulk.ts';

describe('mapWithConcurrency', () => {
	it('maps every item, preserving input order in the result', async () => {
		const mapped = await mapWithConcurrency([1, 2, 3, 4, 5], 2, (value) =>
			Promise.resolve(value * 2)
		);

		expect(mapped).toStrictEqual([2, 4, 6, 8, 10]);
	});

	it('runs at most `limit` tasks at once', async () => {
		let running = 0;
		let peak = 0;
		const { promise: gate, resolve: open }: PromiseWithResolvers<void> =
			Promise.withResolvers();

		// Every task parks on a shared gate, so only as many as the limit allows
		// can be in flight before any of them is released.
		const settled = mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
			running += 1;
			peak = Math.max(peak, running);

			await gate;

			running -= 1;
		});

		expect(peak).toBe(2);

		open();
		await settled;

		expect(peak).toBe(2);
	});

	it('returns an empty result for an empty input without running the task', async () => {
		let calls = 0;

		const mapped = await mapWithConcurrency([], 4, () => {
			calls += 1;
			return Promise.resolve(calls);
		});

		expect({ mapped, calls }).toStrictEqual({ mapped: [], calls: 0 });
	});
});
