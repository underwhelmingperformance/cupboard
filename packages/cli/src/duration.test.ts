import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';

import { parseTtl } from './duration.ts';

describe('parseTtl', () => {
	it.each([
		{ input: '45s', seconds: 45 },
		{ input: '30m', seconds: 1800 },
		{ input: '12h', seconds: 43_200 },
		{ input: '7d', seconds: 604_800 },
		{ input: '2w', seconds: 1_209_600 }
	])('parses $input as $seconds seconds', ({ input, seconds }) => {
		expect(parseTtl(input)).toBe(seconds);
	});

	it.each([
		{ input: '', why: 'empty' },
		{ input: '7', why: 'no unit' },
		{ input: 'd', why: 'no amount' },
		{ input: '7y', why: 'unknown unit' },
		{ input: '1.5d', why: 'non-integer amount' },
		{ input: '0s', why: 'below the minimum' },
		{ input: '4000w', why: 'above the ten-year cap' }
	])('rejects $why input', ({ input }) => {
		expect(() => parseTtl(input)).toThrow(InvalidArgumentError);
	});
});
