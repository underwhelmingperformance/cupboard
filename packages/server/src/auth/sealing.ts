import { base64ToBytes } from '@cupboard/nix-store/encoding';

/**
Derives an AES-GCM key from a deployment secret with HKDF-SHA-256. `info`
separates the purposes that share one secret, and `salt` separates the
values sealed for one purpose.
*/
export async function deriveSealingKey(
	secret: string,
	salt: string,
	info: readonly string[]
): Promise<CryptoKey> {
	const encoder = new TextEncoder();
	const material = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		'HKDF',
		false,
		['deriveKey']
	);

	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: encoder.encode(salt),
			info: encoder.encode(JSON.stringify(info))
		},
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/**
Decrypts AES-GCM ciphertext. Returns undefined when the authentication tag
does not match, which is how a wrong key, wrong additional data or altered
ciphertext fails. Any other Web Crypto failure propagates.
*/
export async function decryptOrUndefined(
	key: CryptoKey,
	iv: Uint8Array,
	ciphertext: Uint8Array,
	additionalData?: Uint8Array
): Promise<Uint8Array | undefined> {
	try {
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv,
					...(additionalData !== undefined && { additionalData })
				},
				key,
				ciphertext
			)
		);
	} catch (error) {
		if (error instanceof DOMException && error.name === 'OperationError') {
			return undefined;
		}

		throw error;
	}
}

export function base64UrlToBytes(value: string): Uint8Array | undefined {
	try {
		return base64ToBytes(value.replaceAll('-', '+').replaceAll('_', '/'));
	} catch {
		return undefined;
	}
}
