import {
	CodedError,
	genericExitCode,
	UsageError
} from '@cupboard/shared/errors';

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

export class MalformedReleaseResponseError extends CodedError {
	constructor() {
		super('the GitHub release API returned an unexpected response');
		this.name = 'MalformedReleaseResponseError';
	}
}

export class NoReleaseFoundError extends CodedError {
	constructor(public readonly releaseRepository: string) {
		super(`no published release was found in ${releaseRepository}`);
		this.name = 'NoReleaseFoundError';
	}
}

export class ReleaseAssetNotFoundError extends CodedError {
	constructor(
		public readonly tag: string,
		public readonly assetName: string
	) {
		super(`release ${tag} has no ${assetName} asset`);
		this.name = 'ReleaseAssetNotFoundError';
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

export class CachePublicKeyError extends CodedError {
	constructor(message: string) {
		super(message);
		this.name = 'CachePublicKeyError';
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
		public readonly status: number | null,
		detail?: string
	) {
		super(
			detail === undefined
				? `${command} failed with status ${String(status)}`
				: `${command} could not run: ${detail}`
		);
		this.name = 'CommandFailedError';
	}
}

/**
 * A failure the cupboard binary reported through its own event stream, carrying
 * the message and exit code it named so the entry point annotates them.
 */
export class CupboardReportedError extends CodedError {
	constructor(
		message: string,
		public readonly status: number | null
	) {
		super(message);
		this.name = 'CupboardReportedError';
	}

	override get exitCode(): number {
		return this.status ?? genericExitCode;
	}
}
