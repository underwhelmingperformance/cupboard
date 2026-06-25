import type {
	CredentialResolver,
	ResolvedCredential
} from '@cupboard/s3/ports';

import { S3EncryptionKeyInvalidError } from '../errors.ts';

const ivLength = 12;
const keyLength = 32;

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCodePoint(byte);
	}
	return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.codePointAt(index) ?? 0;
	}
	return bytes;
}

/**
 * One configured AES-GCM key and the id it is recorded under. The id is derived
 * from the key bytes, so the same secret always produces the same id and a
 * ciphertext can be matched back to the key that wrote it.
 */
export interface EncryptionKey {
	readonly id: string;
	readonly key: CryptoKey;
}

/**
 * The set of keys that may decrypt a stored credential: the current key (used to
 * encrypt new secrets) plus any previous keys retained across a rotation. A
 * ciphertext records the id of the key that wrote it, so rotating the current
 * key leaves existing credentials decryptable until their key is retired.
 */
export interface EncryptionKeyset {
	readonly current: EncryptionKey;
	keyById(id: string): CryptoKey | undefined;
}

async function deriveKeyId(rawKey: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', rawKey);
	return [...new Uint8Array(digest).slice(0, 4)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Imports a 256-bit AES-GCM key from its base64 encoding, deriving the id it is
 * recorded under. Rejects a key that is not 32 bytes, so a misconfigured secret
 * fails loudly at startup rather than corrupting ciphertexts.
 */
export async function importEncryptionKey(
	base64Key: string
): Promise<EncryptionKey> {
	const raw = fromBase64(base64Key);
	if (raw.length !== keyLength) {
		throw new S3EncryptionKeyInvalidError(raw.length);
	}

	const key = await crypto.subtle.importKey(
		'raw',
		new Uint8Array(raw),
		{ name: 'AES-GCM' },
		false,
		['encrypt', 'decrypt']
	);
	return { id: await deriveKeyId(raw), key };
}

/**
 * Assembles a keyset from the current key and any retained previous keys.
 */
export function createEncryptionKeyset(
	current: EncryptionKey,
	previous: readonly EncryptionKey[] = []
): EncryptionKeyset {
	const byId = new Map<string, CryptoKey>([
		...previous.map((entry): [string, CryptoKey] => [entry.id, entry.key]),
		[current.id, current.key]
	]);
	return { current, keyById: (id) => byId.get(id) };
}

/**
 * Encrypts a credential secret with the keyset's current key, returning the
 * key id and base64 of the random IV followed by the ciphertext. A fresh IV is
 * generated per call.
 */
export async function encryptSecret(
	keyset: EncryptionKeyset,
	plaintext: string
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(ivLength));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		keyset.current.key,
		new TextEncoder().encode(plaintext)
	);

	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(ciphertext), iv.length);
	return `${keyset.current.id}.${toBase64(combined)}`;
}

/** A stored secret was written under a key the keyset no longer holds. */
export class UnknownEncryptionKeyError extends Error {
	constructor(public readonly keyId: string) {
		super('No configured key matches the stored ciphertext');
		this.name = 'UnknownEncryptionKeyError';
	}
}

/**
 * Reverses {@link encryptSecret}, selecting the key by the recorded id. Throws
 * {@link UnknownEncryptionKeyError} when no configured key matches, and rethrows
 * the AES-GCM failure if the ciphertext was tampered with.
 */
export async function decryptSecret(
	keyset: EncryptionKeyset,
	encoded: string
): Promise<string> {
	const dot = encoded.indexOf('.');
	const keyId = dot === -1 ? '' : encoded.slice(0, dot);
	const key = keyset.keyById(keyId);
	if (key === undefined) {
		throw new UnknownEncryptionKeyError(keyId);
	}

	const combined = fromBase64(encoded.slice(dot + 1));
	const iv = combined.slice(0, ivLength);
	const ciphertext = combined.slice(ivLength);
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv },
		key,
		ciphertext
	);
	return new TextDecoder().decode(plaintext);
}

/**
 * A stored S3 credential, with its secret encrypted at rest. Scoped to one
 * tenant and cache with a fixed grant set.
 */
export interface StoredS3Credential {
	readonly credentialId: string;
	readonly secretCiphertext: string;
	readonly tenant: string;
	readonly cache: string;
	readonly grants: readonly string[];
	readonly label: string;
}

/**
 * Looks up a stored credential by its access key id; returns `undefined` when no
 * live credential exists.
 */
export interface S3CredentialStore {
	find(accessKeyId: string): Promise<StoredS3Credential | undefined>;
}

/**
 * A {@link CredentialResolver} backed by an encrypted credential store: it
 * decrypts the secret needed to verify the SigV4 signature and assembles the
 * principal the request authenticates as.
 */
export function createS3CredentialResolver(
	store: S3CredentialStore,
	keyset: EncryptionKeyset
): CredentialResolver {
	return {
		async resolve(accessKeyId): Promise<ResolvedCredential | undefined> {
			const found = await store.find(accessKeyId);
			if (found === undefined) {
				return;
			}

			// A credential whose key has rotated away (or whose ciphertext no longer
			// decrypts) cannot authenticate a request; it resolves as absent so the
			// request fails as an unknown signature, prompting a re-issue.
			const secretAccessKey = await decrypt(keyset, found.secretCiphertext);
			if (secretAccessKey === undefined) {
				return;
			}

			return {
				secretAccessKey,
				principal: {
					accessKeyId,
					tenant: found.tenant,
					cache: found.cache,
					grants: found.grants,
					label: found.label,
					credentialId: found.credentialId
				}
			};
		}
	};
}

async function decrypt(
	keyset: EncryptionKeyset,
	ciphertext: string
): Promise<string | undefined> {
	try {
		return await decryptSecret(keyset, ciphertext);
	} catch {
		return undefined;
	}
}
