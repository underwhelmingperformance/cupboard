import { describe, expect, it } from 'vitest';

import { generateSigningPair } from '../../../tests/support/signing.ts';

import { bytesToBase64 } from './encoding.ts';
import { NixPublicKey } from './public-key.ts';
import {
	type NixFingerprint,
	nixFingerprintSchema,
	type NixKeyName,
	nixKeyNameSchema
} from './scalars.ts';
import { NixSignature } from './signature.ts';
import { NixTrustedKeys, publicKeyOfSecret } from './verify.ts';

const fingerprint: NixFingerprint = nixFingerprintSchema.parse(
	'1;/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app;sha256:abc;42;'
);

interface SigningKey {
	readonly name: NixKeyName;
	readonly published: NixPublicKey;
	sign(over: NixFingerprint): Promise<NixSignature>;
	secretFile(): Promise<string>;
}

// Web Crypto types `generateKey` as returning a single key or a pair.
// Ed25519 always returns a pair, so narrow the result once in this helper.
async function signingKey(name: string): Promise<SigningKey> {
	const keyName = nixKeyNameSchema.parse(name);
	const pair = await generateSigningPair();
	const rawPublic = new Uint8Array(
		await crypto.subtle.exportKey('raw', pair.publicKey)
	);

	return {
		name: keyName,
		published: NixPublicKey.of(keyName, rawPublic),
		async sign(over) {
			const signature = await crypto.subtle.sign(
				'Ed25519',
				pair.privateKey,
				new TextEncoder().encode(over)
			);

			return NixSignature.of(keyName, new Uint8Array(signature));
		},
		async secretFile() {
			const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
			const seed = base64UrlToBytes(jwk.d ?? '');
			const secret = new Uint8Array(64);
			secret.set(seed);
			secret.set(rawPublic, 32);

			return `${keyName}:${bytesToBase64(secret)}`;
		}
	};
}

function base64UrlToBytes(value: string): Uint8Array {
	const padded = value.replaceAll('-', '+').replaceAll('_', '/');

	return Uint8Array.from(
		atob(padded),
		(character) => character.codePointAt(0) ?? 0
	);
}

describe('NixTrustedKeys', () => {
	it('verifies a signature from a trusted key', async () => {
		const key = await signingKey('cache-1');
		const signature = await key.sign(fingerprint);
		const trusted = NixTrustedKeys.of([key.published.value]);

		await expect(
			trusted.hasValidSignature(fingerprint, [signature.value])
		).resolves.toBe(true);
	});

	it('does not verify a signature from an untrusted key', async () => {
		const signing = await signingKey('cache-1');
		const other = await signingKey('cache-2');
		const signature = await signing.sign(fingerprint);
		const trusted = NixTrustedKeys.of([other.published.value]);

		await expect(
			trusted.hasValidSignature(fingerprint, [signature.value])
		).resolves.toBe(false);
	});

	// The embedded key name selects a trusted public key. The signature bytes
	// must still verify against that key.
	it('does not verify an impostor signature that uses a trusted key name', async () => {
		const signing = await signingKey('cache-1');
		const impostor = await signingKey('cache-1');
		const signature = await impostor.sign(fingerprint);
		const trusted = NixTrustedKeys.of([signing.published.value]);

		await expect(
			trusted.hasValidSignature(fingerprint, [signature.value])
		).resolves.toBe(false);
	});

	it('does not verify a signature over a different fingerprint', async () => {
		const key = await signingKey('cache-1');
		const signature = await key.sign(fingerprint);
		const trusted = NixTrustedKeys.of([key.published.value]);

		await expect(
			trusted.hasValidSignature(
				nixFingerprintSchema.parse(`${fingerprint}/other`),
				[signature.value]
			)
		).resolves.toBe(false);
	});

	// Verification ignores malformed signatures and signatures from unknown
	// keys, but succeeds if any remaining signature verifies.
	it('verifies one trusted signature among malformed and untrusted entries', async () => {
		const key = await signingKey('cache-1');
		const signature = await key.sign(fingerprint);
		const trusted = NixTrustedKeys.of([key.published.value]);

		await expect(
			trusted.hasValidSignature(fingerprint, [
				'not a signature',
				'other-1:AAAA',
				signature.value
			])
		).resolves.toBe(true);
	});

	it.each([
		{ name: 'no signatures at all', signatures: [] },
		{ name: 'only malformed signatures', signatures: ['not a signature'] }
	])('returns false for $name', async ({ signatures }) => {
		const key = await signingKey('cache-1');

		await expect(
			NixTrustedKeys.of([key.published.value]).hasValidSignature(
				fingerprint,
				signatures
			)
		).resolves.toBe(false);
	});

	it('ignores malformed trusted-key values', () => {
		expect(NixTrustedKeys.of(['not a key', '']).isEmpty).toBe(true);
	});

	// Nix indexes trusted keys by name and keeps the first public key for a
	// duplicate name.
	it('uses the first public key for a duplicate key name', async () => {
		const first = await signingKey('cache-1');
		const second = await signingKey('cache-1');
		const trusted = NixTrustedKeys.of([
			first.published.value,
			second.published.value
		]);
		const signature = await second.sign(fingerprint);

		await expect(
			trusted.hasValidSignature(fingerprint, [signature.value])
		).resolves.toBe(false);
	});
});

describe('publicKeyOfSecret', () => {
	it('extracts the public half from a secret key file', async () => {
		const key = await signingKey('cache-1');

		expect(publicKeyOfSecret(await key.secretFile())?.value).toBe(
			key.published.value
		);
	});

	it('verifies a signature with the public half extracted from the same secret', async () => {
		const key = await signingKey('cache-1');
		const published = publicKeyOfSecret(await key.secretFile());
		const signature = await key.sign(fingerprint);

		await expect(
			NixTrustedKeys.of([published?.value ?? '']).hasValidSignature(
				fingerprint,
				[signature.value]
			)
		).resolves.toBe(true);
	});

	it.each([
		{ name: 'a file that is not a named value', contents: 'nonsense' },
		{ name: 'an empty file', contents: '' }
	])('returns no public key for $name', ({ contents }) => {
		expect(publicKeyOfSecret(contents)).toBeUndefined();
	});

	it('returns no key from a 32-byte public-key value', async () => {
		const key = await signingKey('cache-1');

		expect(publicKeyOfSecret(key.published.value)).toBeUndefined();
	});
});
