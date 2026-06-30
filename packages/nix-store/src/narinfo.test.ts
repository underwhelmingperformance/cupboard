import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { bytesToBase64 } from './encoding.ts';
import { MalformedNarInfoLineError } from './errors.ts';
import { toNixBase32 } from './hash.ts';
import {
	NarInfo,
	type NarInfoFields,
	narInfoSchema,
	parseFields,
	parseNarInfo,
	verifyNarInfoSignature
} from './narinfo.ts';
const exampleStorePath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example';

function fingerprintWithReferences(references: readonly string[]): string {
	return NarInfo.fromFields({
		storePath: exampleStorePath,
		url: 'nar/sha256:0123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk.nar.zst',
		compression: 'zstd',
		fileHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		fileSize: 123,
		narHash: 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		narSize: 456,
		references,
		sigs: []
	}).fingerprint();
}

function narInfoWith(overrides: Partial<NarInfoFields>): NarInfo {
	return NarInfo.fromFields({
		storePath: exampleStorePath,
		url: 'nar/example.nar.zst',
		compression: 'zstd',
		fileHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		fileSize: 123,
		narHash: 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		narSize: 456,
		references: [],
		sigs: [],
		...overrides
	});
}

async function signedNarInfo(): Promise<{
	narInfo: NarInfo;
	publicKey: string;
}> {
	const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
		'sign',
		'verify'
	])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
	const fingerprint = new TextEncoder().encode(narInfoWith({}).fingerprint());
	const signature = new Uint8Array(
		await crypto.subtle.sign('Ed25519', keyPair.privateKey, fingerprint)
	);
	const rawPublic = new Uint8Array(
		await crypto.subtle.exportKey('raw', keyPair.publicKey)
	);

	return {
		narInfo: narInfoWith({ sigs: [`k1:${bytesToBase64(signature)}`] }),
		publicKey: `k1:${bytesToBase64(rawPublic)}`
	};
}

describe('verifyNarInfoSignature', () => {
	it('accepts a signature made by a trusted key', async () => {
		const { narInfo, publicKey } = await signedNarInfo();

		expect(await verifyNarInfoSignature(narInfo, [publicKey])).toBe(true);
	});

	it('rejects a signature no trusted key matches', async () => {
		const { narInfo } = await signedNarInfo();
		const { publicKey: otherKey } = await signedNarInfo();

		expect(await verifyNarInfoSignature(narInfo, [otherKey])).toBe(false);
	});

	it('rejects an unsigned narinfo', async () => {
		const { publicKey } = await signedNarInfo();

		expect(
			await verifyNarInfoSignature(narInfoWith({ sigs: [] }), [publicKey])
		).toBe(false);
	});
});

function narinfoLines(
	overrides: { readonly fileSize?: string; readonly references?: string } = {}
): string[] {
	return [
		`StorePath: ${exampleStorePath}`,
		'URL: nar/example.nar.zst',
		'Compression: zstd',
		'FileHash: sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		`FileSize: ${overrides.fileSize ?? '123'}`,
		'NarHash: sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		'NarSize: 456',
		`References: ${overrides.references ?? ''}`,
		''
	];
}

describe('NarInfo', () => {
	it('round-trips through the text format', () => {
		const info = NarInfo.fromFields({
			storePath: exampleStorePath,
			url: 'nar/sha256:0123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk.nar.zst',
			compression: 'zstd',
			fileHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			fileSize: 123,
			narHash: 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			narSize: 456,
			references: ['0123456789abcdfghijklmnpqrsvwxyz-ref'],
			sigs: ['cupboard-1:signature']
		});

		expect(NarInfo.parse(info.render()).toFields()).toStrictEqual(
			info.toFields()
		);
	});

	it('builds the Nix signing fingerprint', () => {
		const info = NarInfo.fromFields({
			storePath: exampleStorePath,
			url: 'nar/sha256:0123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk.nar.zst',
			compression: 'zstd',
			fileHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			fileSize: 123,
			narHash: 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			narSize: 456,
			references: [
				'0123456789abcdfghijklmnpqrsvwxyz-first',
				'1123456789abcdfghijklmnpqrsvwxyz-second'
			],
			sigs: []
		});

		expect(info.fingerprint()).toBe(
			'1;/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example;sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk;456;/nix/store/0123456789abcdfghijklmnpqrsvwxyz-first,/nix/store/1123456789abcdfghijklmnpqrsvwxyz-second'
		);
	});

	it('sorts references in the fingerprint regardless of input order', () => {
		expect(
			fingerprintWithReferences([
				'1123456789abcdfghijklmnpqrsvwxyz-second',
				'0123456789abcdfghijklmnpqrsvwxyz-first'
			])
		).toBe(
			fingerprintWithReferences([
				'0123456789abcdfghijklmnpqrsvwxyz-first',
				'1123456789abcdfghijklmnpqrsvwxyz-second'
			])
		);
	});

	it('appends signatures without discarding existing ones', () => {
		const signed = NarInfo.fromFields({
			storePath: exampleStorePath,
			url: 'nar/example.nar.zst',
			compression: 'zstd',
			fileHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			fileSize: 123,
			narHash: 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			narSize: 456,
			references: [],
			sigs: []
		})
			.withSignature('cupboard-1:first')
			.withSignature('cupboard-2:second');

		expect(signed.sigs).toStrictEqual([
			'cupboard-1:first',
			'cupboard-2:second'
		]);
	});

	it('round-trips multiple signatures, one Sig line each', () => {
		const info = NarInfo.fromFields({
			storePath: exampleStorePath,
			url: 'nar/example.nar.zst',
			compression: 'zstd',
			fileHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			fileSize: 123,
			narHash: 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			narSize: 456,
			references: [],
			sigs: ['cupboard-1:first', 'cupboard-2:second']
		});
		const rendered = info.render();

		expect({
			sigLines: rendered.split('\n').filter((line) => line.startsWith('Sig: ')),
			parsedSigs: NarInfo.parse(rendered).sigs
		}).toStrictEqual({
			sigLines: ['Sig: cupboard-1:first', 'Sig: cupboard-2:second'],
			parsedSigs: ['cupboard-1:first', 'cupboard-2:second']
		});
	});

	it('rejects a narinfo line without a colon separator', () => {
		expect(() => parseNarInfo('StorePath /nix/store/example\n')).toThrow(
			MalformedNarInfoLineError
		);
	});

	it.each([
		{
			name: 'a missing required field',
			source: 'StorePath: /nix/store/x\n'
		},
		{
			name: 'an unsupported compression',
			source: narinfoLines()
				.map((line) =>
					line.startsWith('Compression:') ? 'Compression: xz' : line
				)
				.join('\n')
		},
		{
			name: 'an invalid store path',
			source: narinfoLines()
				.map((line) =>
					line.startsWith('StorePath:')
						? 'StorePath: /tmp/not-a-store-path'
						: line
				)
				.join('\n')
		},
		{
			name: 'a malformed NAR hash',
			source: narinfoLines()
				.map((line) =>
					line.startsWith('NarHash:') ? 'NarHash: sha256:not-a-hash' : line
				)
				.join('\n')
		},
		{
			name: 'a reference containing a slash',
			source: narinfoLines({
				references: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-a'
			}).join('\n')
		},
		{
			name: 'a reference containing a control character',
			source: narinfoLines({
				references: '0123456789abcdfghijklmnpqrsvwxyz-a\u{7}'
			}).join('\n')
		},
		{
			name: 'a deriver containing a control character',
			source: [...narinfoLines(), 'Deriver: bad\u{7}deriver'].join('\n')
		},
		{
			name: 'a CA containing a control character',
			source: [...narinfoLines(), 'CA: fixed:r:bad\u{7F}ca'].join('\n')
		},
		{
			name: 'a signature containing a control character',
			source: [...narinfoLines(), 'Sig: key:bad\u{7}sig'].join('\n')
		}
	])('rejects $name', ({ source }) => {
		expect(narInfoSchema.safeParse(parseFields(source)).success).toBe(false);
	});

	it.each([
		{
			name: 'store path',
			fields: { storePath: `${exampleStorePath}\nURL: injected` }
		},
		{
			name: 'reference',
			fields: {
				references: ['0123456789abcdfghijklmnpqrsvwxyz-a\nBad: x']
			}
		},
		{
			name: 'deriver',
			fields: { deriver: 'bad\nderiver' }
		},
		{
			name: 'CA',
			fields: { ca: 'fixed:r:bad\u{7}ca' }
		},
		{
			name: 'signature',
			fields: { sigs: ['key:bad\nsig'] }
		}
	])('rejects line injection while rendering $name', ({ fields }) => {
		expect(() => narInfoWith(fields).render()).toThrow(z.ZodError);
	});

	it.each([
		{ fileSize: 'nope' },
		{ fileSize: '123abc' },
		{ fileSize: '1e9' },
		{ fileSize: '+5' },
		{ fileSize: '0x1f' },
		{ fileSize: '' }
	])('rejects the non-integer file size %j', ({ fileSize }) => {
		const source = narinfoLines({ fileSize }).join('\n');
		expect(narInfoSchema.safeParse(parseFields(source)).success).toBe(false);
	});

	it('parses CRLF line endings without a trailing carriage return', () => {
		const info = parseNarInfo(narinfoLines().join('\r\n'));

		expect(info.storePath.value).toBe(exampleStorePath);
	});

	it('collapses runs of whitespace between references', () => {
		const info = parseNarInfo(
			narinfoLines({
				references:
					'0123456789abcdfghijklmnpqrsvwxyz-a   1123456789abcdfghijklmnpqrsvwxyz-b'
			}).join('\n')
		);

		expect(info.references).toStrictEqual([
			'0123456789abcdfghijklmnpqrsvwxyz-a',
			'1123456789abcdfghijklmnpqrsvwxyz-b'
		]);
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
		const blankLinesArbitrary = fc.array(fc.constant(''), { maxLength: 3 });
		fc.assert(
			fc.property(
				narInfoFieldsArbitrary,
				narInfoFieldOrderArbitrary,
				blankLinesArbitrary,
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

const storePathHashArbitrary = fixedCharacters(nixBase32Characters, 32);
// A SHA-256 digest is 32 bytes, so a canonical Nix base32 hash comes from those
// bytes: generating the 52 characters freely would set the top digit's overflow
// bits that no real digest carries.
const nixSha256HashArbitrary = fc
	.uint8Array({ minLength: 32, maxLength: 32 })
	.map((bytes) => `sha256:${toNixBase32(bytes)}`);
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
	sigs: fc.array(namedBytesArbitrary, { maxLength: 3 })
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

function narInfoLines(
	fields: NarInfoFields,
	order: readonly string[]
): readonly string[] {
	const byField = new Map<string, readonly string[]>([
		['StorePath', [fields.storePath]],
		['URL', [fields.url]],
		['Compression', [fields.compression]],
		['FileHash', [fields.fileHash]],
		['FileSize', [String(fields.fileSize)]],
		['NarHash', [fields.narHash]],
		['NarSize', [String(fields.narSize)]],
		['References', [fields.references.join(' ')]],
		['Deriver', fields.deriver === undefined ? [] : [fields.deriver]],
		['CA', fields.ca === undefined ? [] : [fields.ca]],
		['Sig', fields.sigs]
	]);
	const lines: string[] = [];

	for (const field of order) {
		const values = byField.get(field) ?? [];
		for (const value of values) {
			lines.push(`${field}: ${value}`);
		}
	}

	return lines;
}
