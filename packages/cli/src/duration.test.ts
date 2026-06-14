import { describe, expect, it } from 'vitest';

import { parseTtl, parseWaitTimeout } from './duration.ts';
import {
	InvalidDurationError,
	InvalidTtlError,
	InvalidWaitTimeoutError
} from './errors.ts';

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
		{ input: '1.5d', why: 'non-integer amount' }
	])('rejects $why input as a malformed duration', ({ input }) => {
		expect(() => parseTtl(input)).toThrow(InvalidDurationError);
	});

	it.each([
		{ input: '0s', why: 'below the minimum' },
		{ input: '4000w', why: 'above the ten-year cap' }
	])('rejects $why as out of TTL bounds', ({ input }) => {
		expect(() => parseTtl(input)).toThrow(InvalidTtlError);
	});
});

describe('parseWaitTimeout', () => {
	it('parses a short wait the TTL bounds would reject', () => {
		expect(parseWaitTimeout('1s')).toBe(1);
	});

	it('accepts a wait beyond the retention cap', () => {
		expect(parseWaitTimeout('4000w')).toBe(2_419_200_000);
	});

	it('rejects a malformed duration', () => {
		expect(() => parseWaitTimeout('soon')).toThrow(InvalidDurationError);
	});

	it('rejects a zero wait rather than timing out immediately', () => {
		expect(() => parseWaitTimeout('0s')).toThrow(InvalidWaitTimeoutError);
	});
});
