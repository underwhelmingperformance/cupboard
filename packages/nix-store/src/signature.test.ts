import { describe, expect, it } from 'vitest';

import { InvalidNixSignatureError } from './errors.ts';
import { nixKeyNameSchema } from './scalars.ts';
import { isNixSignature, NixSignature } from './signature.ts';

describe('NixSignature', () => {
	it('splits a narinfo signature into the key name and the signature bytes', () => {
		const signature = new NixSignature('cupboard-1:c2lnbmVk');

		expect({
			value: signature.value,
			name: signature.name,
			material: signature.material,
			bytes: signature.bytes
		}).toStrictEqual({
			value: 'cupboard-1:c2lnbmVk',
			name: 'cupboard-1',
			material: 'c2lnbmVk',
			bytes: Uint8Array.from([115, 105, 103, 110, 101, 100])
		});
	});

	it('renders a name and its signature bytes back to the parsed halves', () => {
		const signature = NixSignature.of(
			nixKeyNameSchema.parse('cupboard-2'),
			Uint8Array.from([115, 105, 103])
		);

		expect({
			value: signature.value,
			name: signature.name,
			material: signature.material,
			bytes: signature.bytes
		}).toStrictEqual({
			value: 'cupboard-2:c2ln',
			name: 'cupboard-2',
			material: 'c2ln',
			bytes: Uint8Array.from([115, 105, 103])
		});
	});

	// A signature missing either half selects no key or carries nothing to check
	// against one, so it is refused rather than decoded into arbitrary bytes.
	it.each([
		{ name: 'no separator', value: 'cupboard-1' },
		{ name: 'an empty name', value: ':c2lnbmVk' },
		{ name: 'empty material', value: 'cupboard-1:' },
		{ name: 'material that is not base64', value: 'cupboard-1:signature' },
		{ name: 'neither half', value: ':' },
		{ name: 'nothing at all', value: '' }
	])('refuses a signature with $name', ({ value }) => {
		expect(() => new NixSignature(value)).toThrow(InvalidNixSignatureError);
	});

	// Whitespace inside the material is read past by the decoder this is built
	// on, and Nix's own decoder refuses it, so it is refused here.
	it.each([
		{ name: 'a rendered signature', value: 'cupboard-1:c2lnbmVk', reads: true },
		{
			name: 'material carrying a space',
			value: 'cupboard-1:c2ln bmVk',
			reads: false
		},
		{
			name: 'material carrying a tab',
			value: 'cupboard-1:c2ln\tbmVk',
			reads: false
		},
		{ name: 'no separator', value: 'cupboard-1', reads: false },
		{ name: 'an empty name', value: ':c2lnbmVk', reads: false },
		{ name: 'empty material', value: 'cupboard-1:', reads: false },
		// Six bits are no whole byte, so the value names a key and states
		// nothing signed under it.
		{
			name: 'material carrying one character',
			value: 'cupboard-1:A',
			reads: false
		}
	])('reads $name as a signature: $reads', ({ value, reads }) => {
		expect(isNixSignature(value)).toBe(reads);
	});

	it('keeps the well-formed signatures of a narinfo and drops the rest', () => {
		expect(
			NixSignature.parseAll([
				'cupboard-1:c2lnbmVk',
				'cupboard-2',
				'cupboard-3:signature',
				'cupboard-4:c2ln'
			]).map((signature) => ({
				name: signature.name,
				material: signature.material
			}))
		).toStrictEqual([
			{ name: 'cupboard-1', material: 'c2lnbmVk' },
			{ name: 'cupboard-4', material: 'c2ln' }
		]);
	});
});
