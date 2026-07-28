import { nixFingerprintSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	generateSigningKey,
	nixKeyNameSchema,
	sha256Hex,
	signNixFingerprint
} from './crypto.ts';

describe('crypto', () => {
	const fingerprint = nixFingerprintSchema.parse(
		'1;/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example;sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk;123;0123456789abcdfghijklmnpqrsvwxyz-example'
	);
	const keyName = nixKeyNameSchema.parse('cupboard-1');

	it('hashes token material as SHA-256 hex', async () => {
		expect(await sha256Hex('cupboard-token')).toBe(
			'e951cd4605d6f42c5bba9cf418756b172259552339512737d7abbb049935cb49'
		);
	});

	it('signs a known Nix fingerprint fixture', async () => {
		const privateJwk = {
			key_ops: ['sign'],
			ext: true,
			crv: 'Ed25519',
			d: '_G96QT3W7QKNXxmKOrTSEr5A-P36eRDAgKyajg8yo0Y',
			x: 'eqNTb4MVxBgHitT2FPaHwD9BFcJR9OjKEkD-16I76vI',
			kty: 'OKP'
		} satisfies JsonWebKey;

		expect(await signNixFingerprint(privateJwk, fingerprint, keyName)).toBe(
			'cupboard-1:7waROGMw+BXcaUyvBHxzYXL7VpQ982Qew5tP9YPUm9SIlqhnXXWQCXEc/BI9et/d06vL731Lv2krDHrHf85hBQ=='
		);
	});

	it('generates an Ed25519 keypair and signs a Nix fingerprint', async () => {
		const key = await generateSigningKey(keyName);
		const signature = await signNixFingerprint(
			key.privateJwk,
			fingerprint,
			keyName
		);
		const publicKey = parseNamedBytes(key.publicKey);
		const signatureBytes = parseNamedBytes(signature);
		const importedPublicKey = await crypto.subtle.importKey(
			'raw',
			publicKey.bytes,
			'Ed25519',
			false,
			['verify']
		);
		const encoder = new TextEncoder();
		const isVerified = await crypto.subtle.verify(
			'Ed25519',
			importedPublicKey,
			signatureBytes.bytes,
			encoder.encode(fingerprint)
		);

		expect({
			publicKey: {
				name: publicKey.name,
				length: publicKey.bytes.byteLength
			},
			signature: {
				name: signatureBytes.name,
				length: signatureBytes.bytes.byteLength
			},
			verified: isVerified
		}).toStrictEqual({
			publicKey: {
				name: 'cupboard-1',
				length: 32
			},
			signature: {
				name: 'cupboard-1',
				length: 64
			},
			verified: true
		});
	});
});

function parseNamedBytes(value: string): {
	readonly name: string;
	readonly bytes: Uint8Array;
} {
	const separator = value.indexOf(':');

	if (separator === -1) {
		throw new InvalidNamedBytesError(value);
	}

	const name = value.slice(0, separator);
	const encoded = value.slice(separator + 1);
	const decoded = atob(encoded);
	const bytes = Uint8Array.from(
		decoded,
		(character) => character.codePointAt(0) ?? 0
	);

	return {
		name,
		bytes
	};
}

class InvalidNamedBytesError extends Error {
	constructor(public readonly value: string) {
		super(`Invalid named bytes: ${value}`);
		this.name = 'InvalidNamedBytesError';
	}
}
