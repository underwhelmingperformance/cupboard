import { bytesToBase64, bytesToHex } from '@cupboard/nix-store/encoding';
import { z } from 'zod';

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

// `crypto.subtle.generateKey` is typed to return `CryptoKey | CryptoKeyPair`,
// so the cast names the pair the Ed25519 parameters guarantee. Centralising it
// keeps the curve choice and the cast in one place for every signing key.
export async function generateEd25519KeyPair(): Promise<CryptoKeyPair> {
	return (await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
}

// The name-independent half of a signing key: the entropy and the exports. Split
// out so a rotation can generate it before taking the critical section, since
// only the public-key rendering needs the name read inside that section.
export async function generateSigningKeyMaterial(): Promise<{
	readonly privateJwk: JsonWebKey;
	readonly publicRaw: Uint8Array;
}> {
	const keyPair = await generateEd25519KeyPair();
	const publicRaw = (await crypto.subtle.exportKey(
		'raw',
		keyPair.publicKey
	)) as ArrayBuffer;
	const privateJwk = (await crypto.subtle.exportKey(
		'jwk',
		keyPair.privateKey
	)) as JsonWebKey;

	return { privateJwk, publicRaw: new Uint8Array(publicRaw) };
}

// Renders a Nix signing key's public half, which labels the raw key with its
// name. Pure, so it can run inside a critical section without holding the gate
// across any I/O.
export function renderSigningPublicKey(
	name: string,
	publicRaw: Uint8Array
): string {
	return `${name}:${bytesToBase64(publicRaw)}`;
}

export async function generateSigningKey(name: string): Promise<{
	readonly privateJwk: JsonWebKey;
	readonly publicKey: string;
}> {
	const material = await generateSigningKeyMaterial();

	return {
		privateJwk: material.privateJwk,
		publicKey: renderSigningPublicKey(name, material.publicRaw)
	};
}

const rsaOtherPrimeInfoSchema = z.object({
	d: z.string().optional(),
	r: z.string().optional(),
	t: z.string().optional()
});

// The standard JWK fields, with only `kty` required; whether the key material
// is usable is decided when it is imported for signing or verification.
const jsonWebKeySchema = z.object({
	kty: z.string(),
	alg: z.string().optional(),
	crv: z.string().optional(),
	d: z.string().optional(),
	dp: z.string().optional(),
	dq: z.string().optional(),
	e: z.string().optional(),
	k: z.string().optional(),
	n: z.string().optional(),
	p: z.string().optional(),
	q: z.string().optional(),
	qi: z.string().optional(),
	use: z.string().optional(),
	x: z.string().optional(),
	y: z.string().optional(),
	ext: z.boolean().optional(),
	key_ops: z.array(z.string()).optional(),
	oth: z.array(rsaOtherPrimeInfoSchema).optional()
}) satisfies z.ZodType<JsonWebKey>;

// Deserialises a stored JSON Web Key.
export function parseJwk(json: string): JsonWebKey {
	const value: unknown = JSON.parse(json);
	const parsed = jsonWebKeySchema.safeParse(value);

	if (!parsed.success) {
		throw new TypeError('Stored JSON Web Key is malformed');
	}

	return parsed.data;
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
