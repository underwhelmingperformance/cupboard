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
	parseNarInfo
} from './narinfo.ts';
import { canonicalNixSignature } from './signature.ts';
import { byCodeUnit } from './store-path.ts';
const exampleStorePath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example';
const exampleSignature = `cupboard-1:${bytesToBase64(new Uint8Array(64).fill(1))}`;
const secondSignature = `cupboard-2:${bytesToBase64(new Uint8Array(64).fill(2))}`;
const exampleContentAddress =
	'fixed:r:sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk';
const exampleReference = '0123456789abcdfghijklmnpqrsvwxyz-ref';
const exampleDeriver = '2123456789abcdfghijklmnpqrsvwxyz-example.drv';

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

function narinfoLines(
	overrides: {
		readonly fileSize?: string;
		readonly narSize?: string;
		readonly references?: string;
		readonly url?: string;
	} = {}
): string[] {
	return [
		`StorePath: ${exampleStorePath}`,
		`URL: ${overrides.url ?? 'nar/example.nar.zst'}`,
		'Compression: zstd',
		'FileHash: sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		`FileSize: ${overrides.fileSize ?? '123'}`,
		'NarHash: sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		`NarSize: ${overrides.narSize ?? '456'}`,
		`References: ${overrides.references ?? ''}`,
		''
	];
}

const hiddenFieldValues: readonly (readonly [string, string])[] = [
	['CA', exampleContentAddress],
	['Deriver', exampleDeriver],
	['Sig', exampleSignature],
	['References', exampleReference]
];

function narinfoWith(...extraLines: readonly string[]): string {
	return [...narinfoLines().slice(0, -1), ...extraLines, ''].join('\n');
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
			references: [exampleReference],
			sigs: [exampleSignature]
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

	// Nix prints the references as a set of paths, so a repeated reference
	// appears once. A stored row can repeat a reference, and the signature for it
	// must be one that Nix can verify.
	it('lists a repeated reference once in the fingerprint', () => {
		const first = '0123456789abcdfghijklmnpqrsvwxyz-first';
		const second = '1123456789abcdfghijklmnpqrsvwxyz-second';

		expect(fingerprintWithReferences([second, first, second, first])).toBe(
			`1;${exampleStorePath};sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk;456;/nix/store/${first},/nix/store/${second}`
		);
	});

	// Rows without a repeat must keep the fingerprint that was signed for them.
	it('keeps the fingerprint of distinct references unchanged', () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(storePathBasenameArbitrary, { maxLength: 8 }),
				(references) => {
					const sorted = references
						.map((reference) => `/nix/store/${reference}`)
						.toSorted(byCodeUnit);

					expect(fingerprintWithReferences(references)).toBe(
						`1;${exampleStorePath};sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk;456;${sorted.join(',')}`
					);
				}
			),
			{ numRuns: 100 }
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
			sigs: [exampleSignature, secondSignature]
		});
		const rendered = info.render();

		expect({
			sigLines: rendered.split('\n').filter((line) => line.startsWith('Sig: ')),
			parsedSigs: NarInfo.parse(rendered).sigs
		}).toStrictEqual({
			sigLines: [`Sig: ${exampleSignature}`, `Sig: ${secondSignature}`],
			parsedSigs: [exampleSignature, secondSignature]
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
			source: narinfoWith('Deriver: bad\u{7}deriver')
		},
		{
			name: 'a CA containing a control character',
			source: narinfoWith('CA: fixed:r:bad\u{7F}ca')
		},
		{
			name: 'a signature containing a control character',
			source: narinfoWith('Sig: key:bad\u{7}sig')
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

	// Nix ends a record at the first line feed, starts its value two bytes after
	// the colon and trims nothing. A line-based reader would otherwise find
	// fields that Nix does not see, or read a different value.
	it.each([
		{ name: 'a blank line', lines: ['', `CA: ${exampleContentAddress}`] },
		{
			name: 'a whitespace-only line',
			lines: [' '.repeat(3), `CA: ${exampleContentAddress}`]
		},
		...hiddenFieldValues.map(([field, value]) => ({
			name: `${field} after a field without a value`,
			lines: ['Junk:', `${field}: ${value}`]
		})),
		{ name: 'no space after a colon', lines: ['NarSize:15678'] },
		{ name: 'a tab after a colon', lines: ['Unknown:\tvalue'] },
		{ name: 'a line without a colon', lines: ['no colon here'] }
	])('refuses a narinfo with $name', ({ lines }) => {
		expect(() => parseNarInfo(narinfoWith(...lines))).toThrow(
			MalformedNarInfoLineError
		);
	});

	it.each([
		{
			name: 'no final newline',
			source: narinfoWith().slice(0, -1)
		},
		{ name: 'an unterminated record', source: `${narinfoWith()}Junk` }
	])('refuses a narinfo with $name', ({ source }) => {
		expect(() => parseNarInfo(source)).toThrow(MalformedNarInfoLineError);
	});

	it.each([
		{
			// Nix reads the mark as part of the first field name, which is then
			// `StorePath` with a prefix, so it finds no `StorePath`.
			name: 'a leading byte order mark',
			source: `\u{FEFF}${narinfoWith()}`
		},
		{
			name: 'CRLF line endings',
			source: narinfoWith().replaceAll('\n', '\r\n')
		},
		{
			name: 'trailing whitespace in a content address',
			source: narinfoWith(`CA: ${exampleContentAddress} `)
		},
		{
			name: 'trailing whitespace in a signature',
			source: narinfoWith(`Sig: ${exampleSignature} `)
		},
		{
			name: 'a NarSize of zero',
			source: narinfoLines({ narSize: '0' }).join('\n')
		},
		{ name: 'an empty URL', source: narinfoLines({ url: '' }).join('\n') },
		{
			name: 'references separated by a tab',
			source: narinfoLines({
				references: `${exampleReference}\t1123456789abcdfghijklmnpqrsvwxyz-b`
			}).join('\n')
		},
		{
			name: 'a malformed content address',
			source: narinfoWith('CA: not-a-content-address')
		},
		{
			name: 'a malformed signature',
			source: narinfoWith('Sig: not-a-signature')
		},
		{ name: 'an empty deriver', source: narinfoWith('Deriver: ') },
		{
			name: 'a deriver that is a full path',
			source: narinfoWith(`Deriver: /nix/store/${exampleDeriver}`)
		}
	])('refuses a narinfo with $name', ({ source }) => {
		expect(() => parseNarInfo(source)).toThrow(z.ZodError);
	});

	// Nix reads the references into a set, so a repeated reference counts once
	// and the references come in the set's order.
	it('reads the references as a set', () => {
		const first = '0123456789abcdfghijklmnpqrsvwxyz-a';
		const second = '1123456789abcdfghijklmnpqrsvwxyz-b';
		const source = narinfoLines({
			references: `${second} ${first} ${second}`
		}).join('\n');

		expect(NarInfo.parse(source).toFields()).toStrictEqual(
			narInfoWith({ references: [first, second] }).toFields()
		);
	});

	// A row stored under earlier rules can repeat a reference or have a `CA`,
	// `Deriver` or `Sig` that Nix rejects. The server must still read it.
	it('reads a stored narinfo that input rules refuse', () => {
		const source = [
			...narinfoLines({
				references: `${exampleReference} ${exampleReference}`
			}).slice(0, -1),
			'Deriver: nope',
			'CA: not-a-content-address',
			'Sig: padding',
			''
		].join('\n');

		expect(() => parseNarInfo(source)).toThrow(z.ZodError);
		expect(NarInfo.parseStored(source).toFields()).toStrictEqual({
			storePath: exampleStorePath,
			url: 'nar/example.nar.zst',
			compression: 'zstd',
			fileHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			fileSize: 123,
			narHash: 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			narSize: 456,
			references: [exampleReference, exampleReference],
			deriver: 'nope',
			ca: 'not-a-content-address',
			sigs: ['padding']
		});
	});

	// Nix compares the key name and the decoded signature, and prints the
	// signature with padding.
	it('reads signatures that differ only in padding as one signature', () => {
		const unpadded = exampleSignature.replace(/=+$/u, '');
		const info = parseNarInfo(
			narinfoWith(`Sig: ${unpadded}`, `Sig: ${exampleSignature}`)
		);

		expect(info.toFields()).toStrictEqual(
			narInfoWith({ sigs: [exampleSignature] }).toFields()
		);
	});

	it('reads a signature that is listed twice once', () => {
		const info = parseNarInfo(
			narinfoWith(
				`Sig: ${exampleSignature}`,
				`Sig: ${secondSignature}`,
				`Sig: ${exampleSignature}`
			)
		);

		expect(info.toFields()).toStrictEqual(
			narInfoWith({ sigs: [exampleSignature, secondSignature] }).toFields()
		);
	});

	it('reads the optional fields that Nix reads', () => {
		const info = parseNarInfo(
			narinfoWith(
				`Deriver: ${exampleDeriver}`,
				`CA: ${exampleContentAddress}`,
				`Sig: ${exampleSignature}`,
				`Sig: ${secondSignature}`,
				'Unknown: ignored'
			)
		);

		expect(info.toFields()).toStrictEqual({
			storePath: exampleStorePath,
			url: 'nar/example.nar.zst',
			compression: 'zstd',
			fileHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			fileSize: 123,
			narHash: 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
			narSize: 456,
			references: [],
			deriver: exampleDeriver,
			ca: exampleContentAddress,
			sigs: [exampleSignature, secondSignature]
		});
	});

	// Nix ignores a field that it does not know, whatever its name, so a cache
	// can add its own fields.
	it.each(['X-Foo', 'Unknown2', 'lowercase', 'with space', '_'])(
		'ignores an unknown field named %j',
		(name) => {
			expect(parseNarInfo(narinfoWith(`${name}: 1`)).toFields()).toStrictEqual(
				parseNarInfo(narinfoWith()).toFields()
			);
		}
	);

	it.each([
		{ name: 'an unknown deriver', line: 'Deriver: unknown-deriver' },
		{ name: 'an empty content address', line: 'CA: ' }
	])('reads $name as an absent field', ({ line }) => {
		const info = parseNarInfo(narinfoWith(line));

		expect({ deriver: info.deriver, ca: info.ca }).toStrictEqual({
			deriver: undefined,
			ca: undefined
		});
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

	it('parses generated narinfos with reordered fields', () => {
		fc.assert(
			fc.property(
				narInfoFieldsArbitrary,
				narInfoFieldOrderArbitrary,
				(fields, order) => {
					const source = `${narInfoLines(fields, order).join('\n')}\n`;
					const expected = NarInfo.fromFields(fields).toFields();

					expect(NarInfo.parse(source).toFields()).toStrictEqual(expected);
				}
			),
			{ numRuns: 100 }
		);
	});

	it('refuses a generated narinfo with a blank line anywhere', () => {
		fc.assert(
			fc.property(
				narInfoFieldsArbitrary,
				narInfoFieldOrderArbitrary,
				fc.nat(),
				(fields, order, position) => {
					const lines = [...narInfoLines(fields, order)];
					lines.splice(position % (lines.length + 1), 0, '');

					expect(() => NarInfo.parse(`${lines.join('\n')}\n`)).toThrow(
						MalformedNarInfoLineError
					);
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
const contentAddressArbitrary = nixSha256HashArbitrary.map(
	(hash) => `fixed:r:${hash}`
);
const signatureArbitrary = fc
	.tuple(safeNameArbitrary, fc.uint8Array({ minLength: 1, maxLength: 64 }))
	.map(([name, bytes]) => `${name}:${bytesToBase64(bytes)}`);
const narInfoFieldsArbitrary: fc.Arbitrary<NarInfoFields> = fc.record({
	storePath: storePathArbitrary,
	url: fc
		.tuple(nixSha256HashArbitrary, safeNameArbitrary)
		.map(([hash, extension]) => `nar/${hash}.nar.${extension}`),
	compression: fc.constant('zstd'),
	fileHash: nixSha256HashArbitrary,
	fileSize: fc.integer({ min: 0, max: 1_000_000_000 }),
	narHash: nixSha256HashArbitrary,
	narSize: fc.integer({ min: 1, max: 1_000_000_000 }),
	// `parseNarInfo` returns the references in the order of Nix's set.
	references: fc
		.uniqueArray(storePathBasenameArbitrary, { maxLength: 8 })
		.map((references) => references.toSorted(byCodeUnit)),
	deriver: fc.option(storePathBasenameArbitrary, { nil: undefined }),
	ca: fc.option(contentAddressArbitrary, { nil: undefined }),
	// `parseNarInfo` folds signatures with the same key name and decoded
	// signature, so the generated ones must differ in that sense. Distinct
	// strings are not enough, because padding does not change a signature.
	sigs: fc.uniqueArray(signatureArbitrary, {
		maxLength: 3,
		selector: (signature) => canonicalNixSignature(signature)
	})
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
