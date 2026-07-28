import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { describe, expect, it } from 'vitest';

import { Nix } from './nix.ts';
import {
	type NixStoreClient,
	type NixValidPathInfo,
	NotInNixStoreError
} from './nix-store.ts';

const storeDirectory = '/nix/store';
const appPath = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app';
const libraryPath = '/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-lib';

function info(
	storePath: string,
	references: readonly string[] = []
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
	readonly queriedBatches: string[][];
	readonly substitutableBatches: string[][];
	readonly validBatches: string[][];
	readonly closures: string[][];
}

function recordingStore(): RecordingStore {
	const queried: string[] = [];
	const queriedBatches: string[][] = [];
	const substitutableBatches: string[][] = [];
	const validBatches: string[][] = [];
	const closures: string[][] = [];

	return {
		queried,
		queriedBatches,
		substitutableBatches,
		validBatches,
		closures,
		queryDerivationOutputPaths: () => Promise.resolve([]),
		querySubstitutablePaths: (storePaths) => {
			substitutableBatches.push([...storePaths]);

			return Promise.resolve([]);
		},
		queryPathInfo: (storePath) => {
			queried.push(storePath);

			return Promise.resolve(info(storePath));
		},
		queryPathsInfo: (storePaths) => {
			queriedBatches.push([...storePaths]);

			return Promise.resolve(storePaths.map((storePath) => info(storePath)));
		},
		queryValidPathsInfo: (storePaths) => {
			validBatches.push([...storePaths]);

			return Promise.resolve(storePaths.map((storePath) => info(storePath)));
		},
		queryValidPaths: (storePaths) => {
			validBatches.push([...storePaths]);

			return Promise.resolve(storePaths);
		},
		resolveClosure: (storePaths) => {
			closures.push([...storePaths]);

			return Promise.resolve(storePaths.map((storePath) => info(storePath)));
		}
	};
}

function nixOver(
	store: NixStoreClient,
	realpath: (path: string) => string = (path) => path
): Nix {
	return Nix.forStore(store, { storeDirectory, realpath });
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

	it('throws when the path is outside the store', () => {
		const nix = nixOver(recordingStore(), () => '/etc/passwd');

		expect(() => nix.toStorePath('/etc/passwd')).toThrow(NotInNixStoreError);
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

	it('canonicalises every path in a batch query', async () => {
		const store = recordingStore();

		await nixOver(store).queryPathsInfo([`${appPath}/bin`, libraryPath]);

		expect(store.queriedBatches).toStrictEqual([[appPath, libraryPath]]);
	});

	it('canonicalises every path in a valid-path batch query', async () => {
		const store = recordingStore();

		await Promise.all([
			nixOver(store).queryValidPathsInfo([`${appPath}/bin`, libraryPath]),
			nixOver(store).queryValidPaths([`${appPath}/bin`, libraryPath])
		]);

		expect(store.validBatches).toStrictEqual([
			[appPath, libraryPath],
			[appPath, libraryPath]
		]);
	});

	it('canonicalises every substitutable-path candidate', async () => {
		const store = recordingStore();

		await nixOver(store).querySubstitutablePaths([
			`${appPath}/bin`,
			libraryPath
		]);

		expect(store.substitutableBatches).toStrictEqual([[appPath, libraryPath]]);
	});
});
