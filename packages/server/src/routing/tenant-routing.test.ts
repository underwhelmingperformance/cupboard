import { describe, expect, it } from 'vitest';

import { parsePrivateCachePath } from './tenant-routing.ts';

interface ParsedRow {
	readonly pathname: string;
	readonly expected: { cache: string; rest: string };
}

interface RejectedRow {
	readonly pathname: string;
}

const parsedRows: readonly ParsedRow[] = [
	{
		pathname: '/private-cache/builds/nix-cache-info',
		expected: { cache: 'private/builds', rest: '/nix-cache-info' }
	},
	{
		pathname: '/private-cache/builds/',
		expected: { cache: 'private/builds', rest: '/' }
	},
	{
		pathname: '/private-cache/a.b-c_0/nar/x.nar.zst',
		expected: { cache: 'private/a.b-c_0', rest: '/nar/x.nar.zst' }
	},
	// `private` is an ordinary local name, so this path names the cache whose
	// stored name is `private/private`.
	{
		pathname: '/private-cache/private/builds/info',
		expected: { cache: 'private/private', rest: '/builds/info' }
	},
	{
		pathname: `/private-cache/${'b'.repeat(63)}/info`,
		expected: { cache: `private/${'b'.repeat(63)}`, rest: '/info' }
	}
];

const rejectedRows: readonly RejectedRow[] = [
	{ pathname: '/cache/builds/nix-cache-info' },
	{ pathname: '/nix-cache-info' },
	{ pathname: '/private-cacheXbuilds/info' },
	{ pathname: '/private-cache/builds' },
	{ pathname: '/private-cache/' },
	{ pathname: '/private-cache//nix-cache-info' },
	{ pathname: '/private-cache/_private-builds/info' },
	{ pathname: '/private-cache/_default/info' },
	{ pathname: '/private-cache/Builds/info' },
	{ pathname: '/private-cache/.builds/info' },
	{ pathname: '/private-cache/-builds/info' },
	{ pathname: `/private-cache/${'b'.repeat(64)}/info` }
];

describe('parsePrivateCachePath', () => {
	it.each(parsedRows)('parses $pathname', ({ pathname, expected }) => {
		const route = parsePrivateCachePath(pathname);

		expect(
			route === undefined ? undefined : { cache: route.cache, rest: route.rest }
		).toStrictEqual(expected);
	});

	it.each(rejectedRows)('rejects $pathname', ({ pathname }) => {
		expect(parsePrivateCachePath(pathname)).toBeUndefined();
	});
});
