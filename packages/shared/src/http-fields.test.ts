import { describe, expect, it } from 'vitest';

import { isWeakEtagMatch, parseHttpDate } from './http-fields.ts';

describe('HTTP field grammar', () => {
	it.each([
		'Wed, 31 Dec 2025 23:59:60 GMT',
		'Wednesday, 31-Dec-25 23:59:60 GMT',
		'Wed Dec 31 23:59:60 2025'
	])('accepts a leap second at the end of the day: %s', (value) => {
		expect(parseHttpDate(value)).toBe(Date.UTC(2026, 0, 1));
	});

	it.each([
		'Wed, 31 Dec 2025 12:59:60 GMT',
		'Wednesday, 31-Dec-25 23:58:60 GMT',
		'Wed Dec 31 00:00:60 2025'
	])('rejects a leap-second value outside 23:59: %s', (value) => {
		expect(parseHttpDate(value)).toBeUndefined();
	});

	it('accepts only byte-valued obs-text in entity tags', () => {
		expect({
			firstObsTextByte: isWeakEtagMatch('"\u{80}"', '"\u{80}"'),
			lastObsTextByte: isWeakEtagMatch('"\u{FF}"', '"\u{FF}"'),
			aboveByteRange: isWeakEtagMatch('"\u{100}"', '"\u{100}"')
		}).toStrictEqual({
			firstObsTextByte: true,
			lastObsTextByte: true,
			aboveByteRange: false
		});
	});
});
