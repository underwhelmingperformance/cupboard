import { describe, expect, it } from 'vitest';

import { bytesToBase64, bytesToHex } from './encoding.ts';
import { InvalidNixSha256HashError } from './errors.ts';
import {
	decodeNixHash,
	decodeNixHashField,
	fromNixBase32,
	NixSha256Hash,
	toNixBase32
} from './hash.ts';

describe('NixSha256Hash', () => {
	it('renders the digest as lowercase hex', () => {
		const digest = new Uint8Array(32);
		digest.fill(0x09);
		const hash = NixSha256Hash.fromDigest(digest);

		expect(hash.digestHex()).toBe('09'.repeat(32));
	});

	it('percent-encodes the colon for a URL path segment', () => {
		const digest = new Uint8Array(32);
		digest.fill(0x09);
		const hash = NixSha256Hash.fromDigest(digest);

		expect(hash.toUrlSegment()).toBe(`sha256%3A${hash.toString().slice(7)}`);
	});
});

describe('NixSha256Hash.parsePrefixed', () => {
	const digest = Uint8Array.from({ length: 32 }, (_, index) => index * 7);

	it.each([
		{ encoding: 'base16', body: bytesToHex(digest) },
		{ encoding: 'base32', body: toNixBase32(digest) },
		{ encoding: 'base64', body: bytesToBase64(digest) }
	])('parses a $encoding digest to the same hash', ({ body }) => {
		expect(
			NixSha256Hash.parsePrefixed(`sha256:${body}`).digestBytes()
		).toStrictEqual(digest);
	});

	it.each([
		{ name: 'a missing algorithm prefix', value: bytesToHex(digest) },
		{ name: 'a digest of the wrong length', value: 'sha256:abcd' },
		{ name: 'a non-hex 64-character digest', value: `sha256:${'g'.repeat(64)}` }
	])('rejects $name', ({ value }) => {
		expect(() => NixSha256Hash.parsePrefixed(value)).toThrow(
			InvalidNixSha256HashError
		);
	});
});

describe('decodeNixHashField', () => {
	const digest = Uint8Array.from({ length: 64 }, (_, index) => index * 3);

	it.each([
		{ algorithm: 'md5', digestBytes: 16 },
		{ algorithm: 'sha1', digestBytes: 20 },
		{ algorithm: 'sha256', digestBytes: 32 },
		{ algorithm: 'sha512', digestBytes: 64 }
	])(
		'reads a $algorithm digest in every encoding',
		({ algorithm, digestBytes }) => {
			const bytes = digest.slice(0, digestBytes);
			const spellings = [
				bytesToHex(bytes),
				toNixBase32(bytes),
				bytesToBase64(bytes)
			];

			expect(
				spellings.map((body) => decodeNixHashField(`${algorithm}:${body}`))
			).toStrictEqual(spellings.map(() => ({ algorithm, bytes })));
		}
	);

	it.each([
		{ name: 'padded', body: bytesToBase64(digest.slice(0, 32)) },
		{
			name: 'unpadded',
			body: bytesToBase64(digest.slice(0, 32)).replace(/=+$/u, '')
		}
	])('reads a $name integrity spelling by what it decodes to', ({ body }) => {
		expect(decodeNixHashField(`sha256-${body}`)).toStrictEqual({
			algorithm: 'sha256',
			bytes: digest.slice(0, 32)
		});
	});

	it.each([
		{ name: 'no algorithm', value: bytesToHex(digest.slice(0, 32)) },
		{ name: 'an unknown algorithm', value: `md4:${'a'.repeat(32)}` },
		{ name: 'an empty digest', value: 'sha256:' },
		{ name: 'a digest of no known length', value: `sha256:${'a'.repeat(50)}` },
		{
			name: 'a base16 digest with a non-hex character',
			value: `sha256:${'z'.repeat(64)}`
		},
		{
			name: 'a base32 digest outside the alphabet',
			value: `sha256:${'e'.repeat(52)}`
		},
		{
			name: 'a base64 digest outside the alphabet',
			value: `sha256:${'!'.repeat(44)}`
		},
		{
			// 44 unpadded base64 characters carry 33 bytes, one more than the
			// algorithm holds.
			name: 'a base64 digest decoding past the algorithm',
			value: `sha256:${'A'.repeat(44)}`
		},
		{
			name: 'an integrity digest decoding to another length',
			value: `sha256-${bytesToBase64(digest.slice(0, 31))}`
		},
		{
			name: 'an algorithm named after a dash',
			value: `sha256-abc:${'a'.repeat(52)}`
		}
	])('reads no hash out of $name', ({ value }) => {
		expect(decodeNixHashField(value)).toBeUndefined();
	});

	it('does not parse an SRI value as a colon-prefixed hash', () => {
		const integrity = `sha256-${bytesToBase64(digest.slice(0, 32))}`;

		expect(decodeNixHash(integrity)).toBeUndefined();
	});
});

describe('fromNixBase32', () => {
	it('round-trips a canonical encoding back to its digest', () => {
		const digest = Uint8Array.from({ length: 32 }, (_, index) => index * 7);
		const canonical = toNixBase32(digest);

		expect(fromNixBase32(canonical)).toStrictEqual(digest);
	});

	it.each([
		{ name: 'an out-of-alphabet character', value: 'e'.repeat(52) },
		{ name: 'an empty string', value: '' },
		{ name: 'a too-short input', value: '1'.repeat(51) },
		{ name: 'a too-long input', value: '1'.repeat(53) },
		{
			name: 'a non-canonical top digit that overflows 256 bits',
			value: `2${toNixBase32(new Uint8Array(32).fill(0x09)).slice(1)}`
		}
	])('rejects $name', ({ value }) => {
		expect(() => fromNixBase32(value)).toThrow(InvalidNixSha256HashError);
	});
});
