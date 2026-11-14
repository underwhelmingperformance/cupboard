import { describe, expect, it } from 'vitest';

import { isContentAddress } from './content-address.ts';
import { bytesToBase64, bytesToHex } from './encoding.ts';
import { toNixBase32 } from './hash.ts';

const digest = Uint8Array.from({ length: 32 }, (_, index) => index * 5);
const base32 = toNixBase32(digest);

describe('isContentAddress', () => {
	it.each([
		{
			name: 'accepts a flat fixed-output address',
			value: `fixed:sha256:${base32}`
		},
		{
			name: 'accepts a NAR fixed-output address',
			value: `fixed:r:sha256:${base32}`
		},
		{ name: 'accepts a text address', value: `text:sha256:${base32}` },
		{
			name: 'accepts a base16 digest',
			value: `fixed:sha256:${bytesToHex(digest)}`
		},
		{
			name: 'accepts a base64 digest',
			value: `fixed:sha256:${bytesToBase64(digest)}`
		},
		{
			name: 'accepts an MD5 digest',
			value: `fixed:md5:${bytesToHex(digest.slice(0, 16))}`
		},
		{
			name: 'accepts the git method with a SHA-1 digest',
			value: `fixed:git:sha1:${bytesToHex(digest.slice(0, 20))}`
		},
		{
			name: 'accepts the git method with a SHA-256 digest',
			value: `fixed:git:sha256:${base32}`
		},
		{
			name: 'accepts the BLAKE3 algorithm in a flat address',
			value: `fixed:blake3:${bytesToHex(digest)}`
		},
		{
			name: 'accepts the BLAKE3 algorithm in a NAR address',
			value: `fixed:r:blake3:${base32}`
		},
		{
			name: 'accepts the BLAKE3 algorithm in a text address',
			value: `text:blake3:${bytesToBase64(digest)}`
		}
	])('$name', ({ value }) => {
		expect(isContentAddress(value)).toBe(true);
	});

	it.each([
		{
			name: 'rejects a value without a method separator',
			value: 'no separator here'
		},
		{ name: 'rejects an unknown method', value: `flat:sha256:${base32}` },
		{
			name: 'rejects a hash without a content-address method',
			value: `sha256:${base32}`
		},
		{
			name: 'rejects the git method after the NAR prefix',
			value: `fixed:r:git:sha1:${bytesToHex(digest.slice(0, 20))}`
		},
		{
			name: 'rejects the NAR prefix after the git method',
			value: `fixed:git:r:sha1:${bytesToHex(digest.slice(0, 20))}`
		},
		{
			name: 'rejects the git method in a text address',
			value: `text:git:sha1:${bytesToHex(digest.slice(0, 20))}`
		},
		{ name: 'rejects the git method without a hash', value: 'fixed:git:' },
		{
			name: 'rejects a BLAKE3 digest with the wrong length',
			value: `fixed:blake3:${bytesToHex(digest.slice(0, 20))}`
		},
		...[
			{ name: 'a space', character: ' ' },
			{ name: 'a tab', character: '\t' },
			{ name: 'a line feed', character: '\n' },
			{ name: 'a form feed', character: '\f' },
			{ name: 'a carriage return', character: '\r' }
		].flatMap(({ name, character }) => [
			{
				name: `rejects a base64 SHA-256 digest with ${name} in place of a digit`,
				value: `fixed:sha256:${'A'.repeat(20)}${character}${'A'.repeat(23)}`
			},
			{
				name: `rejects a base64 BLAKE3 digest with ${name} in place of a digit`,
				value: `fixed:blake3:${'A'.repeat(20)}${character}${'A'.repeat(23)}`
			}
		]),
		{ name: 'rejects a missing hash', value: 'fixed:' },
		{
			name: 'rejects a missing hash algorithm',
			value: `fixed:${base32}`
		},
		{
			name: 'rejects an unsupported hash algorithm',
			value: `fixed:md4:${'a'.repeat(32)}`
		},
		{
			name: 'rejects a digest with the wrong length',
			value: 'fixed:sha256:abcd'
		},
		{
			name: 'rejects a digest outside the Nix base32 alphabet',
			value: `fixed:sha256:${'e'.repeat(52)}`
		},
		{
			name: 'rejects SRI hash syntax',
			value: `fixed:sha256-${bytesToBase64(digest)}`
		},
		{ name: 'rejects fixed:r: without a hash', value: 'fixed:r:' },
		{ name: 'rejects an empty value', value: '' }
	])('$name', ({ value }) => {
		expect(isContentAddress(value)).toBe(false);
	});
});
