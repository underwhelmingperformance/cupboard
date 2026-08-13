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
	/** The key file Nix writes, whose last 32 bytes are the public half. */
	secretFile(): Promise<string>;
}

// `generateKey` is typed as producing either a single key or a pair, and
// Ed25519 always produces a pair, which this narrows to once.
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
	it('accepts a signature from a key it trusts', async () => {
		const key = await signingKey('cache-1');
		const signature = await key.sign(fingerprint);
		const trusted = NixTrustedKeys.of([key.published.value]);

		await expect(
			trusted.verifies(fingerprint, [signature.value])
		).resolves.toBe(true);
	});

	it('refuses a signature from a key it does not trust', async () => {
		const signing = await signingKey('cache-1');
		const other = await signingKey('cache-2');
		const signature = await signing.sign(fingerprint);
		const trusted = NixTrustedKeys.of([other.published.value]);

		await expect(
			trusted.verifies(fingerprint, [signature.value])
		).resolves.toBe(false);
	});

	// A key name says which key a signature claims to come from, so a
	// signature naming a trusted key still has to verify against it.
	it('refuses a signature naming a trusted key it does not verify against', async () => {
		const signing = await signingKey('cache-1');
		const impostor = await signingKey('cache-1');
		const signature = await impostor.sign(fingerprint);
		const trusted = NixTrustedKeys.of([signing.published.value]);

		await expect(
			trusted.verifies(fingerprint, [signature.value])
		).resolves.toBe(false);
	});

	it('refuses a signature over a different fingerprint', async () => {
		const key = await signingKey('cache-1');
		const signature = await key.sign(fingerprint);
		const trusted = NixTrustedKeys.of([key.published.value]);

		await expect(
			trusted.verifies(nixFingerprintSchema.parse(`${fingerprint}/other`), [
				signature.value
			])
		).resolves.toBe(false);
	});

	// A narinfo carries every signature its cache holds, most of them from
	// keys a given reader does not know, and the ones it knows decide.
	it('accepts one trusted signature among several it cannot read', async () => {
		const key = await signingKey('cache-1');
		const signature = await key.sign(fingerprint);
		const trusted = NixTrustedKeys.of([key.published.value]);

		await expect(
			trusted.verifies(fingerprint, [
				'not a signature',
				'other-1:AAAA',
				signature.value
			])
		).resolves.toBe(true);
	});

	it.each([
		{ name: 'no signatures at all', signatures: [] },
		{ name: 'only ones it cannot read', signatures: ['not a signature'] }
	])('refuses a path carrying $name', async ({ signatures }) => {
		const key = await signingKey('cache-1');

		await expect(
			NixTrustedKeys.of([key.published.value]).verifies(fingerprint, signatures)
		).resolves.toBe(false);
	});

	it('reports an empty set when nothing it was given names a key', () => {
		expect(NixTrustedKeys.of(['not a key', '']).isEmpty).toBe(true);
	});

	// Nix keeps the first key it reads under a name, so a list naming one
	// twice verifies against the first of them.
	it('keeps the first key listed under a name', async () => {
		const first = await signingKey('cache-1');
		const second = await signingKey('cache-1');
		const trusted = NixTrustedKeys.of([
			first.published.value,
			second.published.value
		]);
		const signature = await second.sign(fingerprint);

		await expect(
			trusted.verifies(fingerprint, [signature.value])
		).resolves.toBe(false);
	});
});

describe('publicKeyOfSecret', () => {
	it('reads the published half out of a secret key file', async () => {
		const key = await signingKey('cache-1');

		expect(publicKeyOfSecret(await key.secretFile())?.value).toBe(
			key.published.value
		);
	});

	it('verifies a signature made by the secret it was read from', async () => {
		const key = await signingKey('cache-1');
		const published = publicKeyOfSecret(await key.secretFile());
		const signature = await key.sign(fingerprint);

		await expect(
			NixTrustedKeys.of([published?.value ?? '']).verifies(fingerprint, [
				signature.value
			])
		).resolves.toBe(true);
	});

	it.each([
		{ name: 'a file that is not a named value', contents: 'nonsense' },
		{ name: 'an empty file', contents: '' }
	])('reads no key out of $name', ({ contents }) => {
		expect(publicKeyOfSecret(contents)).toBeUndefined();
	});

	it('reads no key out of a public key, which is half the length', async () => {
		const key = await signingKey('cache-1');

		expect(publicKeyOfSecret(key.published.value)).toBeUndefined();
	});
});
