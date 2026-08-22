import { describe, expect, it } from 'vitest';

import {
	chunk,
	filterProgressively,
	findProgressively,
	ProgressiveCollectionLimitError,
	type ProgressivePage
} from './collections.ts';

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

	it.each([0, -1, 1.5, NaN, Infinity])(
		'refuses an invalid size of %s',
		(size) => {
			expect(() => chunk(['a'], size)).toThrow(RangeError);
		}
	);
});

function page<T>(
	items: readonly T[],
	next?: () => Promise<ProgressivePage<T>>
): ProgressivePage<T> {
	return { items, ...(next !== undefined && { next }) };
}

const limits = {
	description: 'test search',
	maximumItems: 3,
	maximumPages: 2
};

describe('progressive collections', () => {
	it('stops after the first match without requesting the continuation', async () => {
		let continuationRequests = 0;
		const first = page([1, 2], () => {
			continuationRequests += 1;

			return Promise.resolve(page([3]));
		});

		await expect(
			findProgressively(first, (item) => item === 2, limits)
		).resolves.toBe(2);
		expect(continuationRequests).toBe(0);
	});

	it('filters pages while keeping only matching items', async () => {
		const first = page([1, 2], () => Promise.resolve(page([3])));

		await expect(
			filterProgressively(first, (item) => item % 2 === 1, limits)
		).resolves.toStrictEqual([1, 3]);
	});

	it('rejects a remaining page before requesting it', async () => {
		let continuationRequests = 0;
		const second = page([2], () => {
			continuationRequests += 1;

			return Promise.resolve(page([3]));
		});
		const first = page([1], () => {
			continuationRequests += 1;

			return Promise.resolve(second);
		});

		await expect(
			filterProgressively(first, () => true, limits)
		).rejects.toStrictEqual(
			new ProgressiveCollectionLimitError('test search', 3, 2, 2, 2)
		);
		expect(continuationRequests).toBe(1);
	});

	it('rejects an item beyond the candidate limit', async () => {
		await expect(
			filterProgressively(page([1, 2, 3, 4]), () => true, limits)
		).rejects.toStrictEqual(
			new ProgressiveCollectionLimitError('test search', 3, 2, 4, 1)
		);
	});
});
