import {
	DEFAULT_CACHE,
	identityForCache,
	storedCacheSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { legacyCacheKey } from './cache.ts';

describe('cache identity', () => {
	it.each([
		{ name: 'the default cache', cache: DEFAULT_CACHE },
		{ name: 'a public named cache', cache: 'builds' },
		{ name: 'a private named cache', cache: 'private/builds' }
	])('round-trips the legacy key for $name', ({ cache }) => {
		const stored = storedCacheSchema.parse(cache);
		const { scope, access } = identityForCache(stored);

		expect(legacyCacheKey(scope, access)).toBe(stored);
	});

	it.each([
		{
			name: 'the default cache',
			cache: DEFAULT_CACHE,
			identity: { scope: { kind: 'default' }, access: 'public' }
		},
		{
			name: 'a public named cache',
			cache: 'builds',
			identity: { scope: { kind: 'named', name: 'builds' }, access: 'public' }
		},
		{
			name: 'a private named cache',
			cache: 'private/builds',
			identity: { scope: { kind: 'named', name: 'builds' }, access: 'private' }
		}
	])('reads the scope and access of $name', ({ cache, identity }) => {
		expect(identityForCache(storedCacheSchema.parse(cache))).toStrictEqual(
			identity
		);
	});
});
