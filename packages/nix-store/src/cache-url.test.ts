import { describe, expect, it } from 'vitest';

import { cacheUrl, publicKeyUrl, reuseViewUrl } from './cache-url.ts';
import {
	InvalidCacheUrlBaseError,
	InvalidCacheUrlSegmentError
} from './errors.ts';

// Every builder derives its result from the base's origin and path alone, so
// a base smuggling anything else in, credentials that would be sent on every
// request or a query or fragment that would corrupt the built URL, is refused
// rather than partially honoured.
const unusableBases = [
	['a query string', 'https://cupboard.example.workers.dev/t/acme?tab=keys'],
	['a fragment', 'https://cupboard.example.workers.dev/t/acme#copied'],
	['an embedded username', 'https://ci@cupboard.example.workers.dev/t/acme'],
	[
		'embedded credentials',
		'https://ci:secret@cupboard.example.workers.dev/t/acme'
	]
] as const;

describe('cacheUrl', () => {
	it.each([
		{
			name: 'the default cache returns the bare base URL',
			base: 'https://cupboard.example.workers.dev',
			cache: undefined,
			expected: 'https://cupboard.example.workers.dev'
		},
		{
			name: 'the empty cache name is the default cache',
			base: 'https://cupboard.example.workers.dev',
			cache: '',
			expected: 'https://cupboard.example.workers.dev'
		},
		{
			name: 'a trailing slash on the base is trimmed for the default cache',
			base: 'https://cupboard.example.workers.dev/',
			cache: undefined,
			expected: 'https://cupboard.example.workers.dev'
		},
		{
			name: 'a named cache appends the cache path to a bare host',
			base: 'https://cupboard.example.workers.dev',
			cache: 'builds',
			expected: 'https://cupboard.example.workers.dev/cache/builds'
		},
		{
			name: 'a named cache preserves a tenant path prefix',
			base: 'https://cupboard.example.workers.dev/t/acme',
			cache: 'builds',
			expected: 'https://cupboard.example.workers.dev/t/acme/cache/builds'
		},
		{
			name: 'a trailing slash on the base is trimmed for a named cache',
			base: 'https://cupboard.example.workers.dev/t/acme/',
			cache: 'builds',
			expected: 'https://cupboard.example.workers.dev/t/acme/cache/builds'
		}
	])('$name', ({ base, cache, expected }) => {
		expect(cacheUrl(base, cache)).toBe(expected);
	});

	it.each([['.'], ['..']])(
		'refuses the path-traversal cache name %j',
		(cache) => {
			expect(() =>
				cacheUrl('https://cupboard.example.workers.dev', cache)
			).toThrow(InvalidCacheUrlSegmentError);
		}
	);

	it.each(unusableBases)('refuses a base carrying %s', (_name, base) => {
		expect(() => cacheUrl(base, 'builds')).toThrow(
			new InvalidCacheUrlBaseError()
		);
	});
});

describe('reuseViewUrl', () => {
	it.each([
		{
			name: 'appends the reuse view path to a bare host',
			base: 'https://cupboard.example.workers.dev',
			view: 'nightly',
			expected: 'https://cupboard.example.workers.dev/reuse/nightly'
		},
		{
			name: 'preserves a tenant path prefix',
			base: 'https://cupboard.example.workers.dev/t/acme',
			view: 'nightly',
			expected: 'https://cupboard.example.workers.dev/t/acme/reuse/nightly'
		}
	])('$name', ({ base, view, expected }) => {
		expect(reuseViewUrl(base, view)).toBe(expected);
	});

	it.each([[''], ['.'], ['..']])('refuses the view name %j', (view) => {
		expect(() =>
			reuseViewUrl('https://cupboard.example.workers.dev', view)
		).toThrow(InvalidCacheUrlSegmentError);
	});

	it.each(unusableBases)('refuses a base carrying %s', (_name, base) => {
		expect(() => reuseViewUrl(base, 'nightly')).toThrow(
			InvalidCacheUrlBaseError
		);
	});
});

describe('publicKeyUrl', () => {
	it.each([
		{
			name: 'appends the key path to a bare host',
			base: 'https://cupboard.example.workers.dev',
			expected: 'https://cupboard.example.workers.dev/pubkey'
		},
		{
			name: 'preserves a tenant path prefix',
			base: 'https://cupboard.example.workers.dev/t/acme',
			expected: 'https://cupboard.example.workers.dev/t/acme/pubkey'
		},
		{
			name: 'trims a trailing slash on the base',
			base: 'https://cupboard.example.workers.dev/t/acme/',
			expected: 'https://cupboard.example.workers.dev/t/acme/pubkey'
		}
	])('$name', ({ base, expected }) => {
		expect(publicKeyUrl(base)).toBe(expected);
	});

	it.each(unusableBases)('refuses a base carrying %s', (_name, base) => {
		expect(() => publicKeyUrl(base)).toThrow(InvalidCacheUrlBaseError);
	});
});
