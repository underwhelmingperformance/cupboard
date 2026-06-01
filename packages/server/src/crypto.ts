const textEncoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
	return sha256HexBytes(textEncoder.encode(value));
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);

	return hex(new Uint8Array(digest));
}

export function constantTimeEqual(left: string, right: string): boolean {
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
		publicKey: `${name}:${base64(new Uint8Array(publicRaw))}`
	};
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

	return `${name}:${base64(new Uint8Array(signature))}`;
}

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCodePoint(...bytes));
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
