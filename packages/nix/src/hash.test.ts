import { describe, expect, it } from 'vitest';

import { InvalidNixSha256HashError } from './errors.ts';
import { fromNixBase32, NixSha256Hash } from './hash.ts';

describe('NixSha256Hash', () => {
	it('renders the digest as lowercase hex', () => {
		const hash = NixSha256Hash.fromDigest(new Uint8Array(32).fill(0x09));

		expect(hash.digestHex()).toBe('09'.repeat(32));
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
