import type { NixValidPathInfo } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type BuildSubjectV3Input,
	type NixStoreUri,
	nixStoreUriSchema
} from '@cupboard/protocol/build';
import { describe, expect, it } from 'vitest';

import { publishedSubjects, republishedSubject } from './origin.ts';
import type { ReferenceMetadata } from './reference.ts';

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
		readonly described?: ReadonlyMap<string, BuildSubjectV3Input>;
		readonly servable?: ReadonlySet<string>;
		readonly copiedFrom?: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
	} = {}
): readonly BuildSubjectV3Input[] {
	return publishedSubjects({
		described: options.described ?? new Map(),
		infos,
		servable:
			options.servable ?? new Set(infos.map((pathInfo) => pathInfo.storePath)),
		buildStore,
		copiedFrom: options.copiedFrom ?? new Map()
	});
}

const metadataSource = 'https://cache.example.workers.dev/t/acme';

function referenceMetadata(
	overrides: Partial<ReferenceMetadata['upload']> = {},
	signatures: readonly string[] = ['cache.example.org-1:c2ln']
): ReferenceMetadata {
	return {
		upload: {
			storePathHash: StorePath.hash(appPath),
			storePath: appPath,
			narHash: narHash.toString(),
			narSize: 4,
			references: [],
			fileHash: narHash.toString(),
			fileSize: 2,
			compression: 'zstd',
			...overrides
		},
		signatures
	};
}

describe('republishedSubject', () => {
	it('records the source URL and provenance fields from the narinfo', () => {
		expect(
			republishedSubject(
				referenceMetadata({
					deriver: '8123456789abcdfghijklmnpqrsvwxyz-app.drv',
					ca: 'fixed:r:sha256:abc'
				}),
				metadataSource
			)
		).toStrictEqual({
			origin: 'republished',
			storePath: appPath,
			narHash: narHash.digestHex(),
			derivation: '/nix/store/8123456789abcdfghijklmnpqrsvwxyz-app.drv',
			signatures: ['cache.example.org-1:c2ln'],
			ca: 'fixed:r:sha256:abc',
			metadataSource
		});
	});

	it('omits optional fields absent from the served narinfo', () => {
		expect(
			republishedSubject(referenceMetadata({}, []), metadataSource)
		).toStrictEqual({
			origin: 'republished',
			storePath: appPath,
			narHash: narHash.digestHex(),
			signatures: [],
			metadataSource
		});
	});
});

describe('publishedSubjects', () => {
	const builtSubject: BuildSubjectV3Input = {
		origin: 'built',
		storePath: appPath,
		narHash: narHash.digestHex(),
		derivation: appDrv,
		buildStore,
		verification: 'build-store'
	};

	it.each([
		{
			name: 'a path whose store metadata marks it as ultimate',
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
			name: 'a store-held path without a deriver',
			pathInfo: info(appPath, { ultimate: true }),
			expected: {
				origin: 'store-held',
				storePath: appPath,
				narHash: narHash.digestHex(),
				buildStore
			}
		},
		{
			name: 'a copied path with store-held signatures',
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
			name: 'a copied path without a store-held signature',
			pathInfo: info(appPath),
			expected: {
				origin: 'copied',
				storePath: appPath,
				narHash: narHash.digestHex(),
				signatures: []
			}
		},
		{
			name: 'a content-addressed copied path',
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

	it('records copy sources observed during the run', () => {
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

	it('excludes a copied path that the run did not publish', () => {
		expect(
			subjectsFor([info(appPath)], {
				servable: new Set(),
				copiedFrom: new Map([[appPath, [firstCache]]])
			})
		).toStrictEqual([]);
	});

	it('preserves build attribution over later store metadata', () => {
		expect(
			subjectsFor([info(appPath, { ultimate: true, deriver: appDrv })], {
				described: new Map([[appPath, builtSubject]])
			})
		).toStrictEqual([builtSubject]);
	});

	it('returns one subject per published path in store-path order', () => {
		expect(
			subjectsFor(
				[
					info(libraryPath, { ultimate: true }),
					info(appPath, { ultimate: true, deriver: appDrv })
				],
				{ described: new Map([[appPath, builtSubject]]) }
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
