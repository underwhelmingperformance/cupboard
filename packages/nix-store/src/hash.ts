import {
	base64ToBytes,
	bytesToBase64,
	bytesToHex,
	hexToBytes
} from './encoding.ts';
import {
	InvalidNixSha256HashError,
	InvalidSha256DigestLengthError
} from './errors.ts';
import {
	nixSha256HashSchema,
	type NixSha256HashString,
	type Sha256HexDigest,
	sha256HexDigestSchema
} from './scalars.ts';

const nixBase32Alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
const nixSha256Base32Length = 52;
const sha256HexLength = 64;
const sha256Prefix = 'sha256:';

function decodeDigest(digest: string): Uint8Array {
	if (digest.length === sha256HexLength) {
		return hexToBytes(digest);
	}

	if (digest.length === nixSha256Base32Length) {
		return fromNixBase32(digest);
	}

	return base64ToBytes(digest);
}

export class NixSha256Hash {
	static parse(value: string): NixSha256Hash {
		const parsed = nixSha256HashSchema.safeParse(value);

		if (!parsed.success) {
			throw new InvalidNixSha256HashError(value);
		}

		return new NixSha256Hash(
			parsed.data,
			fromNixBase32(parsed.data.slice('sha256:'.length))
		);
	}

	/**
	 * Parse a `sha256:`-prefixed digest in any of the encodings Nix writes, the
	 * way `Hash::parseAnyPrefixed` does: the digest is base16 when it is 64
	 * characters, Nix base32 when it is 52, and otherwise base64. The Nix store
	 * database records NAR hashes in this `sha256:<base16>` form.
	 */
	static parsePrefixed(value: string): NixSha256Hash {
		if (!value.startsWith(sha256Prefix)) {
			throw new InvalidNixSha256HashError(value);
		}

		const digest = value.slice(sha256Prefix.length);

		try {
			return this.fromDigest(decodeDigest(digest));
		} catch (error) {
			if (error instanceof InvalidNixSha256HashError) {
				throw error;
			}

			throw new InvalidNixSha256HashError(value);
		}
	}

	static fromDigest(bytes: Uint8Array): NixSha256Hash {
		if (bytes.byteLength !== 32) {
			throw new InvalidSha256DigestLengthError(bytes.byteLength);
		}

		const digest = Uint8Array.from(bytes);

		return new NixSha256Hash(
			nixSha256HashSchema.parse(`sha256:${toNixBase32(digest)}`),
			digest
		);
	}

	private constructor(
		public readonly value: NixSha256HashString,
		private readonly bytes: Uint8Array
	) {}

	digestBytes(): Uint8Array {
		return Uint8Array.from(this.bytes);
	}

	digestBase64(): string {
		return bytesToBase64(this.bytes);
	}

	/** The raw digest as lowercase hex, the form an in-toto subject uses. */
	digestHex(): Sha256HexDigest {
		return sha256HexDigestSchema.parse(bytesToHex(this.bytes));
	}

	toString(): NixSha256HashString {
		return this.value;
	}

	/**
	 * The hash as a single URL path segment, with the `sha256:` prefix's colon
	 * percent-encoded. A Nix client requests a NAR over HTTP at this spelling.
	 */
	toUrlSegment(): string {
		return encodeURIComponent(this.value);
	}
}

export function toNixSha256(bytes: Uint8Array): NixSha256Hash {
	return NixSha256Hash.fromDigest(bytes);
}

export function toNixBase32(bytes: Uint8Array): string {
	let encoded = '';
	const encodedLength = Math.ceil((bytes.byteLength * 8) / 5);

	for (let index = encodedLength - 1; index >= 0; index -= 1) {
		let digit = 0;

		for (let bit = 0; bit < 5; bit += 1) {
			const sourceBit = index * 5 + bit;

			if (sourceBit < bytes.byteLength * 8) {
				const sourceByte = bytes[Math.floor(sourceBit / 8)] ?? 0;
				digit |= ((sourceByte >> (sourceBit % 8)) & 1) << bit;
			}
		}

		encoded += nixBase32Alphabet[digit] ?? '';
	}

	return encoded;
}

export function fromNixBase32(value: string): Uint8Array {
	// A SHA-256 digest is exactly 52 Nix base32 characters; reject anything else
	// so a short input cannot decode to a zeroed digest nor a long one silently
	// drop its leading bits.
	if (value.length !== nixSha256Base32Length) {
		throw new InvalidNixSha256HashError(value);
	}

	const bytes = new Uint8Array(32);

	for (let position = 0; position < value.length; position += 1) {
		const digit = nixBase32Alphabet.indexOf(value.charAt(position));

		if (digit === -1) {
			throw new InvalidNixSha256HashError(value);
		}

		const index = value.length - 1 - position;

		for (let bit = 0; bit < 5; bit += 1) {
			const sourceBit = index * 5 + bit;
			const bitValue = (digit >> bit) & 1;

			if (sourceBit >= bytes.byteLength * 8) {
				// The most-significant base32 digit spans more bits than a 256-bit
				// digest holds. A canonical encoding leaves those overflow bits zero,
				// so a value that sets them is rejected.
				if (bitValue === 1) {
					throw new InvalidNixSha256HashError(value);
				}
			} else {
				const byteIndex = Math.floor(sourceBit / 8);
				bytes[byteIndex] =
					(bytes[byteIndex] ?? 0) | (bitValue << (sourceBit % 8));
			}
		}
	}

	return bytes;
}
