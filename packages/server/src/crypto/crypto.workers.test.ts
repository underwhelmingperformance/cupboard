import {
	nixFingerprintSchema,
	nixKeyNameSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	generateSigningKey,
	isConstantTimeEqual,
	sha256Hex,
	signNixFingerprint
} from './crypto.ts';

describe('crypto', () => {
	const fingerprint = nixFingerprintSchema.parse(
		'1;/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example;sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk;123;0123456789abcdfghijklmnpqrsvwxyz-example'
	);
	const keyName = nixKeyNameSchema.parse('cupboard-1');

	it("returns a string's SHA-256 digest as lowercase hex", async () => {
		expect(await sha256Hex('cupboard-token')).toBe(
			'e951cd4605d6f42c5bba9cf418756b172259552339512737d7abbb049935cb49'
		);
	});

	it('compares only values satisfying the fixed-length format', async () => {
		await expect(
			Promise.all([
				isConstantTimeEqual('abcd', 'abcd', 4),
				isConstantTimeEqual('abcd', 'abce', 4),
				isConstantTimeEqual('abcd', 'abcd', 3)
			])
		).resolves.toStrictEqual([true, false, false]);
	});

	it('produces the expected Ed25519 signature for a known Nix fingerprint and key', async () => {
		const privateJwk = {
			key_ops: ['sign'],
			ext: true,
			crv: 'Ed25519',
			d: '_G96QT3W7QKNXxmKOrTSEr5A-P36eRDAgKyajg8yo0Y',
			x: 'eqNTb4MVxBgHitT2FPaHwD9BFcJR9OjKEkD-16I76vI',
			kty: 'OKP'
		} satisfies JsonWebKey;
		const signature = await signNixFingerprint(
			privateJwk,
			fingerprint,
			keyName
		);

		expect({ name: signature.name, value: signature.value }).toStrictEqual({
			name: 'cupboard-1',
			value:
				'cupboard-1:7waROGMw+BXcaUyvBHxzYXL7VpQ982Qew5tP9YPUm9SIlqhnXXWQCXEc/BI9et/d06vL731Lv2krDHrHf85hBQ=='
		});
	});

	it('generates a Nix signing key whose public key verifies its signatures', async () => {
		const key = await generateSigningKey(keyName);
		const signature = await signNixFingerprint(
			key.privateJwk,
			fingerprint,
			keyName
		);
		const importedPublicKey = await crypto.subtle.importKey(
			'raw',
			key.publicKey.bytes,
			'Ed25519',
			false,
			['verify']
		);
		const encoder = new TextEncoder();
		const isVerified = await crypto.subtle.verify(
			'Ed25519',
			importedPublicKey,
			signature.bytes,
			encoder.encode(fingerprint)
		);

		expect({
			publicKey: {
				name: key.publicKey.name,
				length: key.publicKey.bytes.byteLength
			},
			signature: {
				name: signature.name,
				length: signature.bytes.byteLength
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
