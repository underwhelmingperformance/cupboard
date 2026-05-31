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
