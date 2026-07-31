import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type StoreDirectory,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { Nix } from './nix.ts';
import {
	InvalidNixStoreDirectoryError,
	type NixStoreClient,
	type NixValidPathInfo,
	NotInNixStoreError
} from './nix-store.ts';

const storeDirectory = storeDirectorySchema.parse('/nix/store');
const divertedStoreDirectory = storeDirectorySchema.parse(
	'/home/u/.local/share/nix/root/store'
);
const appPath = storePathSchema.parse(
	'/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app'
);
const libraryPath = storePathSchema.parse(
	'/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-lib'
);

function info(
	storePath: StorePathString,
	references: readonly StorePathString[] = []
): NixValidPathInfo {
	return {
		storePath,
		narHash: NixSha256Hash.fromDigest(new Uint8Array(32)),
		narSize: 1,
		references,
		signatures: [],
		ultimate: false
	};
}

interface RecordingStore extends NixStoreClient {
	readonly queried: string[];
	readonly validBatches: string[][];
	readonly substitutableBatches: string[][];
	readonly drvBatches: string[][];
	readonly closures: string[][];
}

function recordingStore(): RecordingStore {
	const queried: string[] = [];
	const validBatches: string[][] = [];
	const substitutableBatches: string[][] = [];
	const drvBatches: string[][] = [];
	const closures: string[][] = [];

	return {
		queried,
		validBatches,
		substitutableBatches,
		drvBatches,
		closures,
		queryPathInfo: (storePath) => {
			queried.push(storePath);

			return Promise.resolve(info(storePath));
		},
		queryValidPaths: (storePaths) => {
			validBatches.push([...storePaths]);

			return Promise.resolve(storePaths);
		},
		querySubstitutablePaths: (storePaths) => {
			substitutableBatches.push([...storePaths]);

			return Promise.resolve([]);
		},
		queryDerivationOutputPaths: (drvPaths) => {
			drvBatches.push([...drvPaths]);

			return Promise.resolve([]);
		},
		resolveClosure: (storePaths) => {
			closures.push([...storePaths]);

			return Promise.resolve(storePaths.map((storePath) => info(storePath)));
		}
	};
}

function nixOver(
	store: NixStoreClient,
	realpath: (path: string) => string = (path) => path,
	directory: StoreDirectory = storeDirectory
): Nix {
	return Nix.forStore(store, { storeDirectory: directory, realpath });
}

describe('Nix.toStorePath', () => {
	it.each([
		{ name: 'a canonical store path', input: appPath, expected: appPath },
		{
			name: 'a file inside a store path',
			input: `${appPath}/bin/app`,
			expected: appPath
		}
	])('returns the store path for $name', ({ input, expected }) => {
		expect(nixOver(recordingStore()).toStorePath(input)).toBe(expected);
	});

	// The store directory comes from the running configuration, so a store the
	// system diverted elsewhere resolves the same way the default one does.
	it('returns the store path under a diverted store directory', () => {
		const divertedPath = `${divertedStoreDirectory}/cccccccccccccccccccccccccccccccc-app`;
		const nix = nixOver(
			recordingStore(),
			(path) => path,
			divertedStoreDirectory
		);

		expect(nix.toStorePath(`${divertedPath}/bin/app`)).toBe(divertedPath);
	});

	it('resolves a symlink before taking the store path', () => {
		const nix = nixOver(recordingStore(), (path) =>
			path === '/home/u/result' ? appPath : path
		);

		expect(nix.toStorePath('/home/u/result')).toBe(appPath);
	});

	it('falls back to the argument when it cannot be resolved', () => {
		const nix = nixOver(recordingStore(), () => {
			throw new Error('ENOENT');
		});

		expect(nix.toStorePath(`${appPath}/bin`)).toBe(appPath);
	});

	it.each([
		{ name: 'outside the store directory', resolved: '/etc/passwd' },
		{
			name: 'a loose file beside the store paths',
			resolved: '/nix/store/notes.txt'
		},
		{
			name: 'the store directory itself',
			resolved: '/nix/store/'
		}
	])('throws when the path resolves to $name', ({ resolved }) => {
		const nix = nixOver(recordingStore(), () => resolved);

		expect(() => nix.toStorePath(resolved)).toThrow(NotInNixStoreError);
	});
});

describe('Nix.open', () => {
	it('refuses a configured store directory that could hold no store path', () => {
		const noConfigurationFiles: Record<string, string> = {};

		expect(() =>
			Nix.open({
				env: { NIX_STORE_DIR: 'relative/store' },
				readFile: (filePath) => noConfigurationFiles[filePath],
				homeDirectory: () => '/home/u',
				canWriteStateDirectory: () => true,
				socketExists: () => false,
				realpath: (path) => path
			})
		).toThrow(InvalidNixStoreDirectoryError);
	});
});

describe('Nix queries', () => {
	it('canonicalises before querying a single path', async () => {
		const store = recordingStore();

		await nixOver(store).queryPathInfo(`${appPath}/bin/app`);

		expect(store.queried).toStrictEqual([appPath]);
	});

	it('canonicalises every root before resolving a closure', async () => {
		const store = recordingStore();

		await nixOver(store).resolveClosure([`${appPath}/bin`, libraryPath]);

		expect(store.closures).toStrictEqual([[appPath, libraryPath]]);
	});

	it('canonicalises every valid-path candidate', async () => {
		const store = recordingStore();

		await nixOver(store).queryValidPaths([`${appPath}/bin`, libraryPath]);

		expect(store.validBatches).toStrictEqual([[appPath, libraryPath]]);
	});

	it('canonicalises every substitutable-path candidate', async () => {
		const store = recordingStore();

		await nixOver(store).querySubstitutablePaths([
			`${appPath}/bin`,
			libraryPath
		]);

		expect(store.substitutableBatches).toStrictEqual([[appPath, libraryPath]]);
	});

	it('canonicalises every derivation path in an output query', async () => {
		const store = recordingStore();

		await nixOver(store).queryDerivationOutputPaths([
			`${appPath}/bin`,
			libraryPath
		]);

		expect(store.drvBatches).toStrictEqual([[appPath, libraryPath]]);
	});
});
