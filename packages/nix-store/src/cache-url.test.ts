import { describe, expect, it } from 'vitest';

import {
	cacheUrl,
	publicKeyUrl,
	reuseViewUrl,
	tenantUrl
} from './cache-url.ts';
import { InvalidCacheUrlSegmentError } from './errors.ts';
import { DEFAULT_CACHE, storedCacheSchema } from './scalars.ts';
import { parseBaseUrl } from './url.ts';

// Bases reach the builders through `parseBaseUrl`, so they are exercised the
// way callers hand them over: already checked, already free of trailing path
// slashes.
function base(value: string): URL {
	return parseBaseUrl(new URL(value));
}

describe('cacheUrl', () => {
	it.each([
		{
			name: 'the default cache returns the bare base URL',
			value: 'https://cupboard.example.workers.dev',
			cache: undefined,
			expected: 'https://cupboard.example.workers.dev/'
		},
		{
			name: 'the empty cache name is the default cache',
			value: 'https://cupboard.example.workers.dev',
			cache: storedCacheSchema.parse(DEFAULT_CACHE),
			expected: 'https://cupboard.example.workers.dev/'
		},
		{
			name: 'a trailing slash on the base is dropped for the default cache',
			value: 'https://cupboard.example.workers.dev/t/acme/',
			cache: undefined,
			expected: 'https://cupboard.example.workers.dev/t/acme'
		},
		{
			name: 'a named cache appends the cache path to a bare host',
			value: 'https://cupboard.example.workers.dev',
			cache: storedCacheSchema.parse('builds'),
			expected: 'https://cupboard.example.workers.dev/cache/builds'
		},
		{
			name: 'a named cache preserves a tenant path prefix',
			value: 'https://cupboard.example.workers.dev/t/acme',
			cache: storedCacheSchema.parse('builds'),
			expected: 'https://cupboard.example.workers.dev/t/acme/cache/builds'
		},
		{
			name: 'a trailing slash on the base is dropped for a named cache',
			value: 'https://cupboard.example.workers.dev/t/acme/',
			cache: storedCacheSchema.parse('builds'),
			expected: 'https://cupboard.example.workers.dev/t/acme/cache/builds'
		}
	])('$name', ({ value, cache, expected }) => {
		expect(cacheUrl(base(value), cache).href).toBe(expected);
	});

	// A builder hands back a URL of its own, so a caller that goes on to edit
	// the result cannot reach back into the base every other URL is built from.
	it('leaves the base URL it was given untouched', () => {
		const baseUrl = base('https://cupboard.example.workers.dev/t/acme');

		cacheUrl(baseUrl, storedCacheSchema.parse('builds')).pathname = '/edited';

		expect(baseUrl.href).toBe('https://cupboard.example.workers.dev/t/acme');
	});
});

describe('tenantUrl', () => {
	it.each([
		{
			name: 'appends the tenant path to a bare host',
			value: 'https://cupboard.example.workers.dev',
			tenant: 'acme',
			expected: 'https://cupboard.example.workers.dev/t/acme'
		},
		{
			name: 'drops a trailing slash on the base',
			value: 'https://cupboard.example.workers.dev/',
			tenant: 'acme',
			expected: 'https://cupboard.example.workers.dev/t/acme'
		}
	])('$name', ({ value, tenant, expected }) => {
		expect(tenantUrl(base(value), tenant).href).toBe(expected);
	});

	it.each([[''], ['.'], ['..']])('refuses the tenant slug %j', (tenant) => {
		expect(() =>
			tenantUrl(base('https://cupboard.example.workers.dev'), tenant)
		).toThrow(InvalidCacheUrlSegmentError);
	});
});

describe('reuseViewUrl', () => {
	it.each([
		{
			name: 'appends the reuse view path to a bare host',
			value: 'https://cupboard.example.workers.dev',
			view: 'nightly',
			expected: 'https://cupboard.example.workers.dev/reuse/nightly'
		},
		{
			name: 'preserves a tenant path prefix',
			value: 'https://cupboard.example.workers.dev/t/acme',
			view: 'nightly',
			expected: 'https://cupboard.example.workers.dev/t/acme/reuse/nightly'
		}
	])('$name', ({ value, view, expected }) => {
		expect(reuseViewUrl(base(value), view).href).toBe(expected);
	});

	it.each([[''], ['.'], ['..']])('refuses the view name %j', (view) => {
		expect(() =>
			reuseViewUrl(base('https://cupboard.example.workers.dev'), view)
		).toThrow(InvalidCacheUrlSegmentError);
	});
});

describe('publicKeyUrl', () => {
	it.each([
		{
			name: 'appends the key path to a bare host',
			value: 'https://cupboard.example.workers.dev',
			expected: 'https://cupboard.example.workers.dev/pubkey'
		},
		{
			name: 'preserves a tenant path prefix',
			value: 'https://cupboard.example.workers.dev/t/acme',
			expected: 'https://cupboard.example.workers.dev/t/acme/pubkey'
		},
		{
			name: 'drops a trailing slash on the base',
			value: 'https://cupboard.example.workers.dev/t/acme/',
			expected: 'https://cupboard.example.workers.dev/t/acme/pubkey'
		}
	])('$name', ({ value, expected }) => {
		expect(publicKeyUrl(base(value)).href).toBe(expected);
	});
});
