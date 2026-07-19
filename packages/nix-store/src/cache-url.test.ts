import { describe, expect, it } from 'vitest';

import { cacheUrl, reuseViewUrl } from './cache-url.ts';
import { InvalidCacheUrlSegmentError } from './errors.ts';

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
});
