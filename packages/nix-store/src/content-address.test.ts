import { describe, expect, it } from 'vitest';

import { isContentAddress } from './content-address.ts';
import { bytesToBase64, bytesToHex } from './encoding.ts';
import { toNixBase32 } from './hash.ts';

const digest = Uint8Array.from({ length: 32 }, (_, index) => index * 5);
const base32 = toNixBase32(digest);

describe('isContentAddress', () => {
	it.each([
		{ name: 'a flat fixed output', value: `fixed:sha256:${base32}` },
		{
			name: 'a fixed output serialised as a NAR',
			value: `fixed:r:sha256:${base32}`
		},
		{ name: 'a text output', value: `text:sha256:${base32}` },
		{
			name: 'a digest written base16',
			value: `fixed:sha256:${bytesToHex(digest)}`
		},
		{
			name: 'a digest written base64',
			value: `fixed:sha256:${bytesToBase64(digest)}`
		},
		{
			name: 'another algorithm',
			value: `fixed:md5:${bytesToHex(digest.slice(0, 16))}`
		}
	])('reads $name', ({ value }) => {
		expect(isContentAddress(value)).toBe(true);
	});

	it.each([
		{ name: 'nothing that separates a method off', value: 'no separator here' },
		{ name: 'a method it does not know', value: `flat:sha256:${base32}` },
		{ name: 'no method at all', value: `sha256:${base32}` },
		{
			// Nix reads this method behind the git-hashing experimental feature.
			name: 'a method behind an experimental feature',
			value: `fixed:git:sha256:${base32}`
		},
		{ name: 'no hash', value: 'fixed:' },
		{ name: 'no algorithm before the digest', value: `fixed:${base32}` },
		{
			name: 'an algorithm it does not know',
			value: `fixed:md4:${'a'.repeat(32)}`
		},
		{ name: 'a digest of the wrong length', value: 'fixed:sha256:abcd' },
		{
			name: 'a digest outside its alphabet',
			value: `fixed:sha256:${'e'.repeat(52)}`
		},
		{
			// A content address states its algorithm before a colon, so the
			// integrity spelling states no algorithm this reads.
			name: 'a hash in the integrity spelling',
			value: `fixed:sha256-${bytesToBase64(digest)}`
		},
		{ name: 'a recursive marker and nothing else', value: 'fixed:r:' },
		{ name: 'the empty string', value: '' }
	])('reads no content address out of $name', ({ value }) => {
		expect(isContentAddress(value)).toBe(false);
	});
});
