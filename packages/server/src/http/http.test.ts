import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { isNotModified, narInfoCachePath, narInfoObjectKey } from './http.ts';

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
		name: 'matching ETag',
		headers: { 'if-none-match': etag },
		expected: true
	},
	{
		name: 'non-matching ETag',
		headers: { 'if-none-match': '"zzz"' },
		expected: false
	},
	{
		name: 'a star matches the existing representation',
		headers: { 'if-none-match': '*' },
		expected: true
	},
	{
		name: 'a comma-separated list containing the ETag',
		headers: { 'if-none-match': '"zzz", "abc"' },
		expected: true
	},
	{
		name: 'a weak request tag against the strong ETag',
		headers: { 'if-none-match': 'W/"abc"' },
		expected: true
	},
	{
		name: 'a non-matching If-None-Match ignores a satisfying If-Modified-Since',
		headers: {
			'if-none-match': '"zzz"',
			'if-modified-since': afterLastModified
		},
		expected: false
	},
	{
		name: 'If-Modified-Since alone, not modified since',
		headers: { 'if-modified-since': afterLastModified },
		expected: true
	},
	{
		name: 'If-Modified-Since alone, modified since',
		headers: { 'if-modified-since': beforeLastModified },
		expected: false
	},
	{ name: 'no conditional headers', headers: {}, expected: false }
];

describe('isNotModified', () => {
	it.each(cases)('$name', ({ headers, expected }) => {
		const responseHeaders = new Headers({
			etag,
			'last-modified': lastModified
		});

		expect(isNotModified(requestWith(headers), responseHeaders)).toBe(expected);
	});
});

describe('narInfoObjectKey', () => {
	const hash = storePathHashSchema.parse('0123456789abcdfghijklmnpqrsvwxyz');

	it('namespaces by tenant, bare for the default cache and nested for a named one', () => {
		expect({
			default: narInfoObjectKey('acme', hash),
			named: narInfoObjectKey('acme', hash, 'builds')
		}).toStrictEqual({
			default: `t/acme/narinfo/${hash}`,
			named: `t/acme/narinfo/builds/${hash}`
		});
	});
});

describe('narInfoCachePath', () => {
	const hash = storePathHashSchema.parse('0123456789abcdfghijklmnpqrsvwxyz');

	it('carries the tenant prefix, bare for the default cache and nested for a named one', () => {
		expect({
			default: narInfoCachePath('acme', hash),
			named: narInfoCachePath('acme', hash, 'builds')
		}).toStrictEqual({
			default: `/t/acme/${hash}.narinfo`,
			named: `/t/acme/cache/builds/${hash}.narinfo`
		});
	});
});
