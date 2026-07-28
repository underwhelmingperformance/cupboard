import { bytesToBase64 } from './encoding.ts';
import { InvalidNixPublicKeyError } from './errors.ts';
import { type NixKeyName, nixKeyNameSchema } from './scalars.ts';

/**
 * A Nix signing key's published half, rendered as `<name>:<base64>`. This is
 * the form `/pubkey` serves and a client lists in `trusted-public-keys`, so the
 * name a signature is attributed to and the material that verifies it always
 * travel together.
 */
export class NixPublicKey {
	/** The published key for a signing key's name and its raw public bytes. */
	static of(name: NixKeyName, publicRaw: Uint8Array): NixPublicKey {
		return new NixPublicKey(`${name}:${bytesToBase64(publicRaw)}`);
	}

	readonly value: string;
	readonly name: NixKeyName;
	readonly material: string;

	// A `NixPublicKey` is valid by construction: it parses both halves up front
	// and rejects anything that is not `<name>:<base64>`, so an instance can
	// never attribute a signature to a name the rendered key does not carry.
	constructor(value: string) {
		const separator = value.indexOf(':');

		if (separator === -1) {
			throw new InvalidNixPublicKeyError(value);
		}

		const name = nixKeyNameSchema.safeParse(value.slice(0, separator));
		const material = value.slice(separator + 1);

		if (material === '' || !name.success) {
			throw new InvalidNixPublicKeyError(value);
		}

		this.value = value;
		this.name = name.data;
		this.material = material;
	}

	toString(): string {
		return this.value;
	}
}
