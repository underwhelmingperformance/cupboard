import { storedCacheSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { mostSpecificPolicy, type RetentionPolicy } from './policy-match.ts';

const policies: readonly RetentionPolicy[] = [
	{ scope: 'cache', pattern: '', ttlSeconds: 2_592_000 },
	{ scope: 'cache', pattern: 'builds', ttlSeconds: 1_209_600 },
	{ scope: 'root-name-prefix', pattern: 'pr-', ttlSeconds: 604_800 },
	{ scope: 'root-name-prefix', pattern: 'pr-release-', ttlSeconds: 86_400 }
];

describe('mostSpecificPolicy', () => {
	it.each([
		{
			name: 'a longer prefix wins over a shorter one',
			cache: '',
			rootName: 'pr-release-9',
			ttl: 86_400
		},
		{
			name: 'a prefix match wins over a cache match',
			cache: 'builds',
			rootName: 'pr-9',
			ttl: 604_800
		},
		{
			name: 'a cache match applies when no prefix matches',
			cache: 'builds',
			rootName: 'github:owner/repo/main',
			ttl: 1_209_600
		},
		{
			name: 'a cache policy targets the default cache by empty pattern',
			cache: '',
			rootName: 'github:owner/repo/main',
			ttl: 2_592_000
		},
		{
			name: 'no policy matches',
			cache: 'other',
			rootName: 'github:owner/repo/main',
			ttl: undefined
		}
	])('$name', ({ cache, rootName, ttl }) => {
		expect(
			mostSpecificPolicy(policies, {
				cache: storedCacheSchema.parse(cache),
				name: rootName
			})?.ttlSeconds
		).toBe(ttl);
	});
});
