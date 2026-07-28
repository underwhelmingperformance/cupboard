import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { storeDirectorySchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { Nix } from './nix.ts';
import {
	InvalidNixStoreDirectoryError,
	type NixStoreClient,
	type NixValidPathInfo,
	NotInNixStoreError
} from './nix-store.ts';

const storeDirectory = storeDirectorySchema.parse('/nix/store');
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
	readonly closures: string[][];
}

function recordingStore(): RecordingStore {
	const queried: string[] = [];
	const closures: string[][] = [];

	return {
		queried,
		closures,
		queryPathInfo: (storePath) => {
			queried.push(storePath);

			return Promise.resolve(info(storePath));
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
});
