import { bytesToBase64 } from './encoding.ts';
import {
	InvalidNixPublicKeyError,
	InvalidNixPublicKeySetError
} from './errors.ts';
import { NamedMaterial } from './named-material.ts';
import { type NixKeyName } from './scalars.ts';

/**
 * A Nix signing key's published half, rendered as `<name>:<base64>`. This is
 * the form `/pubkey` serves and a client lists in `trusted-public-keys`, so the
 * name a signature is attributed to and the material that verifies it always
 * travel together.
 */
export class NixPublicKey extends NamedMaterial {
	static of(name: NixKeyName, publicRaw: Uint8Array): NixPublicKey {
		return new NixPublicKey(`${name}:${bytesToBase64(publicRaw)}`);
	}

	constructor(value: string) {
		super(value, (invalid) => new InvalidNixPublicKeyError(invalid));

		if (
			this.bytes.byteLength !== 32 ||
			bytesToBase64(this.bytes) !== this.material
		) {
			throw new InvalidNixPublicKeyError(value);
		}
	}
}

/**
Parses the complete key rotation set published by a cache.
*/
export function parsePublishedNixPublicKeys(
	source: string
): readonly NixPublicKey[] {
	const values = source.split(/\s+/u).filter(Boolean);

	if (values.length === 0) {
		throw new InvalidNixPublicKeySetError('the response contains no keys');
	}

	const names = new Set<NixKeyName>();
	const keys: NixPublicKey[] = [];

	for (const [index, value] of values.entries()) {
		let key: NixPublicKey;

		try {
			key = new NixPublicKey(value);
		} catch (error) {
			if (error instanceof InvalidNixPublicKeyError) {
				throw new InvalidNixPublicKeySetError(
					`entry ${String(index + 1)} is not a canonical 32-byte Ed25519 public key`
				);
			}

			throw error;
		}

		if (names.has(key.name)) {
			throw new InvalidNixPublicKeySetError(
				`the key name ${key.name} appears more than once`
			);
		}

		names.add(key.name);
		keys.push(key);
	}

	return keys;
}
