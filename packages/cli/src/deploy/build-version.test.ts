import { env } from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveBuildVersion } from './build-version.ts';

describe('resolveBuildVersion', () => {
	afterEach(() => {
		delete env.CUPBOARD_BUILD_VERSION;
	});

	it('uses CUPBOARD_BUILD_VERSION when set, without consulting Git', async () => {
		env.CUPBOARD_BUILD_VERSION = 'abc123def456';

		const version = await resolveBuildVersion('/does/not/exist');

		expect(version).toBe('abc123def456');
	});

	it.each([['  '], ['']])(
		'falls back to the Git revision for a blank override (%j)',
		async (override) => {
			env.CUPBOARD_BUILD_VERSION = override;

			const version = await resolveBuildVersion(process.cwd());

			expect(version).toMatch(/^[0-9a-f]{12}(\+dirty)?$/);
		}
	);
});
