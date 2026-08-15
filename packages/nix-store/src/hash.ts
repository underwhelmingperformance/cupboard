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
const sha256DigestBytes = 32;

/**
A hash algorithm supported by Nix.
*/
export type NixHashAlgorithm = 'md5' | 'sha1' | 'sha256' | 'sha512';

/**
A hash parsed from a Nix value.
*/
export interface NixHash {
	readonly algorithm: NixHashAlgorithm;
	readonly bytes: Uint8Array;
}

interface NixHashSize {
	readonly algorithm: NixHashAlgorithm;
	readonly digestBytes: number;
}

// The supported hash algorithms and their digest sizes. Nix also supports
// `blake3` behind the blake3-hashes experimental feature, so the default build
// cannot read a value that specifies it.
function hashAlgorithm(name: string): NixHashSize | undefined {
	switch (name) {
		case 'md5': {
			return { algorithm: name, digestBytes: 16 };
		}
		case 'sha1': {
			return { algorithm: name, digestBytes: 20 };
		}
		case 'sha256': {
			return { algorithm: name, digestBytes: sha256DigestBytes };
		}
		case 'sha512': {
			return { algorithm: name, digestBytes: 64 };
		}
		default: {
			return undefined;
		}
	}
}

function base32Length(digestBytes: number): number {
	return Math.ceil((digestBytes * 8) / 5);
}

function base64Length(digestBytes: number): number {
	return 4 * Math.ceil(digestBytes / 3);
}

function decodeBase16(digest: string): Uint8Array | undefined {
	try {
		return hexToBytes(digest);
	} catch {
		return undefined;
	}
}

// A base64 string of the expected encoded length can still decode to more
// bytes than the algorithm's digest size.
function decodeBase64(
	digest: string,
	digestBytes: number
): Uint8Array | undefined {
	let bytes: Uint8Array;

	try {
		bytes = base64ToBytes(digest);
	} catch {
		return undefined;
	}

	return bytes.byteLength === digestBytes ? bytes : undefined;
}

/**
 * Decodes a digest by inferring its encoding from its length. Nix uses the
 * same rule to distinguish base16, Nix base32 and base64 when the value does
 * not specify an encoding.
 */
function decodeDigest(
	digest: string,
	digestBytes: number
): Uint8Array | undefined {
	if (digest.length === 2 * digestBytes) {
		return decodeBase16(digest);
	}

	if (digest.length === base32Length(digestBytes)) {
		return decodeNixBase32(digest, digestBytes);
	}

	if (digest.length === base64Length(digestBytes)) {
		return decodeBase64(digest, digestBytes);
	}

	return undefined;
}

/**
 * Decodes an `<algorithm>:<digest>` value, or returns `undefined` if Nix would
 * not recognise it. The algorithm precedes the colon, and the digest encoding
 * is inferred from its length.
 */
export function decodeNixHash(value: string): NixHash | undefined {
	const separator = value.indexOf(':');

	if (separator === -1) {
		return undefined;
	}

	return decodeNamedDigest(
		value.slice(0, separator),
		value.slice(separator + 1)
	);
}

/**
 * Decodes a narinfo hash field in either format written by Nix:
 * `<algorithm>:<digest>`, or the subresource integrity `<algorithm>-<base64>`.
 * An integrity value is always base64 and is read by the bytes it decodes to.
 */
export function decodeNixHashField(value: string): NixHash | undefined {
	if (value.includes(':')) {
		return decodeNixHash(value);
	}

	const separator = value.indexOf('-');

	if (separator === -1) {
		return undefined;
	}

	const named = hashAlgorithm(value.slice(0, separator));

	if (named === undefined) {
		return undefined;
	}

	const bytes = decodeBase64(value.slice(separator + 1), named.digestBytes);

	return bytes === undefined
		? undefined
		: { algorithm: named.algorithm, bytes };
}

function decodeNamedDigest(name: string, digest: string): NixHash | undefined {
	const named = hashAlgorithm(name);

	if (named === undefined) {
		return undefined;
	}

	const bytes = decodeDigest(digest, named.digestBytes);

	return bytes === undefined
		? undefined
		: { algorithm: named.algorithm, bytes };
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
		const hash = decodeNixHash(value);

		if (hash?.algorithm !== 'sha256') {
			throw new InvalidNixSha256HashError(value);
		}

		return this.fromDigest(hash.bytes);
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

	/**
	The raw digest as lowercase hex, the form an in-toto subject uses.
	*/
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
	const bytes = decodeNixBase32(value, sha256DigestBytes);

	if (bytes === undefined) {
		throw new InvalidNixSha256HashError(value);
	}

	return bytes;
}

/**
 * Decodes a Nix base32 digest of the specified size. Returns `undefined` if the
 * input has the wrong length or contains bits outside that digest size.
 */
function decodeNixBase32(
	value: string,
	digestBytes: number
): Uint8Array | undefined {
	if (value.length !== base32Length(digestBytes)) {
		return undefined;
	}

	const bytes = new Uint8Array(digestBytes);

	for (let position = 0; position < value.length; position += 1) {
		const digit = nixBase32Alphabet.indexOf(value.charAt(position));

		if (digit === -1) {
			return undefined;
		}

		const index = value.length - 1 - position;

		for (let bit = 0; bit < 5; bit += 1) {
			const sourceBit = index * 5 + bit;
			const bitValue = (digit >> bit) & 1;

			if (sourceBit >= bytes.byteLength * 8) {
				// The most-significant base32 digit spans beyond the digest. Canonical
				// encodings leave these overflow bits unset.
				if (bitValue === 1) {
					return undefined;
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
