import { DEFAULT_CACHE, storedCacheSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	cachePublicKeyRequestHeaders,
	cacheUrlFor,
	isHttpUrl
} from './substituters.ts';

// The endpoint URLs built from a url input derive from its origin and path
// alone, so anything else the value carries is a copy mistake surfaced here
// with the offending field's name.
describe('isHttpUrl', () => {
	it.each([
		['a plain origin', 'https://cache.example.test'],
		['a tenant path', 'https://cache.example.test/t/acme'],
		['an http URL', 'http://localhost:8787/t/acme']
	])('accepts %s', (_name, value) => {
		expect(isHttpUrl(value)).toBe(true);
	});

	it.each([
		['a bare hostname', 'cache.example.test/t/acme'],
		['a non-http scheme', 'ftp://cache.example.test'],
		['a fragment', 'https://cache.example.test/t/acme#copied'],
		['a query string', 'https://cache.example.test/t/acme?tab=keys'],
		['an embedded username', 'https://ci@cache.example.test/t/acme'],
		['embedded credentials', 'https://ci:secret@cache.example.test/t/acme']
	])('refuses %s', (_name, value) => {
		expect(isHttpUrl(value)).toBe(false);
	});
});

describe('cacheUrlFor', () => {
	it.each([
		[
			'https://cache.example.test/',
			DEFAULT_CACHE,
			'https://cache.example.test'
		],
		['https://cache.example.test', 'ci', 'https://cache.example.test/cache/ci']
	])('builds a substituter URL', (baseUrl, cache, expected) => {
		expect(cacheUrlFor(baseUrl, storedCacheSchema.parse(cache))).toBe(expected);
	});
});

describe('cachePublicKeyRequestHeaders', () => {
	it('does not include GitHub authentication headers', () => {
		expect(cachePublicKeyRequestHeaders()).toStrictEqual({
			accept: 'text/plain',
			'user-agent': 'cupboard-action'
		});
	});
});
