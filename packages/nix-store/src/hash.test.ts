import { describe, expect, it } from 'vitest';

import { bytesToBase64, bytesToHex } from './encoding.ts';
import { InvalidNixSha256HashError } from './errors.ts';
import { fromNixBase32, NixSha256Hash, toNixBase32 } from './hash.ts';

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
