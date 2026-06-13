// Process exit codes by failure category, so a script can tell a misuse from a
// missing session from a transient outage. The values follow the BSD sysexits
// convention where one exists (77 EX_NOPERM, 75 EX_TEMPFAIL); 2 is the usual
// shell convention for a usage error, and 1 is the catch-all.
export const genericExitCode = 1;
export const usageExitCode = 2;
export const authExitCode = 77;
export const transientExitCode = 75;

export abstract class CliError extends Error {
	/** The process exit code this failure should produce. */
	get exitCode(): number {
		return genericExitCode;
	}
}

/** A misuse of the CLI: a bad flag value or an unsupported combination. */
export abstract class CliUsageError extends CliError {
	override get exitCode(): number {
		return usageExitCode;
	}
}

export class CliAbortError extends CliError {
	constructor() {
		super('Aborted');
		this.name = 'CliAbortError';
	}
}

export class InvalidCacheNameError extends CliUsageError {
	constructor(public readonly cache: string) {
		super(`Invalid cache name: ${cache}`);
		this.name = 'InvalidCacheNameError';
	}
}

export class InvalidCachePriorityError extends CliUsageError {
	constructor(public readonly value: string) {
		super(`Invalid cache priority (expected a non-negative integer): ${value}`);
		this.name = 'InvalidCachePriorityError';
	}
}

export class InvalidPolicyScopeError extends CliUsageError {
	constructor(public readonly value: string) {
		super(
			`Invalid policy scope (expected cache or root-name-prefix): ${value}`
		);
		this.name = 'InvalidPolicyScopeError';
	}
}

export class InvalidClaimError extends CliUsageError {
	constructor(public readonly value: string) {
		super(`Invalid --claim (expected key=value): ${value}`);
		this.name = 'InvalidClaimError';
	}
}

export class InvalidWorkerUrlError extends CliUsageError {
	constructor(public readonly value: string) {
		super(
			`Invalid Worker URL: ${value}. ` +
				'Expected a URL like https://cupboard.example.workers.dev.'
		);
		this.name = 'InvalidWorkerUrlError';
	}
}

export class UnreachableHostError extends CliError {
	constructor(
		public readonly host: string,
		cause: Error
	) {
		const underlying = cause.cause;
		const detail =
			underlying instanceof Error ? underlying.message : cause.message;

		super(`Could not reach ${host}: ${detail}`);
		this.name = 'UnreachableHostError';
		this.cause = cause;
	}

	override get exitCode(): number {
		return transientExitCode;
	}
}

export class OwnerLoginRequiredError extends CliError {
	constructor() {
		super('No cupboard session, or it has expired. Run `cupboard login`.');
		this.name = 'OwnerLoginRequiredError';
	}

	override get exitCode(): number {
		return authExitCode;
	}
}

export class SessionRejectedError extends CliError {
	constructor() {
		super(
			'The server refused your session; it may have expired. ' +
				'Run `cupboard login <url>` to sign in again.'
		);
		this.name = 'SessionRejectedError';
	}

	override get exitCode(): number {
		return authExitCode;
	}
}

export class ScopeForbiddenError extends CliError {
	constructor() {
		super(
			'Your token lacks the scope this command needs. A tenant command ' +
				"needs that tenant's admin token; a control-plane command (tenant, " +
				'control-key) needs the operator token.'
		);
		this.name = 'ScopeForbiddenError';
	}

	override get exitCode(): number {
		return authExitCode;
	}
}

export class QuotaExceededError extends CliError {
	constructor(detail: string) {
		const explanation =
			detail === '' ? 'The cache is over its storage quota.' : detail;

		super(
			`${explanation} Free space by deleting unused paths or raise the quota.`
		);
		this.name = 'QuotaExceededError';
	}
}

export class CupboardHttpError extends CliError {
	constructor(
		public readonly method: string,
		public readonly path: string,
		public readonly status: number,
		public readonly body: string
	) {
		super(`${method} ${path} failed with ${String(status)}: ${body}`);
		this.name = 'CupboardHttpError';
	}

	override get exitCode(): number {
		if (this.status === 401 || this.status === 403) {
			return authExitCode;
		}

		if (this.status === 408 || this.status === 429 || this.status >= 500) {
			return transientExitCode;
		}

		return genericExitCode;
	}
}

export class CupboardUploadError extends CliError {
	constructor(
		public readonly r2Key: string,
		public readonly status: number,
		public readonly body: string
	) {
		super(`Uploading a NAR failed (HTTP ${String(status)}): ${body}`);
		this.name = 'CupboardUploadError';
	}
}

export class PushNarMetadataMismatchError extends CliError {
	constructor(
		public readonly storePath: string,
		public readonly expectedNarHash: string,
		public readonly actualNarHash: string,
		public readonly expectedNarSize: number,
		public readonly actualNarSize: number
	) {
		super(
			`Computed NAR metadata does not match local Nix metadata: ${storePath}`
		);
		this.name = 'PushNarMetadataMismatchError';
	}
}

export abstract class CupboardResponseError extends CliError {
	protected constructor(
		public readonly path: string,
		message: string
	) {
		super(message);
	}
}

export class MalformedResponseError extends CupboardResponseError {
	constructor(
		path: string,
		public override readonly cause: SyntaxError
	) {
		super(path, `Response from ${path} was not valid JSON`);
		this.name = 'MalformedResponseError';
	}
}

export class ResponseSchemaMismatchError extends CupboardResponseError {
	constructor(
		path: string,
		public readonly issues: string
	) {
		super(
			path,
			`Response from ${path} did not match the expected schema:\n${issues}`
		);
		this.name = 'ResponseSchemaMismatchError';
	}
}

export class UnexpectedUploadDecisionError extends CliError {
	constructor(
		public readonly storePathHash: string,
		public readonly narHash: string
	) {
		super(
			`Upload decision did not match a prepared path: ${storePathHash} ${narHash}`
		);
		this.name = 'UnexpectedUploadDecisionError';
	}
}

export type UploadVerificationStatus = 'mismatch' | 'over-quota' | 'absent';

export class UploadVerificationFailedError extends CliError {
	constructor(
		public readonly uploadId: string,
		public readonly status: UploadVerificationStatus
	) {
		super(uploadVerificationMessage(status));
		this.name = 'UploadVerificationFailedError';
	}
}

function uploadVerificationMessage(status: UploadVerificationStatus): string {
	switch (status) {
		case 'mismatch': {
			return 'An uploaded NAR did not match the hash it declared. Re-run cupboard push to retry.';
		}

		case 'over-quota': {
			return 'The cache is over its storage quota. Free space by deleting unused paths or raise the quota.';
		}

		case 'absent': {
			return 'An uploaded NAR was not stored. Re-run cupboard push to retry.';
		}
	}
}

export class CommitSocketProtocolError extends CliError {
	constructor(
		public readonly path: string,
		public readonly detail: string
	) {
		super(`Commit over ${path} broke protocol: ${detail}`);
		this.name = 'CommitSocketProtocolError';
	}
}

export class UploadWaitTimeoutError extends CliError {
	constructor(
		public readonly pending: number,
		public readonly timeoutSeconds: number
	) {
		super(
			`Timed out after ${String(timeoutSeconds)}s waiting for ${String(pending)} upload(s) to become servable`
		);
		this.name = 'UploadWaitTimeoutError';
	}

	override get exitCode(): number {
		return transientExitCode;
	}
}

export class AttestationBundleInvalidError extends CliError {
	constructor(
		public readonly path: string,
		detail = 'expected a Sigstore DSSE bundle with an in-toto statement'
	) {
		super(`Invalid attestation bundle ${path}: ${detail}`);
		this.name = 'AttestationBundleInvalidError';
	}
}

export class AttestationSubjectNotPushedError extends CliError {
	constructor(
		public readonly path: string,
		public readonly subjectDigests: readonly string[]
	) {
		super(
			`Attestation bundle ${path} does not describe any path in the pushed closure`
		);
		this.name = 'AttestationSubjectNotPushedError';
	}
}

export class AttestationUploadUnavailableError extends CliError {
	constructor(public readonly method: string) {
		super(`Push client does not support attestation uploads: ${method}`);
		this.name = 'AttestationUploadUnavailableError';
	}
}

export class UnexpectedAttestationDecisionError extends CliError {
	constructor(
		public readonly storePathHash: string,
		public readonly digest: string
	) {
		super(
			`Attestation decision did not match a prepared bundle: ${storePathHash} ${digest}`
		);
		this.name = 'UnexpectedAttestationDecisionError';
	}
}

export class AttestationsDisabledError extends CliUsageError {
	constructor() {
		super('Cannot pass --attestation when attestation attachment is disabled');
		this.name = 'AttestationsDisabledError';
	}
}
