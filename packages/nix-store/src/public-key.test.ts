import { describe, expect, it } from 'vitest';

import {
	InvalidNixPublicKeyError,
	InvalidNixPublicKeySetError
} from './errors.ts';
import { NixPublicKey, parsePublishedNixPublicKeys } from './public-key.ts';
import { nixKeyNameSchema } from './scalars.ts';

describe('NixPublicKey', () => {
	it('splits a rendered key into its name and material', () => {
		const key = new NixPublicKey(
			'cupboard-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
		);

		expect({
			value: key.value,
			name: key.name,
			material: key.material,
			bytes: key.bytes
		}).toStrictEqual({
			value: 'cupboard-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
			name: 'cupboard-1',
			material: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
			bytes: Uint8Array.from({ length: 32 }, (_, index) => index)
		});
	});

	it('renders a name and its raw public bytes back to the parsed halves', () => {
		const key = NixPublicKey.of(
			nixKeyNameSchema.parse('cupboard-2'),
			Uint8Array.from({ length: 32 }, (_, index) => index)
		);

		expect({
			value: key.value,
			name: key.name,
			material: key.material,
			bytes: key.bytes
		}).toStrictEqual({
			value: 'cupboard-2:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
			name: 'cupboard-2',
			material: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
			bytes: Uint8Array.from({ length: 32 }, (_, index) => index)
		});
	});

	it.each([
		'cupboard-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
		'cupboard-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9='
	])('rejects non-canonical Base64 material in %s', (value) => {
		expect(() => new NixPublicKey(value)).toThrow(InvalidNixPublicKeyError);
	});
	it.each([
		{ name: 'no separator', value: 'cupboard-1' },
		{ name: 'an empty name', value: ':cHVibGlj' },
		{ name: 'empty material', value: 'cupboard-1:' },
		{ name: 'material that is not base64', value: 'cupboard-1:not base64!' },
		{ name: 'material of an impossible length', value: 'cupboard-1:cHVib' },
		{ name: 'material that is not 32 bytes', value: 'cupboard-1:cHVibGlj' },
		{ name: 'neither half', value: ':' },
		{ name: 'nothing at all', value: '' }
	])('refuses a key with $name', ({ value }) => {
		expect(() => new NixPublicKey(value)).toThrow(InvalidNixPublicKeyError);
	});
});

describe('parsePublishedNixPublicKeys', () => {
	const first = 'cupboard-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
	const second = 'cupboard-2:Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=';

	it('parses every rotation key and preserves publication order', () => {
		expect(
			parsePublishedNixPublicKeys(`  ${first}\n${second}\t`).map(
				(key) => key.value
			)
		).toStrictEqual([first, second]);
	});

	it.each([
		{ name: 'is empty', source: '' },
		{ name: 'contains malformed material', source: `${first}\ninvalid` },
		{ name: 'repeats a key name', source: `${first}\n${first}` }
	])('rejects a published set that $name', ({ source }) => {
		expect(() => parsePublishedNixPublicKeys(source)).toThrow(
			InvalidNixPublicKeySetError
		);
	});
});
