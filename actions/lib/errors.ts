import { CodedError, UsageError } from '@cupboard/shared/errors';

export class MissingInputError extends UsageError {
	constructor(public readonly input: string) {
		super(`${input} is required`);
		this.name = 'MissingInputError';
	}
}

export class InvalidInputError extends UsageError {
	constructor(
		public readonly input: string,
		message: string
	) {
		super(message);
		this.name = 'InvalidInputError';
	}
}

export class UnsupportedPlatformError extends UsageError {
	constructor(
		public readonly runtimePlatform: string,
		public readonly runtimeArch: string
	) {
		super(`unsupported release platform: ${runtimePlatform}-${runtimeArch}`);
		this.name = 'UnsupportedPlatformError';
	}
}

export class UnknownCommandError extends UsageError {
	constructor(public readonly command: string) {
		super(`expected setup, push or attest, got '${command}'`);
		this.name = 'UnknownCommandError';
	}
}

export class GithubApiError extends CodedError {
	constructor(message: string) {
		super(message);
		this.name = 'GithubApiError';
	}
}

export class MalformedResponseError extends CodedError {
	constructor(message: string) {
		super(message);
		this.name = 'MalformedResponseError';
	}
}

export class ChecksumError extends CodedError {
	constructor(message: string) {
		super(message);
		this.name = 'ChecksumError';
	}
}

export class AttestationError extends CodedError {
	constructor(message: string) {
		super(message);
		this.name = 'AttestationError';
	}
}

export class NixError extends CodedError {
	constructor(message: string) {
		super(message);
		this.name = 'NixError';
	}
}

export class CommandFailedError extends CodedError {
	constructor(
		public readonly command: string,
		public readonly status: number | null
	) {
		super(`${command} failed with status ${String(status)}`);
		this.name = 'CommandFailedError';
	}
}
