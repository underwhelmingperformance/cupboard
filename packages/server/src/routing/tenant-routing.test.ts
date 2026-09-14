import { describe, expect, it } from 'vitest';

import {
	isLiteralNamespacePath,
	parseNamedCachePath,
	type RouteNamespace
} from './tenant-routing.ts';

interface Row {
	readonly pathname: string;
	readonly expected: {
		readonly scope: { readonly kind: 'named'; readonly name: string };
		readonly rest: string;
	};
}

const parsedRows: readonly Row[] = [
	{
		pathname: '/cache/builds/nix-cache-info',
		expected: {
			scope: { kind: 'named', name: 'builds' },
			rest: '/nix-cache-info'
		}
	},
	{
		pathname: '/cache/builds/',
		expected: { scope: { kind: 'named', name: 'builds' }, rest: '/' }
	},
	{
		pathname: '/cache/builds',
		expected: { scope: { kind: 'named', name: 'builds' }, rest: '/' }
	},
	{
		pathname: '/cache/a.b-c_0/nar/x.nar.zst',
		expected: {
			scope: { kind: 'named', name: 'a.b-c_0' },
			rest: '/nar/x.nar.zst'
		}
	},
	{
		pathname: `/cache/${'b'.repeat(63)}/info`,
		expected: {
			scope: { kind: 'named', name: 'b'.repeat(63) },
			rest: '/info'
		}
	}
];

const rejectedRows: readonly string[] = [
	'/nix-cache-info',
	'/cacheXbuilds/info',
	'/cache/',
	'/cache//nix-cache-info',
	'/cache/Builds/info',
	'/cache/.builds/info',
	'/cache/-builds/info',
	`/cache/${'b'.repeat(64)}/info`
];

describe('parseNamedCachePath', () => {
	it.each(parsedRows)('parses $pathname', ({ pathname, expected }) => {
		expect(parseNamedCachePath(pathname)).toStrictEqual(expected);
	});

	it.each(rejectedRows)('rejects %s', (pathname) => {
		expect(parseNamedCachePath(pathname)).toBeUndefined();
	});
});

interface NamespacePathRow {
	readonly rest: string;
	readonly namespace: RouteNamespace;
	readonly name: string;
	readonly expected: boolean;
}

const namespacePathRows: readonly NamespacePathRow[] = [
	{
		rest: '/cache/builds/nix-cache-info',
		namespace: 'cache',
		name: 'builds',
		expected: true
	},
	{
		rest: '/cache/%62uilds/nix-cache-info',
		namespace: 'cache',
		name: 'builds',
		expected: false
	},
	{
		rest: '/cach%65/builds/nix-cache-info',
		namespace: 'cache',
		name: 'builds',
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
		rest: '/cache/builds',
		namespace: 'cache',
		name: 'builds',
		expected: true
	},
	{
		rest: '/cache/buildsx/info',
		namespace: 'cache',
		name: 'builds',
		expected: false
	},
	{
		rest: '/reuse/private%2Freuse/nix-cache-info',
		namespace: 'reuse',
		name: 'private/reuse',
		expected: false
	},
	{
		rest: '/cache/%62uilds/builds/info',
		namespace: 'cache',
		name: 'builds',
		expected: false
	},
	{
		rest: '/cache/cache/nix-cache-info',
		namespace: 'cache',
		name: 'cache',
		expected: true
	},
	{
		rest: '/nix-cache-info',
		namespace: 'cache',
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
