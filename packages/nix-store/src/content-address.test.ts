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
			name: 'rejects the git method without git-hashing',
			value: `fixed:git:sha256:${base32}`
		},
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
