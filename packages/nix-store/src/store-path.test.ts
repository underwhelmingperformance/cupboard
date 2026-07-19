import { describe, expect, it } from 'vitest';

import { InvalidStorePathError } from './errors.ts';
import { storePathSchema } from './scalars.ts';
import { resolveRootTargets, StorePath, validStorePath } from './store-path.ts';

const app = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const library = storePathSchema.parse(
	'/nix/store/1123456789abcdfghijklmnpqrsvwxyz-lib'
);

describe('StorePath', () => {
	it('extracts the basename and store path hash', () => {
		const storePath = new StorePath(app);

		expect({
			basename: storePath.basename,
			hash: storePath.hash
		}).toStrictEqual({
			basename: '0123456789abcdfghijklmnpqrsvwxyz-app',
			hash: '0123456789abcdfghijklmnpqrsvwxyz'
		});
	});

	it.each([
		{ name: 'a path outside the store', value: '/tmp/example' },
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

describe('validStorePath', () => {
	it.each([
		{ name: 'a well-formed store path', value: app, expected: app },
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
		expect(resolveRootTargets([app, library])).toStrictEqual([
			{ storePathHash: '0123456789abcdfghijklmnpqrsvwxyz', storePath: app },
			{ storePathHash: '1123456789abcdfghijklmnpqrsvwxyz', storePath: library }
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
