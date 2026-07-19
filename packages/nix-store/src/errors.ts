export abstract class ProtocolError extends Error {}

export class MalformedNarInfoLineError extends ProtocolError {
	constructor(public readonly line: string) {
		super(`Malformed narinfo line: ${line}`);
		this.name = 'MalformedNarInfoLineError';
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

// A base URL carrying credentials, a query or a fragment: the builders derive
// their results from origin and path alone, so honouring such a base would
// silently drop or missend what it carries.
export class InvalidCacheUrlBaseError extends ProtocolError {
	constructor() {
		super('Cache base URL must carry nothing beyond origin and path');
		this.name = 'InvalidCacheUrlBaseError';
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
// default (a priority comparison, say) can report exactly what was absent.
export class CacheInfoParseError extends ProtocolError {
	constructor(public readonly field: string) {
		super(`Invalid nix-cache-info: ${field}`);
		this.name = 'CacheInfoParseError';
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
