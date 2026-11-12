import { bytesToBase64 } from './encoding.ts';
import { InvalidNixSignatureError } from './errors.ts';
import { NamedMaterial, parseNamedMaterial } from './named-material.ts';
import { type NixKeyName } from './scalars.ts';

/**
A narinfo `Sig` entry containing a key name and a base64-encoded detached
signature over the path fingerprint. The key name selects the trusted key
used for verification.
*/
export class NixSignature extends NamedMaterial {
	static of(name: NixKeyName, signature: Uint8Array): NixSignature {
		return new NixSignature(`${name}:${bytesToBase64(signature)}`);
	}

	/**
	The well-formed signatures among a narinfo's `Sig` lines. Malformed entries
	are ignored. The remaining signatures still determine whether the path is
	trusted.
	*/
	static parseAll(values: readonly string[]): readonly NixSignature[] {
		return values
			.filter((value) => isNixSignature(value))
			.map((value) => new NixSignature(value));
	}

	constructor(value: string) {
		super(value, (invalid) => new InvalidNixSignatureError(invalid));
	}
}

/**
Whether Nix can parse the value as a key name, a colon and base64 signature
material. The narinfo reader and verifier use the same validation because
Nix rejects an entire narinfo when a `Sig` line is malformed.
*/
export function isNixSignature(value: string): boolean {
	return parseNamedMaterial(value) !== undefined;
}

/**
The value written in canonical form, or `undefined` when it is not a signature.
Nix keeps a narinfo's signatures in a set of the key name and the decoded
signature, and prints each one as the key name and padded base64. Two `Sig`
lines are the same signature when they have the same canonical form, even if
one of them leaves out the base64 padding.
*/
export function canonicalNixSignature(value: string): string | undefined {
	const parsed = parseNamedMaterial(value);

	return parsed === undefined
		? undefined
		: NixSignature.of(parsed.name, parsed.bytes).value;
}
