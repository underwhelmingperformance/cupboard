import { describe, expect, it } from 'vitest';

import { ByteRangeRequest, type ByteRangeSelection } from './byte-range.ts';

const size = 1000;
const etag = '"md5:abc"';

const cases: readonly {
	name: string;
	headers: Record<string, string>;
	method?: string;
	expected: ByteRangeSelection | undefined;
}[] = [
	{
		name: 'a bounded range past the end is shortened to the end',
		headers: { range: 'bytes=990-2000' },
		expected: {
			kind: 'partial',
			span: { offset: 990, length: 10 },
			contentRange: 'bytes 990-999/1000'
		}
	},
	{
		name: 'a suffix longer than the representation selects all of it',
		headers: { range: 'bytes=-5000' },
		expected: {
			kind: 'partial',
			span: { offset: 0, length: size },
			contentRange: 'bytes 0-999/1000'
		}
	},
	{
		name: 'a zero-length suffix is unsatisfiable',
		headers: { range: 'bytes=-0' },
		expected: { kind: 'unsatisfiable', contentRange: 'bytes */1000' }
	},
	{
		name: 'a bounded range that starts at the end is unsatisfiable',
		headers: { range: 'bytes=1000-1001' },
		expected: { kind: 'unsatisfiable', contentRange: 'bytes */1000' }
	},
	{
		name: 'an open-ended range that starts at the end selects the whole representation',
		headers: { range: 'bytes=1000-' },
		expected: { kind: 'whole' }
	},
	{
		name: 'an open-ended range that starts past the end is unsatisfiable',
		headers: { range: 'bytes=1001-' },
		expected: { kind: 'unsatisfiable', contentRange: 'bytes */1000' }
	},
	{
		name: 'the range unit is case-insensitive',
		headers: { range: 'Bytes=0-0' },
		expected: {
			kind: 'partial',
			span: { offset: 0, length: 1 },
			contentRange: 'bytes 0-0/1000'
		}
	},
	{
		name: 'a matching If-Range keeps the range',
		headers: { range: 'bytes=0-9', 'if-range': etag },
		expected: {
			kind: 'partial',
			span: { offset: 0, length: 10 },
			contentRange: 'bytes 0-9/1000'
		}
	},
	{
		name: 'a different If-Range selects the whole representation',
		headers: { range: 'bytes=0-9', 'if-range': '"md5:def"' },
		expected: { kind: 'whole' }
	},
	{
		name: 'a weak If-Range selects the whole representation',
		headers: { range: 'bytes=0-9', 'if-range': `W/${etag}` },
		expected: { kind: 'whole' }
	},
	{
		name: 'a range whose last position precedes its first is ignored',
		headers: { range: 'bytes=9-0' },
		expected: undefined
	},
	{
		name: 'a range with neither position is ignored',
		headers: { range: 'bytes=-' },
		expected: undefined
	},
	{
		name: 'a range that is not numeric is ignored',
		headers: { range: 'bytes=abc' },
		expected: undefined
	},
	{
		name: 'another range unit is ignored',
		headers: { range: 'items=0-9' },
		expected: undefined
	},
	{
		name: 'a range on a HEAD request is ignored',
		headers: { range: 'bytes=0-9' },
		method: 'HEAD',
		expected: undefined
	}
];

describe('ByteRangeRequest', () => {
	it.each(cases)('$name', ({ headers, method, expected }) => {
		const request = new Request('https://cupboard.test/nar/x.nar.zst', {
			headers,
			method
		});

		expect(ByteRangeRequest.of(request)?.select(size, etag)).toStrictEqual(
			expected
		);
	});
});

describe('ByteRangeRequest.startsAfterFirstByte', () => {
	it.each([
		{ range: 'bytes=100-', expected: true },
		{ range: 'bytes=5-9', expected: true },
		{ range: 'bytes=0-0', expected: false },
		{ range: 'bytes=0-', expected: false },
		{ range: 'bytes=-10', expected: false }
	])('$range: $expected', ({ range, expected }) => {
		const request = new Request('https://cupboard.test/nar/x.nar.zst', {
			headers: { range }
		});

		expect(ByteRangeRequest.of(request)?.startsAfterFirstByte()).toBe(expected);
	});
});
