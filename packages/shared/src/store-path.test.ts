import { describe, expect, it } from 'vitest';

import { resolveRootTargets } from './store-path.ts';

const app = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const library = '/nix/store/1123456789abcdfghijklmnpqrsvwxyz-lib';

describe('resolveRootTargets', () => {
	it('resolves each target to its store-path hash, keeping order', () => {
		expect(resolveRootTargets([app, library])).toStrictEqual([
			{ storePathHash: '0123456789abcdfghijklmnpqrsvwxyz', storePath: app },
			{ storePathHash: '1123456789abcdfghijklmnpqrsvwxyz', storePath: library }
		]);
	});

	it('collapses targets that resolve to the same hash, keeping the first', () => {
		const alias = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app-alias';

		expect(resolveRootTargets([app, alias, library])).toStrictEqual([
			{ storePathHash: '0123456789abcdfghijklmnpqrsvwxyz', storePath: app },
			{ storePathHash: '1123456789abcdfghijklmnpqrsvwxyz', storePath: library }
		]);
	});
});
