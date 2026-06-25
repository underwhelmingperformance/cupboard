import { describe, expect, it } from 'vitest';

import { S3EncryptionKeyInvalidError } from '../errors.ts';

import {
	createEncryptionKeyset,
	createS3CredentialResolver,
	decryptSecret,
	type EncryptionKeyset,
	encryptSecret,
	importEncryptionKey,
	type S3CredentialStore,
	type StoredS3Credential,
	UnknownEncryptionKeyError
} from './credentials.ts';

function randomKeyB64(): string {
	const raw = crypto.getRandomValues(new Uint8Array(32));
	let binary = '';
	for (const byte of raw) {
		binary += String.fromCodePoint(byte);
	}
	return btoa(binary);
}

async function keysetOf(...base64Keys: string[]): Promise<EncryptionKeyset> {
	const keys = await Promise.all(
		base64Keys.map((base64) => importEncryptionKey(base64))
	);
	const [current, ...previous] = keys;
	if (current === undefined) {
		throw new Error('a keyset needs at least one key');
	}
	return createEncryptionKeyset(current, previous);
}

function stored(secretCiphertext: string): StoredS3Credential {
	return {
		credentialId: 'cred-1',
		secretCiphertext,
		tenant: 'acme',
		cache: 'builds',
		grants: ['upload:commit'],
		label: 'nixbuild'
	};
}

function storeOf(
	records: Record<string, StoredS3Credential>
): S3CredentialStore {
	return { find: (id) => Promise.resolve(records[id]) };
}

describe('secret encryption', () => {
	it('round-trips a secret and uses a fresh IV each time', async () => {
		const keyset = await keysetOf(randomKeyB64());
		const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

		const first = await encryptSecret(keyset, secret);
		const second = await encryptSecret(keyset, secret);
		expect(first).not.toBe(second);
		expect(await decryptSecret(keyset, first)).toBe(secret);
		expect(await decryptSecret(keyset, second)).toBe(secret);
	});

	it('fails to decrypt tampered ciphertext', async () => {
		const keyset = await keysetOf(randomKeyB64());
		const encoded = await encryptSecret(keyset, 'secret');
		const tampered = `${encoded.slice(0, -2)}${encoded.endsWith('A') ? 'B' : 'A'}=`;

		await expect(decryptSecret(keyset, tampered)).rejects.toThrow();
	});

	it('reports an unknown key when no configured key matches', async () => {
		const encoded = await encryptSecret(
			await keysetOf(randomKeyB64()),
			'secret'
		);
		const otherKeyset = await keysetOf(randomKeyB64());
		await expect(decryptSecret(otherKeyset, encoded)).rejects.toThrow(
			UnknownEncryptionKeyError
		);
	});

	it('decrypts across a rotation while the previous key is retained', async () => {
		const oldKey = randomKeyB64();
		const newKey = randomKeyB64();
		const encoded = await encryptSecret(await keysetOf(oldKey), 'secret');

		// New key current, old key retained: the old ciphertext still decrypts.
		expect(await decryptSecret(await keysetOf(newKey, oldKey), encoded)).toBe(
			'secret'
		);

		// Once the old key is retired, its ciphertexts can no longer be read.
		await expect(
			decryptSecret(await keysetOf(newKey), encoded)
		).rejects.toThrow(UnknownEncryptionKeyError);
	});

	it('rejects an encryption key that is not 32 bytes', async () => {
		const shortKey = btoa('too-short');
		await expect(importEncryptionKey(shortKey)).rejects.toThrow(
			S3EncryptionKeyInvalidError
		);
	});
});

describe('createS3CredentialResolver', () => {
	it('decrypts the secret and assembles the principal', async () => {
		const keyset = await keysetOf(randomKeyB64());
		const secret = 'super-secret';
		const record = stored(await encryptSecret(keyset, secret));
		const resolver = createS3CredentialResolver(
			storeOf({ AKID: record }),
			keyset
		);

		expect(await resolver.resolve('AKID')).toStrictEqual({
			secretAccessKey: secret,
			principal: {
				accessKeyId: 'AKID',
				tenant: 'acme',
				cache: 'builds',
				grants: ['upload:commit'],
				label: 'nixbuild',
				credentialId: 'cred-1'
			}
		});
	});

	it('returns undefined for an unknown access key', async () => {
		const resolver = createS3CredentialResolver(
			storeOf({}),
			await keysetOf(randomKeyB64())
		);
		expect(await resolver.resolve('missing')).toBeUndefined();
	});

	it('returns undefined for a credential whose key has rotated away', async () => {
		const writeKeyset = await keysetOf(randomKeyB64());
		const record = stored(await encryptSecret(writeKeyset, 'secret'));
		const resolver = createS3CredentialResolver(
			storeOf({ AKID: record }),
			await keysetOf(randomKeyB64())
		);
		expect(await resolver.resolve('AKID')).toBeUndefined();
	});
});
