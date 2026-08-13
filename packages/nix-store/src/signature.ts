import { bytesToBase64 } from './encoding.ts';
import { InvalidNixSignatureError } from './errors.ts';
import { NamedMaterial, parseNamedMaterial } from './named-material.ts';
import { type NixKeyName } from './scalars.ts';

/**
 * A narinfo `Sig` entry, rendered as `<name>:<base64>`: the detached signature
 * over a path's fingerprint, labelled with the name of the key that produced
 * it. A verifier trusts a set of named keys, so the name decides which key a
 * signature is checked against.
 */
export class NixSignature extends NamedMaterial {
	/** The signature a named key produced over a fingerprint. */
	static of(name: NixKeyName, signature: Uint8Array): NixSignature {
		return new NixSignature(`${name}:${bytesToBase64(signature)}`);
	}

	/**
	 * The well-formed signatures among a narinfo's `Sig` lines. A narinfo is
	 * signed by whoever served it, so an entry that is not `<name>:<base64>` is
	 * dropped: it names no key and verifies nothing, and the remaining entries
	 * still decide whether the path is trusted.
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
 * Whether the value is a signature Nix reads: a key name, a colon, and base64
 * material that decodes. Nix refuses a whole narinfo over a `Sig` line it
 * cannot read, so a reader deciding what a substituter holds reads a line the
 * same way a verifier does.
 */
export function isNixSignature(value: string): boolean {
	return parseNamedMaterial(value) !== undefined;
}
