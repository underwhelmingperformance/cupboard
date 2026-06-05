import { describe, expect, it } from 'vitest';

import { implicitPinName, isImplicitPinName } from './retention.ts';

const storePathHash = '0123456789abcdfghijklmnpqrsvwxyz';

describe('implicitPinName', () => {
	it('names a pin from a store path hash', () => {
		expect(implicitPinName(storePathHash)).toBe(`pin:${storePathHash}`);
	});
});

describe('isImplicitPinName', () => {
	it.each([
		{
			name: 'a generated pin name',
			value: `pin:${storePathHash}`,
			valid: true
		},
		{
			name: 'a user channel name',
			value: 'github:owner/repo/main',
			valid: false
		},
		{
			name: 'a pin prefix with a bad hash',
			value: 'pin:not-a-hash',
			valid: false
		},
		{ name: 'a bare pin prefix', value: 'pin:', valid: false }
	])('$name', ({ value, valid }) => {
		expect(isImplicitPinName(value)).toBe(valid);
	});
});
