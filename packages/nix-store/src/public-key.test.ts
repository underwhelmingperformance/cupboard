import { describe, expect, it } from 'vitest';

import { InvalidNixPublicKeyError } from './errors.ts';
import { NixPublicKey } from './public-key.ts';
import { nixKeyNameSchema } from './scalars.ts';

describe('NixPublicKey', () => {
	it('splits a rendered key into its name and material', () => {
		const key = new NixPublicKey('cupboard-1:cHVibGlj');

		expect({
			value: key.value,
			name: key.name,
			material: key.material,
			bytes: key.bytes
		}).toStrictEqual({
			value: 'cupboard-1:cHVibGlj',
			name: 'cupboard-1',
			material: 'cHVibGlj',
			bytes: Uint8Array.from([112, 117, 98, 108, 105, 99])
		});
	});

	it('renders a name and its raw public bytes back to the parsed halves', () => {
		const key = NixPublicKey.of(
			nixKeyNameSchema.parse('cupboard-2'),
			Uint8Array.from([112, 117, 98])
		);

		expect({
			value: key.value,
			name: key.name,
			material: key.material,
			bytes: key.bytes
		}).toStrictEqual({
			value: 'cupboard-2:cHVi',
			name: 'cupboard-2',
			material: 'cHVi',
			bytes: Uint8Array.from([112, 117, 98])
		});
	});

	// A key that is missing either half names no signer or verifies nothing, so
	// it is refused at the boundary rather than yielding a truncated name.
	it.each([
		{ name: 'no separator', value: 'cupboard-1' },
		{ name: 'an empty name', value: ':cHVibGlj' },
		{ name: 'empty material', value: 'cupboard-1:' },
		{ name: 'material that is not base64', value: 'cupboard-1:not base64!' },
		{ name: 'material of an impossible length', value: 'cupboard-1:cHVib' },
		{ name: 'neither half', value: ':' },
		{ name: 'nothing at all', value: '' }
	])('refuses a key with $name', ({ value }) => {
		expect(() => new NixPublicKey(value)).toThrow(InvalidNixPublicKeyError);
	});
});
