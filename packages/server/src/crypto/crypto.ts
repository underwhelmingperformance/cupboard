import { bytesToBase64, bytesToHex } from '@cupboard/nix/encoding';

const textEncoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
	return sha256HexBytes(textEncoder.encode(value));
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);

	return bytesToHex(new Uint8Array(digest));
}

export function isConstantTimeEqual(left: string, right: string): boolean {
	const leftBytes = textEncoder.encode(left);
	const rightBytes = textEncoder.encode(right);
	const size = Math.max(leftBytes.byteLength, rightBytes.byteLength);
	let difference = leftBytes.byteLength ^ rightBytes.byteLength;

	for (let index = 0; index < size; index += 1) {
		difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}

	return difference === 0;
}

export async function generateSigningKey(name: string): Promise<{
	readonly privateJwk: JsonWebKey;
	readonly publicKey: string;
}> {
	const keyPair = (await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	const publicRaw = (await crypto.subtle.exportKey(
		'raw',
		keyPair.publicKey
	)) as ArrayBuffer;
	const privateJwk = (await crypto.subtle.exportKey(
		'jwk',
		keyPair.privateKey
	)) as JsonWebKey;

	return {
		privateJwk,
		publicKey: `${name}:${bytesToBase64(new Uint8Array(publicRaw))}`
	};
}

// A JWK names its key type in `kty`. That structural check is enough to hand a
// typed key on; whether the key material is usable is decided when it is
// imported for signing or verification.
function isJsonWebKey(value: unknown): value is JsonWebKey {
	return (
		typeof value === 'object' &&
		value !== null &&
		'kty' in value &&
		typeof value.kty === 'string'
	);
}

// Deserialises a stored JSON Web Key.
export function parseJwk(json: string): JsonWebKey {
	const value: unknown = JSON.parse(json);

	if (!isJsonWebKey(value)) {
		throw new TypeError('Stored JSON Web Key is malformed');
	}

	return value;
}

export async function signNixFingerprint(
	privateJwk: JsonWebKey,
	fingerprint: string,
	name: string
): Promise<string> {
	const privateKey = await crypto.subtle.importKey(
		'jwk',
		privateJwk,
		'Ed25519',
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign(
		'Ed25519',
		privateKey,
		textEncoder.encode(fingerprint)
	);

	return `${name}:${bytesToBase64(new Uint8Array(signature))}`;
}
