export abstract class CliError extends Error {}

export class InvalidCacheNameError extends CliError {
	constructor(public readonly cache: string) {
		super(`Invalid cache name: ${cache}`);
		this.name = 'InvalidCacheNameError';
	}
}

export class InvalidCachePriorityError extends CliError {
	constructor(public readonly value: string) {
		super(`Invalid cache priority (expected a non-negative integer): ${value}`);
		this.name = 'InvalidCachePriorityError';
	}
}

export class InvalidPolicyScopeError extends CliError {
	constructor(public readonly value: string) {
		super(
			`Invalid policy scope (expected cache or root-name-prefix): ${value}`
		);
		this.name = 'InvalidPolicyScopeError';
	}
}

export class InvalidClaimError extends CliError {
	constructor(public readonly value: string) {
		super(`Invalid --claim (expected key=value): ${value}`);
		this.name = 'InvalidClaimError';
	}
}

export class OwnerLoginRequiredError extends CliError {
	constructor() {
		super('No cupboard session, or it has expired. Run `cupboard login`.');
		this.name = 'OwnerLoginRequiredError';
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
}

export class CupboardUploadError extends CliError {
	constructor(
		public readonly r2Key: string,
		public readonly status: number,
		public readonly body: string
	) {
		super(`Upload to ${r2Key} failed with ${String(status)}: ${body}`);
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

export class UploadVerificationFailedError extends CliError {
	constructor(
		public readonly uploadId: string,
		public readonly status: 'mismatch' | 'over-quota' | 'absent'
	) {
		super(`Upload ${uploadId} did not become servable: ${status}`);
		this.name = 'UploadVerificationFailedError';
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

export class AttestationsDisabledError extends CliError {
	constructor() {
		super('Cannot pass --attestation when attestation attachment is disabled');
		this.name = 'AttestationsDisabledError';
	}
}
