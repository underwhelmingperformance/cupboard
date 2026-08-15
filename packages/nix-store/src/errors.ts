import type { StorePathString } from './scalars.ts';

export abstract class ProtocolError extends Error {}

export class MalformedNarInfoLineError extends ProtocolError {
	constructor(public readonly line: string) {
		super(`Malformed narinfo line: ${line}`);
		this.name = 'MalformedNarInfoLineError';
	}
}

/**
 * A narinfo that is missing a field required by Nix. The reader rejects the
 * entire document as corrupt.
 */
export class CorruptNarInfoError extends ProtocolError {
	constructor(public readonly storePath: StorePathString) {
		super(`The narinfo served for ${storePath} is missing required fields`);
		this.name = 'CorruptNarInfoError';
	}
}

/**
A narinfo that describes a path other than the requested path.
*/
export class MismatchedNarInfoPathError extends ProtocolError {
	constructor(public readonly storePath: StorePathString) {
		super(`The narinfo served does not describe ${storePath}`);
		this.name = 'MismatchedNarInfoPathError';
	}
}

export class InvalidStorePathError extends ProtocolError {
	constructor(public readonly storePath: string) {
		super(`Invalid store path: ${storePath}`);
		this.name = 'InvalidStorePathError';
	}
}

export class InvalidNixSha256HashError extends ProtocolError {
	constructor(public readonly value: string) {
		super(`Invalid Nix SHA-256 hash: ${value}`);
		this.name = 'InvalidNixSha256HashError';
	}
}

export class InvalidSha256DigestLengthError extends ProtocolError {
	constructor(public readonly length: number) {
		super(`Invalid SHA-256 digest length: ${String(length)}`);
		this.name = 'InvalidSha256DigestLengthError';
	}
}

// A cache or view name that cannot form a whole URL path segment: the empty
// string, `.` or `..` would collapse or climb the path rather than address a
// child of the cache base.
export class InvalidCacheUrlSegmentError extends ProtocolError {
	constructor(public readonly segment: string) {
		super(`Invalid cache URL segment: ${segment}`);
		this.name = 'InvalidCacheUrlSegmentError';
	}
}

// A base URL with credentials, a query or a fragment. The URL builders use only
// the origin and path, so accepting these components would silently discard or
// misdirect them.
export class InvalidCacheUrlBaseError extends ProtocolError {
	constructor() {
		super('Cache base URL must contain only an origin and path');
		this.name = 'InvalidCacheUrlBaseError';
	}
}

// A rendered Nix public key that is not `<name>:<base64>`. Both halves are
// required: the name identifies the signer, and the decoded material contains
// the public key used for verification.
export class InvalidNixPublicKeyError extends ProtocolError {
	constructor(public readonly value: string) {
		super(`Invalid Nix public key: ${value}`);
		this.name = 'InvalidNixPublicKeyError';
	}
}

// A narinfo signature that is not `<name>:<base64>`. Both halves are required:
// the name selects the key the signature is checked against, and the material
// is the detached signature itself.
export class InvalidNixSignatureError extends ProtocolError {
	constructor(public readonly value: string) {
		super(`Invalid Nix signature: ${value}`);
		this.name = 'InvalidNixSignatureError';
	}
}

// A netrc credential carrying a control character, which no quoting can encode
// into a single netrc token.
export class NetrcControlCharacterError extends ProtocolError {
	constructor() {
		super('Netrc credentials must not contain control characters');
		this.name = 'NetrcControlCharacterError';
	}
}

// A nix-cache-info document missing or mis-typing one of its fields. `field`
// names the first field that failed, so a consumer that must not guess a
// default, such as one comparing priorities, can report which field was wrong.
export class CacheInfoParseError extends ProtocolError {
	constructor(public readonly field: string) {
		super(`Invalid nix-cache-info: ${field}`);
		this.name = 'CacheInfoParseError';
	}
}

// A derivation whose ATerm cannot be read. `reason` names what was wrong at
// the point the read stopped, so a caller can tell a term in an unsupported
// shape from bytes that are not a derivation at all.
export class MalformedDerivationError extends ProtocolError {
	constructor(public readonly reason: string) {
		super(`Malformed derivation: ${reason}`);
		this.name = 'MalformedDerivationError';
	}
}

// Raised when a zstd stream cannot be decoded because its bytes are not a valid
// frame, distinct from an error reading the underlying source. The server treats
// this as a definitive verification failure (the bytes can never decode to the
// claimed hash), not a transient fault to retry.
export class ZstdDecodeError extends Error {
	constructor(options?: { readonly cause?: unknown }) {
		super('Failed to decode zstd stream', options);
		this.name = 'ZstdDecodeError';
	}
}
