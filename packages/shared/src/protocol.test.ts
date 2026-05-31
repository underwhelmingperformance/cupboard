import { describe, expect, it } from 'vitest';

import {
	CacheInfo,
	DeletePathRequest,
	fromNixBase32,
	InvalidNixSha256HashError,
	InvalidRootNameError,
	InvalidRootTargetsError,
	InvalidRootTtlError,
	InvalidStorePathError,
	InvalidStorePathHashError,
	InvalidStorePathReferenceError,
	InvalidUploadPathMetadataFileHashError,
	InvalidUploadPathMetadataFileSizeError,
	InvalidUploadPathMetadataNarHashError,
	InvalidUploadPathMetadataNarSizeError,
	NixConfig,
	RootRemoveRequest,
	RootSetRequest,
	StorePath,
	StorePathHashMismatchError,
	UploadBlobMetadata,
	UploadPathCommitMetadata,
	UploadPathMetadata
} from './protocol.ts';
import { rootTtlMaxSeconds } from './scalars.ts';

describe('CacheInfo', () => {
	it('renders nix-cache-info', () => {
		expect(CacheInfo.default.render()).toBe(
			['StoreDir: /nix/store', 'WantMassQuery: 1', 'Priority: 40', ''].join(
				'\n'
			)
		);
	});
});

describe('StorePath', () => {
	it('extracts the basename and store path hash', () => {
		const storePath = new StorePath(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example'
		);

		expect({
			basename: storePath.basename,
			hash: storePath.hash
		}).toStrictEqual({
			basename: '0123456789abcdfghijklmnpqrsvwxyz-example',
			hash: '0123456789abcdfghijklmnpqrsvwxyz'
		});
	});

	it('rejects invalid store paths with a typed error', () => {
		expect(() => new StorePath('/tmp/example')).toThrow(InvalidStorePathError);
	});
});

describe('fromNixBase32', () => {
	it.each([
		{ name: 'an out-of-alphabet character', value: 'e'.repeat(52) },
		{ name: 'an empty string', value: '' },
		{ name: 'a too-short input', value: '1'.repeat(51) },
		{ name: 'a too-long input', value: '1'.repeat(53) }
	])('rejects $name', ({ value }) => {
		expect(() => fromNixBase32(value)).toThrow(InvalidNixSha256HashError);
	});
});

describe('DeletePathRequest', () => {
	it('accepts a valid store path hash', () => {
		expect(
			DeletePathRequest.fromFields({
				storePathHash: '0123456789abcdfghijklmnpqrsvwxyz'
			}).toFields()
		).toStrictEqual({ storePathHash: '0123456789abcdfghijklmnpqrsvwxyz' });
	});

	it.each([
		{
			storePathHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
			why: 'invalid alphabet'
		},
		{ storePathHash: '0123456789abcdfghijklmnpqrsvwxy', why: 'too short' },
		{ storePathHash: '0123456789abcdfghijklmnpqrsvwxyzz', why: 'too long' },
		{ storePathHash: '0123456789ABCDFGHIJKLMNPQRSVWXYZ', why: 'uppercase' },
		{ storePathHash: '', why: 'empty' }
	])('rejects a $why hash with a typed error', ({ storePathHash }) => {
		expect(() => DeletePathRequest.fromFields({ storePathHash })).toThrow(
			InvalidStorePathHashError
		);
	});
});

describe('RootSetRequest', () => {
	const target = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';

	it('accepts a name, targets, and ttl, round-tripping fields', () => {
		expect(
			RootSetRequest.fromFields({
				name: 'github:owner/repo/main',
				targets: [target],
				ttlSeconds: 604_800
			}).toFields()
		).toStrictEqual({
			name: 'github:owner/repo/main',
			targets: [target],
			ttlSeconds: 604_800
		});
	});

	it('omits ttlSeconds when none is given', () => {
		expect(
			RootSetRequest.fromFields({ name: 'main', targets: [target] }).toFields()
		).toStrictEqual({ name: 'main', targets: [target] });
	});

	it('deduplicates targets that resolve to the same hash', () => {
		expect(
			RootSetRequest.fromFields({
				name: 'main',
				targets: [target, target]
			}).toFields()
		).toStrictEqual({ name: 'main', targets: [target] });
	});

	it.each([
		{ fields: { name: '', targets: [target] }, error: InvalidRootNameError },
		{
			fields: { name: 'a'.repeat(257), targets: [target] },
			error: InvalidRootNameError
		},
		{
			fields: { name: 'a\tb', targets: [target] },
			error: InvalidRootNameError
		},
		{ fields: { name: 'main', targets: [] }, error: InvalidRootTargetsError },
		{
			fields: { name: 'main', targets: ['/tmp/not-a-store-path'] },
			error: InvalidStorePathError
		},
		{
			fields: { name: 'main', targets: [target], ttlSeconds: 0 },
			error: InvalidRootTtlError
		},
		{
			fields: { name: 'main', targets: [target], ttlSeconds: 1.5 },
			error: InvalidRootTtlError
		},
		{
			fields: {
				name: 'main',
				targets: [target],
				ttlSeconds: rootTtlMaxSeconds + 1
			},
			error: InvalidRootTtlError
		}
	])('rejects invalid fields with $error.name', ({ fields, error }) => {
		expect(() => RootSetRequest.fromFields(fields)).toThrow(error);
	});
});

describe('RootRemoveRequest', () => {
	it('accepts a valid name', () => {
		expect(
			RootRemoveRequest.fromFields({ name: 'pr-123' }).toFields()
		).toStrictEqual({ name: 'pr-123' });
	});

	it('rejects an empty name with a typed error', () => {
		expect(() => RootRemoveRequest.fromFields({ name: '' })).toThrow(
			InvalidRootNameError
		);
	});
});

describe('UploadPathMetadata', () => {
	it('rejects invalid store path hashes with a typed error', () => {
		expect(() =>
			UploadPathMetadata.fromFields({
				...validUploadPathMetadataFields(),
				storePathHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
			})
		).toThrow(InvalidStorePathHashError);
	});

	it('rejects mismatched store path hashes with a typed error', () => {
		expect(() =>
			UploadPathMetadata.fromFields({
				...validUploadPathMetadataFields(),
				storePathHash: '1123456789abcdfghijklmnpqrsvwxyz'
			})
		).toThrow(StorePathHashMismatchError);
	});

	it('rejects invalid NAR hashes with a typed error', () => {
		expect(() =>
			UploadPathMetadata.fromFields({
				...validUploadPathMetadataFields(),
				narHash: 'sha256:not-a-valid-hash'
			})
		).toThrow(InvalidUploadPathMetadataNarHashError);
	});

	it('rejects invalid file hashes with a typed error', () => {
		expect(() =>
			UploadBlobMetadata.fromFields({
				...validUploadBlobMetadataFields(),
				fileHash: 'sha256:not-a-valid-hash'
			})
		).toThrow(InvalidUploadPathMetadataFileHashError);
	});

	it('rejects invalid NAR sizes with a typed error', () => {
		expect(() =>
			UploadPathMetadata.fromFields({
				...validUploadPathMetadataFields(),
				narSize: 0
			})
		).toThrow(InvalidUploadPathMetadataNarSizeError);
	});

	it('rejects invalid file sizes with a typed error', () => {
		expect(() =>
			UploadBlobMetadata.fromFields({
				...validUploadBlobMetadataFields(),
				fileSize: 0
			})
		).toThrow(InvalidUploadPathMetadataFileSizeError);
	});

	it('rejects full store path references with a typed error', () => {
		expect(() =>
			UploadPathMetadata.fromFields({
				...validUploadPathMetadataFields(),
				references: ['/nix/store/1123456789abcdfghijklmnpqrsvwxyz-ref']
			})
		).toThrow(InvalidStorePathReferenceError);
	});

	it('combines path identity and blob metadata for commit', () => {
		const fields = validUploadPathMetadataFields();
		const metadata = UploadPathCommitMetadata.fromPathAndBlob(
			UploadPathMetadata.fromFields(fields),
			UploadBlobMetadata.fromFields(fields)
		);

		expect(metadata.toFields()).toStrictEqual({
			...fields,
			deriver: undefined,
			ca: undefined
		});
	});
});

describe('NixConfig', () => {
	it('renders a nix.conf snippet', () => {
		expect(
			new NixConfig('https://cache.example', 'cupboard-1:key').render()
		).toBe(
			[
				'substituters = https://cache.example',
				'trusted-public-keys = cupboard-1:key',
				''
			].join('\n')
		);
	});
});

function validUploadPathMetadataFields() {
	return {
		storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
		storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example',
		narHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		narSize: 456,
		fileHash: 'sha256:2123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		fileSize: 123,
		compression: 'zstd' as const,
		references: ['1123456789abcdfghijklmnpqrsvwxyz-ref']
	};
}

function validUploadBlobMetadataFields() {
	return {
		fileHash: 'sha256:2123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		fileSize: 123,
		compression: 'zstd' as const
	};
}
