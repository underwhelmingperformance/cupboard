import { NixPublicKey } from './public-key.ts';
import { type NixFingerprint, type NixKeyName } from './scalars.ts';
import { NixSignature } from './signature.ts';

/**
 * Trusted keys indexed by signing key name. Nix keeps the first key for each
 * name, so duplicate entries do not replace it.
 */
export class NixTrustedKeys {
	/**
	 * Parses the valid `<name>:<base64>` keys and ignores malformed values. The
	 * remaining keys determine whether a path is trusted.
	 */
	static of(values: readonly string[]): NixTrustedKeys {
		const keys = new Map<NixKeyName, NixPublicKey>();

		for (const value of values) {
			const key = parseKey(value);

			if (key !== undefined && !keys.has(key.name)) {
				keys.set(key.name, key);
			}
		}

		return new NixTrustedKeys(keys);
	}

	private constructor(
		private readonly keys: ReadonlyMap<NixKeyName, NixPublicKey>
	) {}

	get isEmpty(): boolean {
		return this.keys.size === 0;
	}

	/**
	 * Whether any of the signatures verifies against a trusted key over this
	 * fingerprint. Nix counts the signatures it can verify and accepts a path
	 * with at least one. Signatures from unknown keys do not affect the result.
	 */
	async verifies(
		fingerprint: NixFingerprint,
		signatures: readonly string[]
	): Promise<boolean> {
		const signed = new TextEncoder().encode(fingerprint);

		for (const signature of NixSignature.parseAll(signatures)) {
			const key = this.keys.get(signature.name);

			if (key !== undefined && (await verifies(key, signature, signed))) {
				return true;
			}
		}

		return false;
	}
}

/**
 * Reads the public half of a Nix secret key file. The file contains a name and a
 * 64-byte Ed25519 secret whose last 32 bytes are the public key. A file that
 * does not match this format returns `undefined`.
 */
export function publicKeyOfSecret(contents: string): NixPublicKey | undefined {
	const parsed = parseKey(contents.trim());

	if (parsed?.bytes.byteLength !== secretKeyByteLength) {
		return undefined;
	}

	return NixPublicKey.of(
		parsed.name,
		parsed.bytes.slice(publicKeyByteLength, secretKeyByteLength)
	);
}

const publicKeyByteLength = 32;
const secretKeyByteLength = 64;

// The signature algorithm every Nix signing key uses.
const algorithm = 'Ed25519';

// The Web Crypto API takes bytes backed by a buffer of their own, and a
// decoded value's may be shared, so each one is copied into its own.
function ownBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);

	return copy;
}

function parseKey(value: string): NixPublicKey | undefined {
	try {
		return new NixPublicKey(value);
	} catch {
		return undefined;
	}
}

async function verifies(
	key: NixPublicKey,
	signature: NixSignature,
	signed: Uint8Array
): Promise<boolean> {
	if (key.bytes.byteLength !== publicKeyByteLength) {
		return false;
	}

	try {
		const imported = await crypto.subtle.importKey(
			'raw',
			ownBuffer(key.bytes),
			algorithm,
			false,
			['verify']
		);

		return await crypto.subtle.verify(
			algorithm,
			imported,
			ownBuffer(signature.bytes),
			ownBuffer(signed)
		);
	} catch {
		// Web Crypto reports malformed key or signature material by throwing. Such
		// material cannot verify the fingerprint.
		return false;
	}
}
