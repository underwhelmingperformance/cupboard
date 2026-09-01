import {
	cacheNameSchema,
	type CacheScope,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { isNotModified, narInfoObjectKey } from './http.ts';

const tenant = tenantIdSchema.parse('acme');
const buildsCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('builds')
};

const etag = '"abc"';
const lastModified = 'Thu, 01 Jan 2026 00:00:00 GMT';
const afterLastModified = 'Fri, 02 Jan 2026 00:00:00 GMT';
const beforeLastModified = 'Sun, 01 Jan 2023 00:00:00 GMT';

function requestWith(headers: Record<string, string>): Request {
	return new Request('https://cupboard.test/0.narinfo', { headers });
}

const cases: readonly {
	name: string;
	headers: Record<string, string>;
	responseEtag?: string;
	expected: boolean;
}[] = [
	{
		name: 'the request ETag matches',
		headers: { 'if-none-match': etag },
		expected: true
	},
	{
		name: 'the request ETag does not match',
		headers: { 'if-none-match': '"zzz"' },
		expected: false
	},
	{
		name: 'If-None-Match is *',
		headers: { 'if-none-match': '*' },
		expected: true
	},
	{
		name: 'an If-None-Match list contains the response ETag',
		headers: { 'if-none-match': '"zzz", "abc"' },
		expected: true
	},
	{
		name: 'an opaque ETag containing a comma',
		headers: { 'if-none-match': '"a,b"' },
		responseEtag: '"a,b"',
		expected: true
	},
	{
		name: 'a weak request ETag matches the strong response ETag',
		headers: { 'if-none-match': 'W/"abc"' },
		expected: true
	},
	{
		name: 'a non-matching If-None-Match accompanies a later If-Modified-Since',
		headers: {
			'if-none-match': '"zzz"',
			'if-modified-since': afterLastModified
		},
		expected: false
	},
	{
		name: 'only If-Modified-Since is later than Last-Modified',
		headers: { 'if-modified-since': afterLastModified },
		expected: true
	},
	{
		name: 'only If-Modified-Since is earlier than Last-Modified',
		headers: { 'if-modified-since': beforeLastModified },
		expected: false
	},
	{
		name: 'an RFC 850 If-Modified-Since date',
		headers: { 'if-modified-since': 'Friday, 02-Jan-26 00:00:00 GMT' },
		expected: true
	},
	{
		name: 'an asctime If-Modified-Since date',
		headers: { 'if-modified-since': 'Fri Jan  2 00:00:00 2026' },
		expected: true
	},
	{
		name: 'a preferred date with a leap second',
		headers: { 'if-modified-since': 'Wed, 31 Dec 2025 23:59:60 GMT' },
		expected: true
	},
	{
		name: 'an RFC 850 date with a leap second',
		headers: { 'if-modified-since': 'Wednesday, 31-Dec-25 23:59:60 GMT' },
		expected: true
	},
	{
		name: 'an asctime date with a leap second',
		headers: { 'if-modified-since': 'Wed Dec 31 23:59:60 2025' },
		expected: true
	},
	{
		name: 'a date with seconds above the leap-second value',
		headers: { 'if-modified-since': 'Wed, 31 Dec 2025 23:59:61 GMT' },
		expected: false
	},
	{
		name: 'a date with a leap-second value in the minutes field',
		headers: { 'if-modified-since': 'Wed, 31 Dec 2025 23:60:59 GMT' },
		expected: false
	},
	{
		name: 'an ISO If-Modified-Since date',
		headers: { 'if-modified-since': '2026-01-02T00:00:00Z' },
		expected: false
	},
	{
		name: 'an impossible If-Modified-Since date',
		headers: { 'if-modified-since': 'Tue, 31 Feb 2026 00:00:00 GMT' },
		expected: false
	},
	{ name: 'no conditional headers', headers: {}, expected: false }
];

describe('isNotModified', () => {
	it.each(cases)(
		'returns $expected when $name',
		({ headers, responseEtag = etag, expected }) => {
			const responseHeaders = new Headers({
				etag: responseEtag,
				'last-modified': lastModified
			});

			expect(isNotModified(requestWith(headers), responseHeaders)).toBe(
				expected
			);
		}
	);
});

describe('narInfoObjectKey', () => {
	const hash = storePathHashSchema.parse('0123456789abcdfghijklmnpqrsvwxyz');

	it('includes the cache generation and exact cache identity', () => {
		expect({
			default: narInfoObjectKey(tenant, hash, { kind: 'default' }),
			named: narInfoObjectKey(tenant, hash, buildsCache)
		}).toStrictEqual({
			default: `t/acme/narinfo/generation/1/default/${hash}`,
			named: `t/acme/narinfo/generation/1/named/builds/${hash}`
		});
	});
});
