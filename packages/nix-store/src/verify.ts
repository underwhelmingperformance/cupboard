import { NixPublicKey } from './public-key.ts';
import { type NixFingerprint, type NixKeyName } from './scalars.ts';
import { NixSignature } from './signature.ts';

/**
 * The keys a verifier trusts, by the name a signature is attributed to. Nix
 * keeps the first key it reads under a given name, so a list naming one twice
 * verifies against the first of them.
 */
export class NixTrustedKeys {
	/**
	 * The keys the given `<name>:<base64>` values name. A value that is not one
	 * names no key and verifies nothing, so it is left out: the remaining keys
	 * still decide whether a path is trusted.
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
	 * with at least one, so a document carrying signatures from keys this
	 * verifier does not know is decided by the ones it does.
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
 * The public half of a Nix secret key file, which holds the name and the
 * 64-byte Ed25519 secret whose last 32 bytes are the public key. A file that
 * is not one names no key.
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
		// A key or a signature the runtime will not read verifies nothing,
		// which is the same answer as one that does not match.
		return false;
	}
}
