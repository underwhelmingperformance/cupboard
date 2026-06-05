import { parseJwk } from '../crypto/crypto.ts';
import {
	ControlWrappedKeyMalformedError,
	ControlWrappingKeyInvalidError
} from '../errors.ts';

// AES-256-GCM envelope wrapping for the control-plane private signing key. The
// control key mints global-admin tokens, so it must be reachable only by the
// control-plane Worker. A `D1Database` binding is database-wide: a tenant Durable
// Object can issue arbitrary SQL against `CUPBOARD_DB` regardless of its Drizzle
// schema, so storing the key in D1 unwrapped, or merely omitting the table from
// the DO's schema, would be no protection at all. Instead the row holds only the
// wrapped key, and the wrapping secret is bound only on the control-plane Worker.
// The Durable Object runs in a separate script (`cupboard-tenant`) that never
// binds that secret, so a DO that reads the row still cannot recover the key.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const wrappingKeyBytes = 32;
const ivBytes = 12;

async function importWrappingKey(
	wrappingKeyBase64: string
): Promise<CryptoKey> {
	const raw = base64ToBytes(wrappingKeyBase64);

	if (raw.byteLength !== wrappingKeyBytes) {
		throw new ControlWrappingKeyInvalidError(raw.byteLength);
	}

	return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
		'encrypt',
		'decrypt'
	]);
}

// Wraps a control private JWK as `base64(iv).base64(ciphertext)`. A fresh random
// 96-bit IV per wrap keeps the reused wrapping key safe under AES-GCM.
export async function wrapControlPrivateJwk(
	wrappingKeyBase64: string,
	privateJwk: JsonWebKey
): Promise<string> {
	const key = await importWrappingKey(wrappingKeyBase64);
	const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		textEncoder.encode(JSON.stringify(privateJwk))
	);

	return `${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}

// Recovers a control private JWK wrapped by {@link wrapControlPrivateJwk}. A wrong
// wrapping key, a tampered ciphertext, or a malformed envelope all fail here: GCM
// authentication rejects altered bytes, so the key is integrity-protected too.
export async function unwrapControlPrivateJwk(
	wrappingKeyBase64: string,
	wrapped: string
): Promise<JsonWebKey> {
	const key = await importWrappingKey(wrappingKeyBase64);
	const [ivPart, ciphertextPart, ...rest] = wrapped.split('.');

	if (ivPart === undefined || ciphertextPart === undefined || rest.length > 0) {
		throw new ControlWrappedKeyMalformedError();
	}

	let plaintext: ArrayBuffer;

	try {
		plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: base64ToBytes(ivPart) },
			key,
			base64ToBytes(ciphertextPart)
		);
	} catch {
		throw new ControlWrappedKeyMalformedError();
	}

	return parseJwk(textDecoder.decode(plaintext));
}

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCodePoint(...bytes));
}

function base64ToBytes(value: string): Uint8Array {
	return Uint8Array.from(
		atob(value),
		(character) => character.codePointAt(0) ?? 0
	);
}
