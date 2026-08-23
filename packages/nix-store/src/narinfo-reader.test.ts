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

interface NarInfoFixture {
	readonly fields?: Readonly<Record<string, string | undefined>>;
	readonly extraLines?: readonly string[];
	readonly endsWithNewline?: boolean;
}

const wellFormedValues = new Map(wellFormedFields);

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
	it('returns every offer field from a well-formed narinfo', () => {
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

	it('expands deriver and reference basenames in the queried store', () => {
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

	it('parses `unknown-deriver` as an absent deriver', () => {
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
		{ name: 'an unrecognised field', fields: { Unknown: 'whatever' } },
		{ name: 'an empty content address', fields: { CA: '' } }
	])('accepts a narinfo with $name', ({ fields }) => {
		expect(() => read({ fields })).not.toThrow();
	});

	it.each([
		{ name: 'no StorePath', fields: { StorePath: undefined } },
		{ name: 'no URL', fields: { URL: undefined } },
		{ name: 'an empty URL', fields: { URL: '' } },
		{ name: 'no NarHash', fields: { NarHash: undefined } },
		{ name: 'no NarSize', fields: { NarSize: undefined } },
		{ name: 'a NarSize of zero', fields: { NarSize: '0' } }
	])('rejects a narinfo with $name', ({ fields }) => {
		expect(() => read({ fields })).toThrow(CorruptNarInfoError);
	});

	it('rejects a narinfo without a final newline', () => {
		expect(() => read({ endsWithNewline: false })).toThrow(CorruptNarInfoError);
	});

	// Nix starts a field value two characters after the colon rather than
	// trimming whitespace. Without the required space, the parser drops the
	// value's first character.
	it('rejects a narinfo without the space after a colon', () => {
		const document = narInfoDocument({}).replace(
			'NarSize: 1000',
			'NarSize:1000'
		);

		expect(() => offerFromNarInfo(document, appPath, storeDirectory)).toThrow(
			CorruptNarInfoError
		);
	});

	it('rejects a line without a colon', () => {
		expect(() => read({ extraLines: ['no colon here'] })).toThrow(
			CorruptNarInfoError
		);
	});

	it('rejects a narinfo for another path with a mismatch error', () => {
		expect(() => read({}, libraryPath)).toThrow(MismatchedNarInfoPathError);
	});

	it.each([
		{ name: 'lowercase base16', digest: bytesToHex(narDigest) },
		{ name: 'uppercase base16', digest: bytesToHex(narDigest).toUpperCase() },
		{ name: "nix's own base32", digest: toNixBase32(narDigest) },
		{ name: 'padded base64', digest: bytesToBase64(narDigest) }
	])('parses a NAR hash written in $name', ({ digest }) => {
		expect(
			read({ fields: { NarHash: `sha256:${digest}` } }).narHash
		).toStrictEqual(narHash);
	});

	it.each([
		{ name: 'padded', digest: bytesToBase64(narDigest) },
		{ name: 'unpadded', digest: bytesToBase64(narDigest).replace(/=+$/u, '') }
	])('parses a $name NAR hash in the integrity spelling', ({ digest }) => {
		expect(
			read({ fields: { NarHash: `sha256-${digest}` } }).narHash
		).toStrictEqual(narHash);
	});

	it.each([
		{ name: 'no algorithm at all', value: toNixBase32(narDigest) },
		{ name: 'an unsupported algorithm', value: `md4:${'a'.repeat(32)}` },
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
			name: 'a sha256-sized digest labelled sha1',
			value: `sha1:${bytesToHex(narDigest)}`
		}
	])('rejects a NAR hash with $name', ({ value }) => {
		expect(() => read({ fields: { NarHash: value } })).toThrow(
			CorruptNarInfoError
		);
	});

	// The offer does not retain FileHash, but Nix still validates it. A malformed
	// FileHash therefore invalidates the whole narinfo.
	it.each([
		{
			name: 'a base16 digest outside its alphabet',
			value: `sha256:${'z'.repeat(64)}`
		},
		{
			name: 'a base32 digest outside its alphabet',
			value: `sha256:${'e'.repeat(52)}`
		},
		{ name: 'an unsupported algorithm', value: `md4:${'a'.repeat(32)}` }
	])('rejects a FileHash with $name', ({ value }) => {
		expect(() => read({ fields: { FileHash: value } })).toThrow(
			CorruptNarInfoError
		);
	});

	// Offers compare NAR contents with sha256, so NarHash must use that algorithm
	// even though the general hash parser supports others.
	it.each([
		{ name: 'sha1', value: `sha1:${bytesToHex(narDigest.slice(0, 20))}` },
		{ name: 'sha512', value: `sha512:${bytesToHex(new Uint8Array(64))}` }
	])('rejects a NAR hash using $name', ({ value }) => {
		expect(() => read({ fields: { NarHash: value } })).toThrow(
			CorruptNarInfoError
		);
	});

	// FileHash may use any supported algorithm; only NarHash must use sha256.
	it('accepts a FileHash using another supported algorithm', () => {
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
	])('rejects a narinfo with $name', ({ fields }) => {
		expect(() => read({ fields })).toThrow(CorruptNarInfoError);
	});

	it.each([
		{ name: 'an unsupported algorithm', value: 'banana' },
		{ name: 'a spelling in another case', value: 'XZ' }
	])('rejects compression with $name', ({ value }) => {
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
	])('rejects a narinfo with $name', ({ fields }) => {
		expect(() => read({ fields })).toThrow(CorruptNarInfoError);
	});

	it('rejects a repeated References field', () => {
		expect(() =>
			read({
				extraLines: ['References: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app']
			})
		).toThrow(CorruptNarInfoError);
	});

	// Every Sig value must parse as `<key-name>:<base64>`. One malformed Sig line
	// invalidates the whole narinfo.
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
			// One base64 character cannot encode a whole byte, so this value decodes
			// to empty material.
			name: 'material decoding to no bytes at all',
			value: 'cache.example.org-1:A'
		}
	])('rejects a signature with $name', ({ value }) => {
		expect(() => read({ fields: { Sig: value } })).toThrow(CorruptNarInfoError);
	});

	it('returns every Sig entry in document order', () => {
		const second = `cache.example.org-2:${bytesToBase64(new Uint8Array(64).fill(4))}`;

		expect(read({ extraLines: [`Sig: ${second}`] }).signatures).toStrictEqual([
			signature,
			second
		]);
	});

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
	])('accepts a content address for $name', ({ value }) => {
		expect(() => read({ fields: { CA: value } })).not.toThrow();
	});

	it.each([
		{ name: 'invalid syntax', value: 'not a valid content address' },
		{ name: 'no method', value: `sha256:${toNixBase32(narDigest)}` },
		{
			name: 'an unsupported method',
			value: `flat:sha256:${toNixBase32(narDigest)}`
		},
		{
			name: 'a method behind an experimental feature',
			value: `fixed:git:sha256:${toNixBase32(narDigest)}`
		},
		{ name: 'no hash at all', value: 'fixed:r:' },
		{
			name: 'an unsupported algorithm',
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
	])('rejects a content address with $name', ({ value }) => {
		expect(() => read({ fields: { CA: value } })).toThrow(CorruptNarInfoError);
	});

	it('rejects repeated non-empty CA fields', () => {
		expect(() =>
			read({
				fields: { CA: `fixed:sha256:${toNixBase32(narDigest)}` },
				extraLines: [`CA: fixed:sha256:${toNixBase32(narDigest)}`]
			})
		).toThrow(CorruptNarInfoError);
	});

	// An empty CA does not set the content address, so a later non-empty CA is
	// still the first value.
	it('accepts a non-empty CA after an empty CA', () => {
		expect(() =>
			read({
				fields: { CA: '' },
				extraLines: [`CA: fixed:sha256:${toNixBase32(narDigest)}`]
			})
		).not.toThrow();
	});
});
