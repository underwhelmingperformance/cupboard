import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { PublicationCollection } from './publication.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const runtimePath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime'
);
const builderPath = storePathSchema.parse(
	'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-builder'
);

describe('PublicationCollection', () => {
	it.each([
		{
			name: 'tags targets and intermediates with their declared kinds',
			input: { targets: [appPath], intermediatePaths: [runtimePath] },
			expected: [
				{ storePath: appPath, kind: 'target' },
				{ storePath: runtimePath, kind: 'intermediate' }
			]
		},
		{
			name: 'deduplicates repeated declarations within one kind',
			input: {
				targets: [appPath, appPath],
				intermediatePaths: [runtimePath, runtimePath]
			},
			expected: [
				{ storePath: appPath, kind: 'target' },
				{ storePath: runtimePath, kind: 'intermediate' }
			]
		},
		{
			name: 'resolves a path declared as both kinds to a target',
			input: {
				targets: [appPath],
				intermediatePaths: [appPath, builderPath]
			},
			expected: [
				{ storePath: appPath, kind: 'target' },
				{ storePath: builderPath, kind: 'intermediate' }
			]
		},
		{
			name: 'carries targets alone when no intermediates are declared',
			input: { targets: [appPath, runtimePath] },
			expected: [
				{ storePath: appPath, kind: 'target' },
				{ storePath: runtimePath, kind: 'target' }
			]
		}
	])('$name', ({ input, expected }) => {
		const collection = PublicationCollection.of(input);

		expect({
			entries: collection.entries,
			storePaths: collection.storePaths,
			targetPaths: collection.targetPaths
		}).toStrictEqual({
			entries: expected,
			storePaths: expected.map((entry) => entry.storePath),
			targetPaths: expected
				.filter((entry) => entry.kind === 'target')
				.map((entry) => entry.storePath)
		});
	});

	it.each([
		{
			name: 'a target outside the store',
			input: { targets: ['./result'] },
			invalid: './result'
		},
		{
			name: 'an intermediate outside the store',
			input: { targets: [appPath], intermediatePaths: ['/tmp/out'] },
			invalid: '/tmp/out'
		}
	])('refuses $name', ({ input, invalid }) => {
		let error: unknown;
		try {
			PublicationCollection.of(input);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(InvalidStorePathError);

		if (!(error instanceof InvalidStorePathError)) {
			return;
		}

		expect({ name: error.name, storePath: error.storePath }).toStrictEqual({
			name: 'InvalidStorePathError',
			storePath: invalid
		});
	});
});
