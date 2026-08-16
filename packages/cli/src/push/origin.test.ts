import type { NixValidPathInfo } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import {
	type BuildSubjectV3,
	type NixStoreUri,
	nixStoreUriSchema
} from '@cupboard/protocol/build';
import { describe, expect, it } from 'vitest';

import { publishedSubjects } from './origin.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const libraryPath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
);
const appDrv = '/nix/store/8123456789abcdfghijklmnpqrsvwxyz-app.drv';
const narHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 0xaa));
const buildStore = 'ssh-ng://builder.example';
const firstCache = nixStoreUriSchema.parse('https://first.example');
const secondCache = nixStoreUriSchema.parse('https://second.example');

function info(
	storePath: StorePathString,
	overrides: Partial<NixValidPathInfo> = {}
): NixValidPathInfo {
	return {
		storePath,
		narHash,
		narSize: 4,
		references: [],
		signatures: [],
		ultimate: false,
		...overrides
	};
}

function subjectsFor(
	infos: readonly NixValidPathInfo[],
	options: {
		readonly built?: ReadonlyMap<string, BuildSubjectV3>;
		readonly servable?: ReadonlySet<string>;
		readonly copiedFrom?: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
	} = {}
): readonly BuildSubjectV3[] {
	return publishedSubjects({
		built: options.built ?? new Map(),
		infos,
		servable:
			options.servable ?? new Set(infos.map((pathInfo) => pathInfo.storePath)),
		buildStore,
		copiedFrom: options.copiedFrom ?? new Map()
	});
}

describe('publishedSubjects', () => {
	const builtSubject: BuildSubjectV3 = {
		origin: 'built',
		storePath: appPath,
		narHash: narHash.digestHex(),
		derivation: appDrv,
		buildStore,
		verification: 'build-store'
	};

	it.each([
		{
			name: 'a path the store registered as its own work',
			pathInfo: info(appPath, { ultimate: true, deriver: appDrv }),
			expected: {
				origin: 'store-held',
				storePath: appPath,
				narHash: narHash.digestHex(),
				derivation: appDrv,
				buildStore
			}
		},
		{
			name: 'a path the store registered with no deriver',
			pathInfo: info(appPath, { ultimate: true }),
			expected: {
				origin: 'store-held',
				storePath: appPath,
				narHash: narHash.digestHex(),
				buildStore
			}
		},
		{
			name: 'a copied path with the signatures the store holds for it',
			pathInfo: info(appPath, {
				deriver: appDrv,
				signatures: ['cache.example.org-1:c2ln']
			}),
			expected: {
				origin: 'copied',
				storePath: appPath,
				narHash: narHash.digestHex(),
				derivation: appDrv,
				signatures: ['cache.example.org-1:c2ln']
			}
		},
		{
			name: 'a copied path the store holds no signature for',
			pathInfo: info(appPath),
			expected: {
				origin: 'copied',
				storePath: appPath,
				narHash: narHash.digestHex(),
				signatures: []
			}
		},
		{
			name: 'a copied path that has a content address',
			pathInfo: info(appPath, { ca: 'fixed:r:sha256:abc' }),
			expected: {
				origin: 'copied',
				storePath: appPath,
				narHash: narHash.digestHex(),
				signatures: [],
				ca: 'fixed:r:sha256:abc'
			}
		}
	])('describes $name', ({ pathInfo, expected }) => {
		expect(subjectsFor([pathInfo])).toStrictEqual([expected]);
	});

	it('records the stores the run watched a path being copied from', () => {
		expect(
			subjectsFor([info(appPath)], {
				copiedFrom: new Map([[appPath, [firstCache, secondCache]]])
			})
		).toStrictEqual([
			{
				origin: 'copied',
				storePath: appPath,
				narHash: narHash.digestHex(),
				signatures: [],
				copiedFrom: ['https://first.example', 'https://second.example']
			}
		]);
	});

	it('leaves out a path the run copied but did not publish', () => {
		expect(
			subjectsFor([info(appPath)], {
				servable: new Set(),
				copiedFrom: new Map([[appPath, [firstCache]]])
			})
		).toStrictEqual([]);
	});

	it('keeps the attribution subject for a path the run built', () => {
		expect(
			subjectsFor([info(appPath, { ultimate: true, deriver: appDrv })], {
				built: new Map([[appPath, builtSubject]])
			})
		).toStrictEqual([builtSubject]);
	});

	it('describes every published path once, sorted by store path', () => {
		expect(
			subjectsFor(
				[
					info(libraryPath, { ultimate: true }),
					info(appPath, { ultimate: true, deriver: appDrv })
				],
				{ built: new Map([[appPath, builtSubject]]) }
			)
		).toStrictEqual([
			builtSubject,
			{
				origin: 'store-held',
				storePath: libraryPath,
				narHash: narHash.digestHex(),
				buildStore
			}
		]);
	});
});
