import { DEFAULT_CACHE, storedCacheSchema } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { describe, expect, it } from 'vitest';

import { cachePublicKeyRequestHeaders, cacheUrlFor } from './substituters.ts';

describe('cacheUrlFor', () => {
	it.each([
		[
			'https://cache.example.test/',
			DEFAULT_CACHE,
			'https://cache.example.test'
		],
		['https://cache.example.test', 'ci', 'https://cache.example.test/cache/ci']
	])('builds a substituter URL', (baseUrl, cache, expected) => {
		const substituter = cacheUrlFor(
			new URL(baseUrl),
			storedCacheSchema.parse(cache)
		);

		expect(canonicalHref(substituter)).toBe(expected);
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
