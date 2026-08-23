import {
	cacheNameSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { isNotModified, narInfoObjectKey } from './http.ts';

const tenant = tenantIdSchema.parse('acme');
const buildsCache = cacheNameSchema.parse('builds');

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
		name: 'the request has no conditional headers',
		headers: {},
		expected: false
	}
];

describe('isNotModified', () => {
	it.each(cases)('returns $expected when $name', ({ headers, expected }) => {
		const responseHeaders = new Headers({
			etag,
			'last-modified': lastModified
		});

		expect(isNotModified(requestWith(headers), responseHeaders)).toBe(expected);
	});
});

describe('narInfoObjectKey', () => {
	const hash = storePathHashSchema.parse('0123456789abcdfghijklmnpqrsvwxyz');

	it('uses no cache segment for the default cache and adds one for a named cache', () => {
		expect({
			default: narInfoObjectKey(tenant, hash),
			named: narInfoObjectKey(tenant, hash, buildsCache)
		}).toStrictEqual({
			default: `t/acme/narinfo/${hash}`,
			named: `t/acme/narinfo/builds/${hash}`
		});
	});
});
