import { describe, expect, it } from 'vitest';

import { chunk, mapWithConcurrency } from './bulk.ts';

describe('chunk', () => {
	it.each([
		{ size: 2, expected: [['a', 'b'], ['c', 'd'], ['e']] },
		{
			size: 3,
			expected: [
				['a', 'b', 'c'],
				['d', 'e']
			]
		},
		{ size: 5, expected: [['a', 'b', 'c', 'd', 'e']] },
		{ size: 10, expected: [['a', 'b', 'c', 'd', 'e']] }
	])('splits five items into runs of $size', ({ size, expected }) => {
		expect(chunk(['a', 'b', 'c', 'd', 'e'], size)).toStrictEqual(expected);
	});

	it('returns no chunks for an empty input', () => {
		expect(chunk([], 3)).toStrictEqual([]);
	});
});

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
		let open: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});

		// Every task parks on a shared gate, so only as many as the limit allows
		// can be in flight before any of them is released.
		const settled = mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
			running += 1;
			peak = Math.max(peak, running);

			await gate;

			running -= 1;
		});

		expect(peak).toBe(2);

		open?.();
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
