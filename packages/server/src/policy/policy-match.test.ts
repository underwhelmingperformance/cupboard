import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { mostSpecificPolicy, type RetentionPolicy } from './policy-match.ts';

const policies: readonly RetentionPolicy[] = [
	{ scope: 'cache', cache: { kind: 'default' }, ttlSeconds: 2_592_000 },
	{
		scope: 'cache',
		cache: { kind: 'named', name: cacheNameSchema.parse('builds') },
		ttlSeconds: 1_209_600
	},
	{ scope: 'root-name-prefix', pattern: 'pr-', ttlSeconds: 604_800 },
	{ scope: 'root-name-prefix', pattern: 'pr-release-', ttlSeconds: 86_400 }
];

describe('mostSpecificPolicy', () => {
	it.each([
		{
			name: 'uses the longest matching root-name prefix',
			cache: { kind: 'default' } as const,
			rootName: 'pr-release-9',
			ttl: 86_400
		},
		{
			name: 'uses a root-name prefix instead of a cache policy',
			cache: {
				kind: 'named',
				name: cacheNameSchema.parse('builds')
			} as const,
			rootName: 'pr-9',
			ttl: 604_800
		},
		{
			name: 'uses a cache policy when no prefix matches',
			cache: {
				kind: 'named',
				name: cacheNameSchema.parse('builds')
			} as const,
			rootName: 'github:owner/repo/main',
			ttl: 1_209_600
		},
		{
			name: 'matches the default cache with an empty pattern',
			cache: { kind: 'default' } as const,
			rootName: 'github:owner/repo/main',
			ttl: 2_592_000
		},
		{
			name: 'returns undefined when no policy matches',
			cache: {
				kind: 'named',
				name: cacheNameSchema.parse('other')
			} as const,
			rootName: 'github:owner/repo/main',
			ttl: undefined
		}
	])('$name', ({ cache, rootName, ttl }) => {
		expect(
			mostSpecificPolicy(policies, {
				cache,
				name: rootName
			})?.ttlSeconds
		).toBe(ttl);
	});
});
