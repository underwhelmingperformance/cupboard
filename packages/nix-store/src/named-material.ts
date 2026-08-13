import { base64ToBytes } from './encoding.ts';
import { type ProtocolError } from './errors.ts';
import { type NixKeyName, nixKeyNameSchema } from './scalars.ts';

/** The two halves of a `<name>:<base64>` value, with the material decoded. */
export interface NamedMaterialParts {
	readonly name: NixKeyName;
	readonly material: string;
	readonly bytes: Uint8Array;
}

/**
 * Parses a Nix `<name>:<base64>` value, or returns `undefined` when the value is
 * malformed. Callers that require a value construct the relevant domain type,
 * which reports a typed error instead.
 */
export function parseNamedMaterial(
	value: string
): NamedMaterialParts | undefined {
	const separator = value.indexOf(':');

	if (separator === -1) {
		return undefined;
	}

	const name = nixKeyNameSchema.safeParse(value.slice(0, separator));
	const material = value.slice(separator + 1);

	if (material === '' || !name.success) {
		return undefined;
	}

	const bytes = decodeMaterial(material);

	if (bytes === undefined) {
		return undefined;
	}

	return { name: name.data, material, bytes };
}

/**
 * A Nix `<name>:<base64>` value containing a signing key name and binary
 * material. Public keys and narinfo signatures use this format so a verifier
 * can select the key identified by a signature.
 */
export abstract class NamedMaterial {
	readonly value: string;
	readonly name: NixKeyName;
	readonly material: string;
	readonly bytes: Uint8Array;

	// Valid by construction: both halves are parsed and the material is decoded
	// up front, so an instance always contains a name alongside bytes that a
	// verifier can use. Subclasses supply the error their own format raises.
	protected constructor(
		value: string,
		malformed: (value: string) => ProtocolError
	) {
		const parsed = parseNamedMaterial(value);

		if (parsed === undefined) {
			throw malformed(value);
		}

		this.value = value;
		this.name = parsed.name;
		this.material = parsed.material;
		this.bytes = parsed.bytes;
	}

	toString(): string {
		return this.value;
	}
}

// `atob` throws on material that is not base64, so the decode is the check.
// Anything it refuses could never verify anything. It reads past whitespace,
// which rendered values never contain and Nix's own decoder refuses, so the
// material has to be whitespace-free to be material at all.
function decodeMaterial(material: string): Uint8Array | undefined {
	if (/\s/u.test(material)) {
		return undefined;
	}

	try {
		return base64ToBytes(material);
	} catch {
		return undefined;
	}
}
