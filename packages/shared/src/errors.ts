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

export class InvalidStorePathBasenameError extends ProtocolError {
	constructor(public readonly basename: string) {
		super(`Invalid store path basename: ${basename}`);
		this.name = 'InvalidStorePathBasenameError';
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

// Raised when a zstd stream cannot be decoded because its bytes are not a valid
// frame — distinct from an error reading the underlying source. The server treats
// this as a definitive verification failure (the bytes can never decode to the
// claimed hash), not a transient fault to retry.
export class ZstdDecodeError extends Error {
	constructor(options?: { readonly cause?: unknown }) {
		super('Failed to decode zstd stream', options);
		this.name = 'ZstdDecodeError';
	}
}
