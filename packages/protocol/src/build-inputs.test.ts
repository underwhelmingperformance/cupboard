import { describe, expect, it } from 'vitest';

import { buildInputsRecordBodySchema } from './build-inputs.ts';

const storePathHash = '0'.repeat(32);
const entry = {
	storePath: `/nix/store/${storePathHash}-app`,
	buildInputs: [`${'1'.repeat(32)}-gcc`],
	buildInputsVersion: 1
};

describe('buildInputsRecordBodySchema', () => {
	it.each([
		{ name: 'the same store path', second: entry },
		{
			name: 'another store path with the same hash',
			second: { ...entry, storePath: `/nix/store/${storePathHash}-other` }
		}
	])('refuses $name twice in one request', ({ second }) => {
		const result = buildInputsRecordBodySchema.safeParse({
			entries: [entry, second]
		});

		expect(
			result.success
				? []
				: result.error.issues.map((issue) => ({
						code: issue.code,
						path: issue.path
					}))
		).toStrictEqual([{ code: 'custom', path: ['entries', 1, 'storePath'] }]);
	});
});
