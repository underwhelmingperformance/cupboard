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
				{ storePath: appPath, kind: 'target', source: 'local' },
				{ storePath: runtimePath, kind: 'intermediate', source: 'local' }
			]
		},
		{
			name: 'deduplicates repeated declarations within one kind',
			input: {
				targets: [appPath, appPath],
				intermediatePaths: [runtimePath, runtimePath]
			},
			expected: [
				{ storePath: appPath, kind: 'target', source: 'local' },
				{ storePath: runtimePath, kind: 'intermediate', source: 'local' }
			]
		},
		{
			name: 'resolves a path declared as both kinds to a target',
			input: {
				targets: [appPath],
				intermediatePaths: [appPath, builderPath]
			},
			expected: [
				{ storePath: appPath, kind: 'target', source: 'local' },
				{ storePath: builderPath, kind: 'intermediate', source: 'local' }
			]
		},
		{
			name: 'carries targets alone when no intermediates are declared',
			input: { targets: [appPath, runtimePath] },
			expected: [
				{ storePath: appPath, kind: 'target', source: 'local' },
				{ storePath: runtimePath, kind: 'target', source: 'local' }
			]
		},
		{
			name: 'tags reference paths as targets read from the reference source',
			input: { targets: [appPath], referencePaths: [runtimePath] },
			expected: [
				{ storePath: appPath, kind: 'target', source: 'local' },
				{ storePath: runtimePath, kind: 'target', source: 'reference' }
			]
		},
		{
			name: 'a path declared as a target and by reference reads from the source',
			input: { targets: [appPath], referencePaths: [appPath] },
			expected: [{ storePath: appPath, kind: 'target', source: 'reference' }]
		},
		{
			name: 'a path declared as an intermediate and by reference is a target',
			input: {
				targets: [appPath],
				intermediatePaths: [runtimePath],
				referencePaths: [runtimePath]
			},
			expected: [
				{ storePath: appPath, kind: 'target', source: 'local' },
				{ storePath: runtimePath, kind: 'target', source: 'reference' }
			]
		}
	])('$name', ({ input, expected }) => {
		const collection = PublicationCollection.of(input);

		expect({
			entries: collection.entries,
			storePaths: collection.storePaths,
			targetPaths: collection.targetPaths,
			localEntries: collection.localEntries,
			referenceEntries: collection.referenceEntries
		}).toStrictEqual({
			entries: expected,
			storePaths: expected.map((entry) => entry.storePath),
			targetPaths: expected
				.filter((entry) => entry.kind === 'target')
				.map((entry) => entry.storePath),
			localEntries: expected.filter((entry) => entry.source === 'local'),
			referenceEntries: expected.filter((entry) => entry.source === 'reference')
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
