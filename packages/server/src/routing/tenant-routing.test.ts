import { describe, expect, it } from 'vitest';

import {
	addressedCache,
	isLiteralNamespacePath,
	type RouteNamespace
} from './tenant-routing.ts';

interface AddressedCacheRow {
	readonly pathname: string;
	readonly expected: string;
}

// The default cache, which is what a path that names no cache resolves to, and
// what a path whose cache name does not parse resolves to as well.
const defaultCache = '';

const addressedCacheRows: readonly AddressedCacheRow[] = [
	{
		pathname: '/private-cache/builds/nix-cache-info',
		expected: 'private/builds'
	},
	{ pathname: '/private-cache/builds/', expected: 'private/builds' },
	// The prefix by itself addresses the cache root.
	{ pathname: '/private-cache/builds', expected: 'private/builds' },
	{
		pathname: '/private-cache/a.b-c_0/nar/x.nar.zst',
		expected: 'private/a.b-c_0'
	},
	// `private` is an ordinary local name, so this path names the cache whose
	// stored name is `private/private`.
	{
		pathname: '/private-cache/private/builds/info',
		expected: 'private/private'
	},
	{
		pathname: `/private-cache/${'b'.repeat(63)}/info`,
		expected: `private/${'b'.repeat(63)}`
	},
	{ pathname: '/cache/builds/nix-cache-info', expected: 'builds' },
	{ pathname: '/cache/_default/nix-cache-info', expected: defaultCache },
	{ pathname: '/nix-cache-info', expected: defaultCache },
	{ pathname: '/caches', expected: defaultCache },
	{ pathname: '/private-cacheXbuilds/info', expected: defaultCache },
	{ pathname: '/private-cache/', expected: defaultCache },
	{ pathname: '/private-cache//nix-cache-info', expected: defaultCache },
	{ pathname: '/private-cache/_private-builds/info', expected: defaultCache },
	{ pathname: '/private-cache/_default/info', expected: defaultCache },
	{ pathname: '/private-cache/Builds/info', expected: defaultCache },
	{ pathname: '/private-cache/.builds/info', expected: defaultCache },
	{ pathname: '/private-cache/-builds/info', expected: defaultCache },
	{
		pathname: `/private-cache/${'b'.repeat(64)}/info`,
		expected: defaultCache
	},
	{ pathname: '/cache/%62uilds/info', expected: defaultCache },
	{ pathname: '/cache/Builds/info', expected: defaultCache },
	{ pathname: '/cache/', expected: defaultCache }
];

describe('addressedCache', () => {
	it.each(addressedCacheRows)(
		'reads $expected from $pathname',
		({ pathname, expected }) => {
			expect(addressedCache(pathname)).toBe(expected);
		}
	);
});

interface NamespacePathRow {
	readonly rest: string;
	readonly namespace: RouteNamespace;
	readonly name: string;
	readonly expected: boolean;
}

const namespacePathRows: readonly NamespacePathRow[] = [
	{
		rest: '/private-cache/builds/nix-cache-info',
		namespace: 'private-cache',
		name: 'builds',
		expected: true
	},
	{
		rest: '/private-cache/%62uilds/nix-cache-info',
		namespace: 'private-cache',
		name: 'builds',
		expected: false
	},
	// Hono matches the decoded path, so an encoded namespace reaches the route
	// that owns the decoded spelling.
	{
		rest: '/private%2Dcache/builds/nix-cache-info',
		namespace: 'private-cache',
		name: 'builds',
		expected: false
	},
	{
		rest: '/private%2Dcache/%62uilds/nix-cache-info',
		namespace: 'private-cache',
		name: 'builds',
		expected: false
	},
	{
		rest: '/cache/_default/nar/x.nar.zst',
		namespace: 'cache',
		name: '_default',
		expected: true
	},
	{
		rest: '/cach%65/_default/nix-cache-info',
		namespace: 'cache',
		name: '_default',
		expected: false
	},
	{
		rest: '/cache/%5Fdefault/nix-cache-info',
		namespace: 'cache',
		name: '_default',
		expected: false
	},
	{
		rest: '/reuse/pull-requests/abc.narinfo',
		namespace: 'reuse',
		name: 'pull-requests',
		expected: true
	},
	{
		rest: '/reus%65/pull-requests/abc.narinfo',
		namespace: 'reuse',
		name: 'pull-requests',
		expected: false
	},
	{
		rest: '/private-reuse/reuse/',
		namespace: 'private-reuse',
		name: 'reuse',
		expected: true
	},
	{
		rest: '/private%2Dreuse/reuse/nix-cache-info',
		namespace: 'private-reuse',
		name: 'reuse',
		expected: false
	},
	// The prefix by itself addresses the cache root.
	{
		rest: '/private-cache/builds',
		namespace: 'private-cache',
		name: 'builds',
		expected: true
	},
	// The name must fill the whole segment, so a longer name that starts with it
	// is a different cache.
	{
		rest: '/private-cache/buildsx/info',
		namespace: 'private-cache',
		name: 'builds',
		expected: false
	},
	{
		rest: '/reuse/private%2Freuse/nix-cache-info',
		namespace: 'reuse',
		name: 'private/reuse',
		expected: false
	},
	// A later segment that repeats the namespace or the name is not the segment
	// the route matched.
	{
		rest: '/private-cache/%62uilds/builds/info',
		namespace: 'private-cache',
		name: 'builds',
		expected: false
	},
	{
		rest: '/private%2Dcache/private-cache/builds/info',
		namespace: 'private-cache',
		name: 'builds',
		expected: false
	},
	// Both segments may legitimately spell the same word.
	{
		rest: '/cache/cache/nix-cache-info',
		namespace: 'cache',
		name: 'cache',
		expected: true
	},
	// A path that addresses no cache or view has no such segments to compare.
	{
		rest: '/nix-cache-info',
		namespace: 'private-cache',
		name: 'builds',
		expected: false
	},
	{ rest: '/', namespace: 'cache', name: '', expected: false }
];

describe('isLiteralNamespacePath', () => {
	it.each(namespacePathRows)(
		'returns $expected for $namespace and $name in $rest',
		({ rest, namespace, name, expected }) => {
			expect(isLiteralNamespacePath(rest, namespace, name)).toBe(expected);
		}
	);
});
