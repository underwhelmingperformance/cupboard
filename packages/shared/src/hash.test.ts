import { describe, expect, it } from 'vitest';

import { InvalidNixSha256HashError } from './errors.ts';
import { fromNixBase32 } from './hash.ts';

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
