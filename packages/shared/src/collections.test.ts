import { describe, expect, it } from 'vitest';

import { chunk } from './collections.ts';

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
