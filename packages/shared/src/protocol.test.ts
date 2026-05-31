import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
	CacheInfo,
	DeletePathRequest,
	fromNixBase32,
	InvalidNarInfoIntegerFieldError,
	InvalidNarInfoLineError,
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
	MissingNarInfoFieldError,
	NarInfo,
	type NarInfoFields,
	NixConfig,
	RootRemoveRequest,
	RootSetRequest,
	StorePath,
	StorePathHashMismatchError,
	UnsupportedNarInfoCompressionError,
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

describe('NarInfo', () => {
	it('round-trips through the text format', () => {
		const info = new NarInfo(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example',
			'nar/sha256:0123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk.nar.zst',
			'zstd',
			'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			123,
			'sha256:2123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			456,
			['0123456789abcdfghijklmnpqrsvwxyz-ref'],
			undefined,
			undefined,
			'cupboard-1:signature'
		);

		expect(NarInfo.parse(info.render()).toFields()).toStrictEqual(
			info.toFields()
		);
	});

	it('builds the Nix signing fingerprint', () => {
		const info = new NarInfo(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example',
			'nar/sha256:0123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk.nar.zst',
			'zstd',
			'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			123,
			'sha256:2123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			456,
			[
				'0123456789abcdfghijklmnpqrsvwxyz-first',
				'1123456789abcdfghijklmnpqrsvwxyz-second'
			]
		);

		expect(info.fingerprint()).toBe(
			'1;/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example;sha256:2123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk;456;/nix/store/0123456789abcdfghijklmnpqrsvwxyz-first,/nix/store/1123456789abcdfghijklmnpqrsvwxyz-second'
		);
	});

	it('rejects malformed narinfo lines with a typed error', () => {
		expect(() => NarInfo.parse('StorePath /nix/store/example\n')).toThrow(
			InvalidNarInfoLineError
		);
	});

	it('rejects missing required narinfo fields with a typed error', () => {
		expect(() => NarInfo.parse('StorePath: /nix/store/example\n')).toThrow(
			MissingNarInfoFieldError
		);
	});

	it('rejects unsupported narinfo compression with a typed error', () => {
		expect(() =>
			NarInfo.parse(
				[
					'StorePath: /nix/store/0123456789abcdfghijklmnpqrsvwxyz-example',
					'URL: nar/example.nar.xz',
					'Compression: xz',
					'FileHash: sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
					'FileSize: 123',
					'NarHash: sha256:2123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
					'NarSize: 456',
					'References: ',
					''
				].join('\n')
			)
		).toThrow(UnsupportedNarInfoCompressionError);
	});

	it('rejects invalid narinfo integer fields with a typed error', () => {
		expect(() =>
			NarInfo.parse(
				[
					'StorePath: /nix/store/0123456789abcdfghijklmnpqrsvwxyz-example',
					'URL: nar/example.nar.zst',
					'Compression: zstd',
					'FileHash: sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
					'FileSize: nope',
					'NarHash: sha256:2123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
					'NarSize: 456',
					'References: ',
					''
				].join('\n')
			)
		).toThrow(InvalidNarInfoIntegerFieldError);
	});

	it('round-trips generated valid narinfos through the text format', () => {
		fc.assert(
			fc.property(narInfoFieldsArbitrary, (fields) => {
				const info = NarInfo.fromFields(fields);

				expect(NarInfo.parse(info.render()).toFields()).toStrictEqual(
					info.toFields()
				);
			}),
			{ numRuns: 100 }
		);
	});

	it('parses generated narinfos with reordered fields and blank lines', () => {
		fc.assert(
			fc.property(
				narInfoFieldsArbitrary,
				narInfoFieldOrderArbitrary,
				fc.array(fc.constant(''), { maxLength: 3 }),
				(fields, order, blankLines) => {
					const source = [
						...blankLines,
						...narInfoLines(fields, order),
						...blankLines
					].join('\n');
					const expected = NarInfo.fromFields(fields).toFields();

					expect(NarInfo.parse(source).toFields()).toStrictEqual(expected);
				}
			),
			{ numRuns: 100 }
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

type CharacterSet = readonly [string, ...string[]];

const nixBase32Characters = [
	'0',
	'1',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
	'a',
	'b',
	'c',
	'd',
	'f',
	'g',
	'h',
	'i',
	'j',
	'k',
	'l',
	'm',
	'n',
	'p',
	'q',
	'r',
	's',
	'v',
	'w',
	'x',
	'y',
	'z'
] as const satisfies CharacterSet;

const safeNameCharacters = [
	'a',
	'b',
	'c',
	'd',
	'e',
	'f',
	'g',
	'h',
	'i',
	'j',
	'k',
	'l',
	'm',
	'n',
	'o',
	'p',
	'q',
	'r',
	's',
	't',
	'u',
	'v',
	'w',
	'x',
	'y',
	'z',
	'0',
	'1',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
	'-',
	'_',
	'.',
	'+'
] as const satisfies CharacterSet;

const storePathHashArbitrary = fixedCharacters(nixBase32Characters, 32);
const nixSha256HashArbitrary = fixedCharacters(nixBase32Characters, 52).map(
	(value) => `sha256:${value}`
);
const safeNameArbitrary = fc
	.array(fc.constantFrom(...safeNameCharacters), {
		minLength: 1,
		maxLength: 24
	})
	.map((characters) => characters.join(''));
const storePathBasenameArbitrary = fc
	.tuple(storePathHashArbitrary, safeNameArbitrary)
	.map(([hash, name]) => `${hash}-${name}`);
const storePathArbitrary = storePathBasenameArbitrary.map(
	(basename) => `/nix/store/${basename}`
);
const namedBytesArbitrary = fc
	.tuple(safeNameArbitrary, safeNameArbitrary)
	.map(([name, value]) => `${name}:${value}`);
const narInfoFieldsArbitrary: fc.Arbitrary<NarInfoFields> = fc.record({
	storePath: storePathArbitrary,
	url: fc
		.tuple(nixSha256HashArbitrary, safeNameArbitrary)
		.map(([hash, extension]) => `nar/${hash}.nar.${extension}`),
	compression: fc.constant('zstd'),
	fileHash: nixSha256HashArbitrary,
	fileSize: fc.integer({ min: 0, max: 1_000_000_000 }),
	narHash: nixSha256HashArbitrary,
	narSize: fc.integer({ min: 0, max: 1_000_000_000 }),
	references: fc.uniqueArray(storePathBasenameArbitrary, {
		maxLength: 8
	}),
	deriver: fc.option(storePathArbitrary, { nil: undefined }),
	ca: fc.option(namedBytesArbitrary, { nil: undefined }),
	sig: fc.option(namedBytesArbitrary, { nil: undefined })
});
const narInfoFieldOrderArbitrary = fc.constantFrom(
	[
		'StorePath',
		'URL',
		'Compression',
		'FileHash',
		'FileSize',
		'NarHash',
		'NarSize',
		'References',
		'Deriver',
		'CA',
		'Sig'
	],
	[
		'Sig',
		'CA',
		'Deriver',
		'References',
		'NarSize',
		'NarHash',
		'FileSize',
		'FileHash',
		'Compression',
		'URL',
		'StorePath'
	],
	[
		'NarHash',
		'StorePath',
		'References',
		'URL',
		'FileHash',
		'Compression',
		'Sig',
		'NarSize',
		'CA',
		'FileSize',
		'Deriver'
	]
);

function fixedCharacters(
	characters: CharacterSet,
	length: number
): fc.Arbitrary<string> {
	return fc
		.array(fc.constantFrom(...characters), {
			minLength: length,
			maxLength: length
		})
		.map((value) => value.join(''));
}

function narInfoLines(
	fields: NarInfoFields,
	order: readonly string[]
): readonly string[] {
	const byField = new Map<string, string | undefined>([
		['StorePath', fields.storePath],
		['URL', fields.url],
		['Compression', fields.compression],
		['FileHash', fields.fileHash],
		['FileSize', String(fields.fileSize)],
		['NarHash', fields.narHash],
		['NarSize', String(fields.narSize)],
		['References', fields.references.join(' ')],
		['Deriver', fields.deriver],
		['CA', fields.ca],
		['Sig', fields.sig]
	]);
	const lines: string[] = [];

	for (const field of order) {
		const value = byField.get(field);

		if (value === undefined) {
			continue;
		}

		lines.push(`${field}: ${value}`);
	}

	return lines;
}
