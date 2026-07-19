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

/** Builds `Error`'s options bag, omitting `cause` entirely when none was given. */
function withCause(cause: unknown): ErrorOptions | undefined {
	return cause === undefined ? undefined : { cause };
}

export interface GithubApiErrorOptions {
	readonly status?: number;
	readonly cause?: unknown;
}

export class GithubApiError extends CodedError {
	readonly status: number | undefined;

	constructor(operation: string, options: GithubApiErrorOptions = {}) {
		super(
			`${operation}: ${options.status === undefined ? 'an unknown error' : String(options.status)}`,
			withCause(options.cause)
		);
		this.name = 'GithubApiError';
		this.status = options.status;
	}
}

export class MalformedReleaseResponseError extends CodedError {
	constructor(options: { readonly cause?: unknown } = {}) {
		super(
			'the GitHub release API returned an unexpected response',
			withCause(options.cause)
		);
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

export class InvalidChecksumLineError extends CodedError {
	constructor(public readonly line: string) {
		super(`invalid checksum line: ${line}`);
		this.name = 'InvalidChecksumLineError';
	}
}

export class MissingChecksumError extends CodedError {
	constructor(public readonly assetName: string) {
		super(`checksums.txt does not contain ${assetName}`);
		this.name = 'MissingChecksumError';
	}
}

export class ChecksumMismatchError extends CodedError {
	constructor(
		public readonly assetName: string,
		public readonly expected: string,
		public readonly actual: string
	) {
		super(
			`checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`
		);
		this.name = 'ChecksumMismatchError';
	}
}

export class AttestationNotFoundError extends CodedError {
	constructor(public readonly archiveName: string) {
		super(`no attestation was found for ${archiveName}`);
		this.name = 'AttestationNotFoundError';
	}
}

/**
 * Every published bundle failed verification. `cause` carries the last
 * bundle's failure; earlier attempts may have failed for other reasons.
 */
export class AttestationVerificationFailedError extends CodedError {
	constructor(
		public readonly archiveName: string,
		public readonly attempts: number,
		options: { readonly cause?: unknown } = {}
	) {
		super(
			`could not verify the attestation for ${archiveName} after ${String(attempts)} attempt(s)`,
			withCause(options.cause)
		);
		this.name = 'AttestationVerificationFailedError';
	}
}

export class AttestationSourceMismatchError extends CodedError {
	constructor(
		public readonly tagName: string,
		public readonly tagCommit: string,
		public readonly sourceCommit: string | undefined
	) {
		super(
			`built from ${String(sourceCommit)}, but tag ${tagName} points at ${tagCommit}`
		);
		this.name = 'AttestationSourceMismatchError';
	}
}

export class CachePublicKeyRequestFailedError extends CodedError {
	constructor(
		public readonly url: string,
		public readonly status: number
	) {
		super(`failed to fetch cache public key: ${String(status)}`);
		this.name = 'CachePublicKeyRequestFailedError';
	}
}

export class CachePublicKeyEmptyResponseError extends CodedError {
	constructor(public readonly url: string) {
		super('cache public key response was empty');
		this.name = 'CachePublicKeyEmptyResponseError';
	}
}

export class CommandFailedError extends CodedError {
	constructor(
		public readonly command: string,
		public readonly status: number | null,
		detail?: string,
		options: { readonly cause?: unknown } = {}
	) {
		super(
			detail === undefined
				? `${command} failed with status ${String(status)}`
				: `${command} could not run: ${detail}`,
			withCause(options.cause)
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
