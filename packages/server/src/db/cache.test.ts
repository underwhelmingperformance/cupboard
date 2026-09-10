import {
	DEFAULT_CACHE,
	identityForCache,
	storedCacheSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CacheIdentityMissingError } from '../errors.ts';

import { cacheScopeFromRow, legacyCacheKey } from './cache.ts';

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

	it.each([
		{
			name: 'a default row',
			row: { kind: 'default' },
			scope: { kind: 'default' }
		},
		{
			name: 'a named row',
			row: { kind: 'named', name: 'builds' },
			scope: { kind: 'named', name: 'builds' }
		}
	] as const)('reads the scope of $name', ({ row, scope }) => {
		expect(cacheScopeFromRow(row)).toStrictEqual(scope);
	});

	it.each([
		{ name: 'a default row with a name', row: { kind: 'default', name: 'x' } },
		{ name: 'a named row without a name', row: { kind: 'named' } }
	] as const)('refuses $name', ({ row }) => {
		expect(() => cacheScopeFromRow(row)).toThrow(z.ZodError);
	});

	// A row with no kind belongs to no cache. Reading it as the default cache
	// would attribute it to the wrong one, so it is refused instead.
	it('refuses a row the backfill has not reached', () => {
		expect(() => cacheScopeFromRow({})).toThrow(CacheIdentityMissingError);
	});
});
