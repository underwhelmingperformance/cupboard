import { describe, expect, it } from 'vitest';

import { InvalidStorePathError } from './errors.ts';
import { storePathSchema } from './scalars.ts';
import {
	resolveRootTargets,
	storeDirectoryOf,
	StorePath,
	storePathBasename,
	storePathHashOf,
	validStorePath
} from './store-path.ts';

const app = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const library = storePathSchema.parse(
	'/nix/store/1123456789abcdfghijklmnpqrsvwxyz-lib'
);
// Use a non-default store directory with a different-length suffix so a fixed
// hash offset would select the wrong characters.
const homeStoreApp = storePathSchema.parse(
	'/home/laney/nixstore/2123456789abcdfghijklmnpqrsvwxyz-app'
);
const nestedStoreApp = storePathSchema.parse(
	'/var/lib/cupboard/nix/store/3123456789abcdfghijklmnpqrsvwxyz-app'
);

describe('StorePath', () => {
	it.each([
		{
			name: 'the default store directory',
			value: app,
			expected: {
				storeDirectory: '/nix/store',
				basename: '0123456789abcdfghijklmnpqrsvwxyz-app',
				hash: '0123456789abcdfghijklmnpqrsvwxyz'
			}
		},
		{
			name: 'a store directory under a home directory',
			value: homeStoreApp,
			expected: {
				storeDirectory: '/home/laney/nixstore',
				basename: '2123456789abcdfghijklmnpqrsvwxyz-app',
				hash: '2123456789abcdfghijklmnpqrsvwxyz'
			}
		},
		{
			name: 'a deeply nested store directory',
			value: nestedStoreApp,
			expected: {
				storeDirectory: '/var/lib/cupboard/nix/store',
				basename: '3123456789abcdfghijklmnpqrsvwxyz-app',
				hash: '3123456789abcdfghijklmnpqrsvwxyz'
			}
		}
	])('returns the store, basename and hash of $name', ({ value, expected }) => {
		const storePath = new StorePath(value);

		expect({
			storeDirectory: storePath.storeDirectory,
			basename: storePath.basename,
			hash: storePath.hash
		}).toStrictEqual(expected);
	});

	it.each([
		{ name: 'a path with no store directory', value: '/example' },
		{ name: 'a relative path', value: 'nix/store/short-app' },
		{
			name: 'a store path with too short a hash',
			value: '/nix/store/short-app'
		},
		{
			name: 'a store path with no name',
			value: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz'
		}
	])('rejects $name on construction', ({ value }) => {
		expect(() => new StorePath(value)).toThrow(InvalidStorePathError);
	});
});

describe('store path derivations', () => {
	it.each([
		{
			value: app,
			storeDirectory: '/nix/store',
			basename: '0123456789abcdfghijklmnpqrsvwxyz-app',
			hash: '0123456789abcdfghijklmnpqrsvwxyz'
		},
		{
			value: homeStoreApp,
			storeDirectory: '/home/laney/nixstore',
			basename: '2123456789abcdfghijklmnpqrsvwxyz-app',
			hash: '2123456789abcdfghijklmnpqrsvwxyz'
		},
		{
			value: nestedStoreApp,
			storeDirectory: '/var/lib/cupboard/nix/store',
			basename: '3123456789abcdfghijklmnpqrsvwxyz-app',
			hash: '3123456789abcdfghijklmnpqrsvwxyz'
		}
	])(
		'derives the store, basename and hash of $value from its final segment',
		({ value, storeDirectory, basename, hash }) => {
			expect({
				storeDirectory: storeDirectoryOf(value),
				basename: storePathBasename(value),
				hash: storePathHashOf(value)
			}).toStrictEqual({ storeDirectory, basename, hash });
		}
	);
});

describe('validStorePath', () => {
	it.each([
		{ name: 'a well-formed store path', value: app, expected: app },
		{
			name: 'a well-formed path in another store',
			value: homeStoreApp,
			expected: homeStoreApp
		},
		{
			name: 'a bare hash placeholder with no store prefix',
			value: '/1rz4g4znpzjwh1xymhjpm42vipw92pr73vdgl6xs1hycac8kf2n9',
			expected: undefined
		},
		{
			name: 'a store path with no name',
			value: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz',
			expected: undefined
		},
		{
			name: 'a shape-valid path longer than the schema bound',
			value: `/nix/store/0123456789abcdfghijklmnpqrsvwxyz-${'n'.repeat(4096)}`,
			expected: undefined
		}
	])('returns $expected for $name', ({ value, expected }) => {
		expect(validStorePath(value)).toBe(expected);
	});
});

describe('resolveRootTargets', () => {
	it('resolves each target to its store-path hash, keeping order', () => {
		expect(
			resolveRootTargets([app, library, homeStoreApp, nestedStoreApp])
		).toStrictEqual([
			{ storePathHash: '0123456789abcdfghijklmnpqrsvwxyz', storePath: app },
			{ storePathHash: '1123456789abcdfghijklmnpqrsvwxyz', storePath: library },
			{
				storePathHash: '2123456789abcdfghijklmnpqrsvwxyz',
				storePath: homeStoreApp
			},
			{
				storePathHash: '3123456789abcdfghijklmnpqrsvwxyz',
				storePath: nestedStoreApp
			}
		]);
	});

	it('collapses targets that resolve to the same hash, keeping the first', () => {
		const alias = storePathSchema.parse(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app-alias'
		);

		expect(resolveRootTargets([app, alias, library])).toStrictEqual([
			{ storePathHash: '0123456789abcdfghijklmnpqrsvwxyz', storePath: app },
			{ storePathHash: '1123456789abcdfghijklmnpqrsvwxyz', storePath: library }
		]);
	});
});
