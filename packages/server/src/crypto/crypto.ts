import { bytesToHex } from '@cupboard/nix-store/encoding';
import { NixPublicKey } from '@cupboard/nix-store/public-key';
import {
	type NixFingerprint,
	type NixKeyName
} from '@cupboard/nix-store/scalars';
import { NixSignature } from '@cupboard/nix-store/signature';
import { z } from 'zod';

const textEncoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
	return sha256HexBytes(textEncoder.encode(value));
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);

	return bytesToHex(new Uint8Array(digest));
}

const comparisonKey = crypto.subtle.importKey(
	'raw',
	textEncoder.encode('cupboard/constant-time-comparison/v1'),
	{ name: 'HMAC', hash: 'SHA-256' },
	false,
	['sign', 'verify']
);

/**
 * Compares two strings of the required UTF-8 byte length through Web Crypto's
 * HMAC verifier. Returns false before invoking Web Crypto if either input has a
 * different length.
 */
export async function isConstantTimeEqual(
	left: string,
	right: string,
	expectedByteLength: number
): Promise<boolean> {
	const leftBytes = textEncoder.encode(left);
	const rightBytes = textEncoder.encode(right);

	if (
		leftBytes.byteLength !== expectedByteLength ||
		rightBytes.byteLength !== expectedByteLength
	) {
		return false;
	}

	const key = await comparisonKey;
	const signature = await crypto.subtle.sign('HMAC', key, leftBytes);

	return crypto.subtle.verify('HMAC', key, signature, rightBytes);
}

// The Workers type also covers algorithms that return one key, but Ed25519
// generation returns a key pair. Keep the pair extractable because callers
// persist the private JWK and the public key.
export async function generateEd25519KeyPair(): Promise<CryptoKeyPair> {
	return (await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
}

// Rotation generates and exports this material before entering its critical
// section. It assigns the generation-dependent Nix key name only after reading
// the key sequence inside the gate.
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

export async function generateSigningKey(name: NixKeyName): Promise<{
	readonly privateJwk: JsonWebKey;
	readonly publicKey: NixPublicKey;
}> {
	const material = await generateSigningKeyMaterial();

	return {
		privateJwk: material.privateJwk,
		publicKey: NixPublicKey.of(name, material.publicRaw)
	};
}

const rsaOtherPrimeInfoSchema = z.object({
	d: z.string().optional(),
	r: z.string().optional(),
	t: z.string().optional()
});

// Validate the stored value against the Workers `JsonWebKey` shape. This does
// not prove that the key supports an operation; Web Crypto or jose validates
// the algorithm and key material when it imports the key.
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
	fingerprint: NixFingerprint,
	name: NixKeyName
): Promise<NixSignature> {
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

	return NixSignature.of(name, new Uint8Array(signature));
}
