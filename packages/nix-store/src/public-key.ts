import { bytesToBase64 } from './encoding.ts';
import { InvalidNixPublicKeyError } from './errors.ts';
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
	}
}
