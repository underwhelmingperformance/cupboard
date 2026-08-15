import { describe, expect, it } from 'vitest';

import { bytesToBase64, bytesToHex } from './encoding.ts';
import { CorruptNarInfoError, MismatchedNarInfoPathError } from './errors.ts';
import { NixSha256Hash, toNixBase32 } from './hash.ts';
import { offerFromNarInfo } from './narinfo-reader.ts';
import {
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from './scalars.ts';

const storeDirectory = storeDirectorySchema.parse('/nix/store');
const appPath = storePathSchema.parse(
	'/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app'
);
const libraryPath = storePathSchema.parse(
	'/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-library'
);
const deriverPath = storePathSchema.parse(
	'/nix/store/cccccccccccccccccccccccccccccccc-app.drv'
);

const narDigest = Uint8Array.from({ length: 32 }, (_, index) => index * 7);
const fileDigest = Uint8Array.from({ length: 32 }, (_, index) => index * 3);
const narHash = NixSha256Hash.fromDigest(narDigest);
const signature = `cache.example.org-1:${bytesToBase64(new Uint8Array(64).fill(9))}`;

/** The fields a cache serves, in the order and spellings Nix writes them. */
const wellFormedFields: readonly (readonly [string, string])[] = [
	['StorePath', appPath],
	['URL', 'nar/example.nar.xz'],
	['Compression', 'xz'],
	['FileHash', `sha256:${toNixBase32(fileDigest)}`],
	['FileSize', '400'],
	['NarHash', `sha256:${toNixBase32(narDigest)}`],
	['NarSize', '1000'],
	['References', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-library'],
	['Deriver', 'cccccccccccccccccccccccccccccccc-app.drv'],
	['Sig', signature]
];

/** One document to read, stated as what it changes about a well-formed one. */
interface NarInfoFixture {
	/** Values replacing the well-formed ones, keyed by field name. */
	readonly fields?: Readonly<Record<string, string | undefined>>;
	/** Whole lines written after the document, for a field written twice. */
	readonly extraLines?: readonly string[];
	/** Whether the last line ends the way Nix requires it to. */
	readonly endsWithNewline?: boolean;
}

const wellFormedValues = new Map(wellFormedFields);

// A field the well-formed document does not carry is written after it, so a
// fixture can state one Nix reads only when it is there.
function narInfoDocument(fixture: NarInfoFixture): string {
	const changed = fixture.fields ?? {};
	const names = [
		...wellFormedValues.keys(),
		...Object.keys(changed).filter((name) => !wellFormedValues.has(name))
	];
	const lines = names.flatMap((name) => {
		const value = Object.hasOwn(changed, name)
			? changed[name]
			: wellFormedValues.get(name);

		return value === undefined ? [] : [`${name}: ${value}`];
	});
	const document = [...lines, ...(fixture.extraLines ?? [])].join('\n');

	return fixture.endsWithNewline === false ? document : `${document}\n`;
}

function read(fixture: NarInfoFixture, storePath: StorePathString = appPath) {
	return offerFromNarInfo(narInfoDocument(fixture), storePath, storeDirectory);
}

describe('offerFromNarInfo', () => {
	it('reads what the document offers for the path it describes', () => {
		expect(read({})).toStrictEqual({
			source: 'substituter',
			references: [libraryPath],
			deriver: deriverPath,
			narHash,
			signatures: [signature],
			downloadSize: 400,
			narSize: 1000
		});
	});

	// Nix reads a document naming the deriver and the references by basename
	// into the store it is asking about.
	it('names the deriver and the references the way the store does', () => {
		const offer = read({
			fields: {
				References:
					'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-library aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app'
			}
		});

		expect({
			references: offer.references,
			deriver: offer.deriver
		}).toStrictEqual({
			references: [libraryPath, appPath],
			deriver: deriverPath
		});
	});

	// The literal a cache serves for a path whose deriver it does not know.
	it('reads the `unknown-deriver` value as no deriver', () => {
		expect(read({ fields: { Deriver: 'unknown-deriver' } })).toStrictEqual({
			source: 'substituter',
			references: [libraryPath],
			narHash,
			signatures: [signature],
			downloadSize: 400,
			narSize: 1000
		});
	});

	it.each([
		{ name: 'no Compression', fields: { Compression: undefined } },
		{ name: 'an empty Compression', fields: { Compression: '' } },
		{ name: 'no FileHash', fields: { FileHash: undefined } },
		{ name: 'no FileSize', fields: { FileSize: undefined } },
		{ name: 'no References', fields: { References: undefined } },
		{ name: 'no Deriver', fields: { Deriver: undefined } },
		{ name: 'no Sig', fields: { Sig: undefined } },
		{ name: 'a field it does not know', fields: { Unknown: 'whatever' } },
		{ name: 'an empty content address', fields: { CA: '' } }
	])('reads a document carrying $name', ({ fields }) => {
		expect(() => read({ fields })).not.toThrow();
	});

	// Nix reads a document missing any of these as one the substituter did not
	// finish writing.
	it.each([
		{ name: 'no StorePath', fields: { StorePath: undefined } },
		{ name: 'no URL', fields: { URL: undefined } },
		{ name: 'an empty URL', fields: { URL: '' } },
		{ name: 'no NarHash', fields: { NarHash: undefined } },
		{ name: 'no NarSize', fields: { NarSize: undefined } },
		{ name: 'a NarSize of zero', fields: { NarSize: '0' } }
	])('refuses a document carrying $name', ({ fields }) => {
		expect(() => read({ fields })).toThrow(CorruptNarInfoError);
	});

	it('refuses a document whose last line does not end', () => {
		expect(() => read({ endsWithNewline: false })).toThrow(CorruptNarInfoError);
	});

	// Nix reads a value from two characters past the colon, so a document
	// written without the space states a different value than it looks like.
	it('refuses a document written without the space after a colon', () => {
		const document = narInfoDocument({}).replace(
			'NarSize: 1000',
			'NarSize:1000'
		);

		expect(() => offerFromNarInfo(document, appPath, storeDirectory)).toThrow(
			CorruptNarInfoError
		);
	});

	it('refuses a line carrying no colon at all', () => {
		expect(() => read({ extraLines: ['no colon here'] })).toThrow(
			CorruptNarInfoError
		);
	});

	// The answer stands for the path it was asked about, and one naming another
	// path is reported as such: a substituter answering about something else
	// holds nothing for the path the caller asked after.
	it('reports a document describing another path as a mismatch', () => {
		expect(() => read({}, libraryPath)).toThrow(MismatchedNarInfoPathError);
	});

	it.each([
		{ name: 'lowercase base16', digest: bytesToHex(narDigest) },
		{ name: 'uppercase base16', digest: bytesToHex(narDigest).toUpperCase() },
		{ name: "nix's own base32", digest: toNixBase32(narDigest) },
		{ name: 'padded base64', digest: bytesToBase64(narDigest) }
	])('reads a NAR hash written in $name', ({ digest }) => {
		expect(
			read({ fields: { NarHash: `sha256:${digest}` } }).narHash
		).toStrictEqual(narHash);
	});

	// Nix reads a hash written the way a subresource integrity value is, with a
	// dash and base64, and takes it by the length it decodes to.
	it.each([
		{ name: 'padded', digest: bytesToBase64(narDigest) },
		{ name: 'unpadded', digest: bytesToBase64(narDigest).replace(/=+$/u, '') }
	])('reads a $name NAR hash in the integrity spelling', ({ digest }) => {
		expect(
			read({ fields: { NarHash: `sha256-${digest}` } }).narHash
		).toStrictEqual(narHash);
	});

	// A hash field states an algorithm and a digest that algorithm writes. Nix
	// decides the encoding by the digest's length and then decodes it, so a
	// digest of the right length in the wrong alphabet is one it cannot read.
	it.each([
		{ name: 'no algorithm at all', value: toNixBase32(narDigest) },
		{ name: 'an algorithm it does not know', value: `md4:${'a'.repeat(32)}` },
		{
			name: 'an algorithm behind an experimental feature',
			value: `blake3:${bytesToHex(narDigest)}`
		},
		{ name: 'an empty digest', value: 'sha256:' },
		{ name: 'a digest of no known length', value: `sha256:${'a'.repeat(50)}` },
		{
			name: 'a base16 digest outside its alphabet',
			value: `sha256:${'z'.repeat(64)}`
		},
		{
			name: 'a base32 digest outside its alphabet',
			value: `sha256:${'e'.repeat(52)}`
		},
		{
			name: 'a base64 digest outside its alphabet',
			value: `sha256:${'!'.repeat(44)}`
		},
		{
			name: 'a base32 digest whose top digit overflows the algorithm',
			value: `sha256:2${toNixBase32(narDigest).slice(1)}`
		},
		{
			name: 'an integrity digest decoding to another length',
			value: `sha256-${bytesToBase64(new Uint8Array(31))}`
		},
		{
			name: 'a digest of another algorithm than the one it names',
			value: `sha1:${bytesToHex(narDigest)}`
		}
	])('refuses a NAR hash carrying $name', ({ value }) => {
		expect(() => read({ fields: { NarHash: value } })).toThrow(
			CorruptNarInfoError
		);
	});

	// Nix reads the file hash through the same parser as the NAR hash, so a
	// document is refused over one the same way it is over the other.
	it.each([
		{
			name: 'a base16 digest outside its alphabet',
			value: `sha256:${'z'.repeat(64)}`
		},
		{
			name: 'a base32 digest outside its alphabet',
			value: `sha256:${'e'.repeat(52)}`
		},
		{ name: 'an algorithm it does not know', value: `md4:${'a'.repeat(32)}` }
	])('refuses a file hash carrying $name', ({ value }) => {
		expect(() => read({ fields: { FileHash: value } })).toThrow(
			CorruptNarInfoError
		);
	});

	// A NAR hash is kept only when it is sha256, the algorithm a store path's
	// own hash uses and so the only one an offer can be compared under.
	it.each([
		{ name: 'sha1', value: `sha1:${bytesToHex(narDigest.slice(0, 20))}` },
		{ name: 'sha512', value: `sha512:${bytesToHex(new Uint8Array(64))}` }
	])('refuses a NAR hash written under $name', ({ value }) => {
		expect(() => read({ fields: { NarHash: value } })).toThrow(
			CorruptNarInfoError
		);
	});

	// A file hash under another algorithm is one Nix reads and keeps, since
	// nothing compares an offer under it.
	it('reads a file hash written under another algorithm', () => {
		expect(() =>
			read({ fields: { FileHash: `sha512:${bytesToHex(new Uint8Array(64))}` } })
		).not.toThrow();
	});

	it.each([
		{ name: 'a size that is not a number', fields: { NarSize: 'lots' } },
		{ name: 'a size written in exponent form', fields: { NarSize: '1e5' } },
		{ name: 'a signed size', fields: { NarSize: '+1000' } },
		{
			name: 'a size larger than can be counted',
			fields: { FileSize: '1'.repeat(20) }
		}
	])('refuses a document carrying $name', ({ fields }) => {
		expect(() => read({ fields })).toThrow(CorruptNarInfoError);
	});

	it.each([
		{ name: 'one it has no decompressor for', value: 'banana' },
		{ name: 'one written in another case', value: 'XZ' }
	])('refuses a compression naming $name', ({ value }) => {
		expect(() => read({ fields: { Compression: value } })).toThrow(
			CorruptNarInfoError
		);
	});

	it.each([
		{
			name: 'references separated by something other than a space',
			fields: {
				References: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-library\taaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app`
			}
		},
		{
			name: 'a reference that is not a store path',
			fields: { References: 'nope' }
		},
		{ name: 'a deriver that is not a store path', fields: { Deriver: 'nope' } },
		{ name: 'an empty deriver', fields: { Deriver: '' } }
	])('refuses a document carrying $name', ({ fields }) => {
		expect(() => read({ fields })).toThrow(CorruptNarInfoError);
	});

	it('refuses a document naming its references twice', () => {
		expect(() =>
			read({
				extraLines: ['References: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app']
			})
		).toThrow(CorruptNarInfoError);
	});

	// A signature names the key that made it and carries base64 that decodes.
	// Nix refuses the whole document over one it cannot read.
	it.each([
		{ name: 'no colon at all', value: 'not-a-signature' },
		{ name: 'no key name', value: `:${bytesToBase64(new Uint8Array(64))}` },
		{ name: 'no material', value: 'cache.example.org-1:' },
		{
			name: 'material outside the base64 alphabet',
			value: 'cache.example.org-1:not base64 at all'
		},
		{
			name: 'material that does not decode',
			value: 'cache.example.org-1:aaaaa'
		},
		{
			// Six bits are no whole byte, so the line names a key and states
			// nothing signed under it.
			name: 'material decoding to no bytes at all',
			value: 'cache.example.org-1:A'
		}
	])('refuses a signature carrying $name', ({ value }) => {
		expect(() => read({ fields: { Sig: value } })).toThrow(CorruptNarInfoError);
	});

	it('carries every signature the document publishes', () => {
		const second = `cache.example.org-2:${bytesToBase64(new Uint8Array(64).fill(4))}`;

		expect(read({ extraLines: [`Sig: ${second}`] }).signatures).toStrictEqual([
			signature,
			second
		]);
	});

	// A content address states how the path was made before the hash it is.
	it.each([
		{
			name: 'a flat fixed output',
			value: `fixed:sha256:${toNixBase32(narDigest)}`
		},
		{
			name: 'a recursive fixed output',
			value: `fixed:r:sha256:${bytesToHex(narDigest)}`
		},
		{ name: 'a text output', value: `text:sha256:${bytesToBase64(narDigest)}` },
		{
			name: 'another algorithm',
			value: `fixed:md5:${bytesToHex(narDigest.slice(0, 16))}`
		}
	])('reads a content address naming $name', ({ value }) => {
		expect(() => read({ fields: { CA: value } })).not.toThrow();
	});

	it.each([
		{ name: 'nothing readable at all', value: 'not a valid content address' },
		{ name: 'no method', value: `sha256:${toNixBase32(narDigest)}` },
		{
			name: 'a method it does not know',
			value: `flat:sha256:${toNixBase32(narDigest)}`
		},
		{
			name: 'a method behind an experimental feature',
			value: `fixed:git:sha256:${toNixBase32(narDigest)}`
		},
		{ name: 'no hash at all', value: 'fixed:r:' },
		{
			name: 'an algorithm it does not know',
			value: `fixed:md4:${'a'.repeat(32)}`
		},
		{
			name: 'a digest outside its alphabet',
			value: `fixed:sha256:${'e'.repeat(52)}`
		},
		{
			name: 'a hash in the integrity spelling',
			value: `fixed:sha256-${bytesToBase64(narDigest)}`
		}
	])('refuses a content address carrying $name', ({ value }) => {
		expect(() => read({ fields: { CA: value } })).toThrow(CorruptNarInfoError);
	});

	it('refuses a document stating its content address twice', () => {
		expect(() =>
			read({
				fields: { CA: `fixed:sha256:${toNixBase32(narDigest)}` },
				extraLines: [`CA: fixed:sha256:${toNixBase32(narDigest)}`]
			})
		).toThrow(CorruptNarInfoError);
	});

	// An empty value states no content address, so the one that follows it is
	// the document's first.
	it('reads a content address following an empty one', () => {
		expect(() =>
			read({
				fields: { CA: '' },
				extraLines: [`CA: fixed:sha256:${toNixBase32(narDigest)}`]
			})
		).not.toThrow();
	});
});
