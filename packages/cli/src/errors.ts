import {
	CodedError,
	genericExitCode,
	usageExitCode
} from '@cupboard/shared/errors';
import { z } from 'zod';

// The CLI's own failure categories, layered on the shared generic (1) and usage
// (2) codes. The values follow the BSD sysexits convention (77 EX_NOPERM, 75
// EX_TEMPFAIL, 69 EX_UNAVAILABLE, 74 EX_IOERR).
export const authExitCode = 77;
export const transientExitCode = 75;
export const unavailableExitCode = 69;
// A publication failure with no more specific category: a transfer that did
// not complete. Only build-push uses it, so retry systems branching on its
// numeric contract never see a bare 1 for a lost upload.
export const publicationExitCode = 74;

export abstract class CliError extends CodedError {}

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

export class InvalidRootNameError extends CliUsageError {
	constructor(public readonly value: string) {
		super(`Invalid root name: ${value}`);
		this.name = 'InvalidRootNameError';
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

export class InvalidAudienceError extends CliUsageError {
	constructor(public readonly value: string) {
		super(`Invalid --audience (expected a non-empty string): ${value}`);
		this.name = 'InvalidAudienceError';
	}
}

// A Basic credential is `user:password` split on its first colon, so a read user
// carrying one could never be read back from the header a reader presents.
export class InvalidReadUserError extends CliUsageError {
	constructor(public readonly value: string) {
		super(
			`Invalid read user (expected a non-empty string with no colon): ${value}`
		);
		this.name = 'InvalidReadUserError';
	}
}

export class InvalidStoreUriError extends CliUsageError {
	constructor(public readonly value: string) {
		super(
			`Invalid --store (expected an ssh-ng:// URI naming a destination): ${value}`
		);
		this.name = 'InvalidStoreUriError';
	}
}

export class InvalidClaimError extends CliUsageError {
	constructor(public readonly value: string) {
		super(`Invalid --claim (expected key=value): ${value}`);
		this.name = 'InvalidClaimError';
	}
}

export class InvalidUploadConcurrencyError extends CliUsageError {
	constructor(public readonly value: string) {
		super(
			`Invalid --upload-concurrency (expected a positive integer): ${value}`
		);
		this.name = 'InvalidUploadConcurrencyError';
	}
}

export class InvalidCohortTargetsFileError extends CliUsageError {
	constructor(
		public readonly path: string,
		detail: string
	) {
		super(`Invalid cohort targets file ${path}: ${detail}`);
		this.name = 'InvalidCohortTargetsFileError';
	}
}

export class InvalidDurationError extends CliUsageError {
	constructor(public readonly value: string) {
		super(
			`Invalid duration (expected a value like "7d", "12h" or "30m", units s, m, h, d, w): ${value}`
		);
		this.name = 'InvalidDurationError';
	}
}

export class InvalidTtlError extends CliUsageError {
	constructor(
		public readonly value: string,
		public readonly minSeconds: number,
		public readonly maxSeconds: number
	) {
		super(
			`TTL must be between ${String(minSeconds)} and ${String(maxSeconds)} seconds: ${value}`
		);
		this.name = 'InvalidTtlError';
	}
}

export class InvalidGraceError extends CliUsageError {
	constructor(
		public readonly value: string,
		public readonly maxSeconds: number
	) {
		super(
			`Grace must be between 0 and ${String(maxSeconds)} seconds: ${value}`
		);
		this.name = 'InvalidGraceError';
	}
}

export class InvalidWaitTimeoutError extends CliUsageError {
	constructor(public readonly value: string) {
		super(
			`--wait-timeout must be at least 1 second; use --no-wait to skip waiting: ${value}`
		);
		this.name = 'InvalidWaitTimeoutError';
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

/**
 * A Worker URL carrying credentials, a query or a fragment. Every route
 * resolves under the base's origin and path, so honouring such a URL would
 * corrupt or missend the requests built on it.
 */
export class InvalidWorkerUrlBaseError extends CliUsageError {
	constructor() {
		super('Worker URL must carry nothing beyond origin and path');
		this.name = 'InvalidWorkerUrlBaseError';
	}
}

export class UnreachableHostError extends CliError {
	constructor(
		public readonly host: string,
		cause: Error
	) {
		const underlying = cause.cause;
		const detail = (underlying instanceof Error ? underlying : cause).message;

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
	constructor(public readonly detail: string) {
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
		public readonly body: string,
		// Cloudflare's per-request ray id from the response, when present: the
		// handle that ties a client-side failure to its server log line.
		public readonly ray?: string
	) {
		const rayNote = ray === undefined ? '' : ` (Cloudflare ray ${ray})`;

		super(`${method} ${path} failed with ${String(status)}: ${body}${rayNote}`);
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
		public override readonly cause: z.ZodError
	) {
		super(
			path,
			`Response from ${path} did not match the expected schema:\n${z.prettifyError(cause)}`
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

export class UploadGraceFactsUnsupportedError extends CliError {
	constructor(public override readonly cause: Error) {
		super(
			'This operation requires upload grace facts, but the server did not ' +
				'acknowledge that capability. Upgrade the server before publishing ' +
				'without retention or using this preview.'
		);
		this.name = 'UploadGraceFactsUnsupportedError';
	}
}

export class PushIncompleteError extends CliError {
	constructor(public readonly failedPaths: readonly string[]) {
		super(
			`${String(failedPaths.length)} path(s) did not finish; the cache holds ` +
				`only what committed. Re-run cupboard push to retry: ${failedPaths.join(', ')}`
		);
		this.name = 'PushIncompleteError';
	}
}

export class PathsNotConfirmedError extends CliError {
	constructor(public readonly storePaths: readonly string[]) {
		super(
			`${String(storePaths.length)} path(s) were not confirmed (not present ` +
				`in the cache): ${storePaths.join(', ')}`
		);
		this.name = 'PathsNotConfirmedError';
	}
}

/**
 * A confirm closure larger than one request splits into sequential batches,
 * and a later batch's request failed. The batches that answered have already
 * extended their deadlines server-side; the counts say how far the run got.
 */
export class ConfirmIncompleteError extends CliError {
	constructor(
		public readonly confirmedBatches: number,
		public readonly totalBatches: number,
		public override readonly cause: unknown
	) {
		super(
			`${String(confirmedBatches)} of ${String(totalBatches)} confirm ` +
				`request(s) succeeded before one failed; paths reported confirmed ` +
				`are already extended`
		);
		this.name = 'ConfirmIncompleteError';
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

export class AttestationDivergedPathError extends CliError {
	constructor(
		public readonly storePath: string,
		public readonly localNarHash: string,
		public readonly cacheNarHash: string
	) {
		super(
			`Attestation describes ${storePath} as ${localNarHash}, but the cache ` +
				`holds ${cacheNarHash} for it: the same store path was realised with ` +
				`different bytes, so the attestation cannot attach. Delete the cached ` +
				`path and push again, or drop the attestation.`
		);
		this.name = 'AttestationDivergedPathError';
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

export class NoRetainConflictError extends CliUsageError {
	constructor(public readonly flag: '--root' | '--ttl') {
		super(`--no-retain cannot be combined with ${flag}`);
		this.name = 'NoRetainConflictError';
	}
}

export class RunRootTtlWithoutRunRootError extends CliUsageError {
	constructor() {
		super('--run-root-ttl requires --run-root');
		this.name = 'RunRootTtlWithoutRunRootError';
	}
}

export class OidcRetentionChoiceRequiredError extends CliUsageError {
	constructor() {
		super(
			'A GitHub OIDC push must choose its retention. --root <name> keeps ' +
				'the pushed paths under a named root this run owns: the choice for a ' +
				"build's own outputs. --no-retain publishes them unretained, kept " +
				"only by the destination cache's retention grace policy: the choice " +
				'for grace-mode intermediates that later jobs substitute and root ' +
				'themselves.'
		);
		this.name = 'OidcRetentionChoiceRequiredError';
	}
}

export class InvalidReuseViewPriorityError extends CliUsageError {
	constructor(public readonly value: string) {
		super(`Invalid priority (expected a non-negative integer): ${value}`);
		this.name = 'InvalidReuseViewPriorityError';
	}
}

export class ReuseViewSelectorRequiredError extends CliUsageError {
	constructor() {
		super('reuse-view set requires at least one --exact or --prefix selector');
		this.name = 'ReuseViewSelectorRequiredError';
	}
}

export class CacheInfoUnavailableError extends CliError {
	constructor(
		public readonly target: URL,
		public readonly status: number
	) {
		super(`${target} answered HTTP ${String(status)}`);
		this.name = 'CacheInfoUnavailableError';
	}
}

export class CacheInfoRateLimitedError extends CliError {
	constructor(public readonly target: URL) {
		super(`${target} rate limited the nix-cache-info request`);
		this.name = 'CacheInfoRateLimitedError';
	}

	override get exitCode(): number {
		return transientExitCode;
	}
}

export class CacheInfoServerError extends CliError {
	constructor(
		public readonly target: URL,
		public readonly status: number
	) {
		super(
			`${target} answered HTTP ${String(status)} while serving nix-cache-info`
		);
		this.name = 'CacheInfoServerError';
	}

	override get exitCode(): number {
		return transientExitCode;
	}
}

export class CacheInfoTimeoutError extends CliError {
	constructor(
		public readonly target: URL,
		public readonly timeoutMs: number,
		options: { readonly cause: unknown }
	) {
		super(
			`${target} did not answer nix-cache-info within ${String(timeoutMs)}ms`,
			{ cause: options.cause }
		);
		this.name = 'CacheInfoTimeoutError';
	}

	override get exitCode(): number {
		return transientExitCode;
	}
}

export class CacheInfoUnparsableError extends CliError {
	constructor(
		public readonly target: URL,
		options: { readonly cause: unknown }
	) {
		super(`${target} did not answer with a parsable nix-cache-info body`, {
			cause: options.cause
		});
		this.name = 'CacheInfoUnparsableError';
	}
}

/**
 * github setup found stored state that neither matches what it would write
 * nor was replaced. The drifted steps are reported and left in place; the
 * non-zero exit makes the divergence visible to scripts and CI.
 */
export class GithubSetupDriftError extends CliError {
	constructor(public readonly steps: readonly string[]) {
		super(
			`Stored tenant state differs from what github setup would write: ${steps.join(', ')}. ` +
				'Each drift row above names the diverging fields; setup never replaces ' +
				'stored state, so resolve each (for a trust rule, remove it with ' +
				'`cupboard oidc-trust remove`) and re-run setup to converge.'
		);
		this.name = 'GithubSetupDriftError';
	}
}

/**
 * A grace shorter than the supported minimum risks expiring while a run is
 * still publishing; refused before any policy is stored.
 */
export class GraceTooShortError extends CliUsageError {
	constructor(
		public readonly graceSeconds: number,
		public readonly minimumSeconds: number
	) {
		super(
			`--grace must be at least ${String(minimumSeconds)} seconds; got ${String(graceSeconds)}`
		);
		this.name = 'GraceTooShortError';
	}
}

/** Reference paths and their source travel together. */
export class ReferenceSourcePairError extends CliUsageError {
	constructor() {
		super(
			'--reference-paths-file and --reference-source must be supplied together'
		);
		this.name = 'ReferenceSourcePairError';
	}
}

/**
 * The destination demanded an upload for a path published by reference. A
 * reference entry never reads a NAR, so the demand cannot be met; the tenant
 * was expected to hold the blob already.
 */
export class ReferenceUploadRequiredError extends CliError {
	constructor(public readonly storePath: string) {
		super(
			`${storePath} is published by reference, but the destination demanded ` +
				'an upload; the tenant was expected to hold the blob'
		);
		this.name = 'ReferenceUploadRequiredError';
	}
}

/** The reference source served metadata for a different store path. */
export class ReferencePathMismatchError extends CliError {
	constructor(
		public readonly requestedStorePath: string,
		public readonly servedStorePath: string
	) {
		super(
			`the reference source served metadata for ${servedStorePath} when ` +
				`${requestedStorePath} was requested`
		);
		this.name = 'ReferencePathMismatchError';
	}
}

/** The reference source did not serve the requested narinfo. */
export class NarInfoUnavailableError extends CliError {
	constructor(
		public readonly target: URL,
		public readonly status: number
	) {
		super(`${target} answered HTTP ${String(status)} for the narinfo`);
		this.name = 'NarInfoUnavailableError';
	}
}

/** The reference source served a body that does not parse as a narinfo. */
export class NarInfoUnparsableError extends CliError {
	constructor(
		public readonly target: URL,
		options: { readonly cause: unknown }
	) {
		super(`${target} did not answer with a parsable narinfo body`, {
			cause: options.cause
		});
		this.name = 'NarInfoUnparsableError';
	}
}

/**
 * A `job_workflow_ref` claim without an `@<ref>` becomes a pattern matching
 * the workflow file at every ref, so edited workflow code would inherit the
 * publishing authority the rule grants; the github commands require the
 * exact claim spelling.
 */
export class WorkflowReferenceUnpinnedError extends CliUsageError {
	constructor(public readonly reference: string) {
		super(
			`--workflow-ref must be the exact job_workflow_ref claim including its '@<ref>'; got '${reference}'`
		);
		this.name = 'WorkflowReferenceUnpinnedError';
	}
}

export class WorkflowReferenceMalformedError extends CliUsageError {
	constructor(public readonly reference: string) {
		super(
			`--workflow-ref must name a direct .github/workflows/*.yml or *.yaml file; got '${reference}'`
		);
		this.name = 'WorkflowReferenceMalformedError';
	}
}

/**
 * A mutable ref follows whatever it later names, so a trust rule pinning one
 * trusts future edits to the workflow; the github commands accept only an
 * immutable pin.
 */
export class WorkflowReferenceMutableError extends CliUsageError {
	constructor(
		public readonly reference: string,
		public readonly pin: string
	) {
		super(
			`--workflow-ref must pin a full commit id or an immutable release tag; got '${pin}' in '${reference}'`
		);
		this.name = 'WorkflowReferenceMutableError';
	}
}

/**
 * A `*` wildcard is only meaningful in the tag part of a reference, as
 * `refs/tags/<glob>` with literal tag characters and single `*` wildcards.
 * Anywhere else there is no ref it could match, so it is refused rather than
 * stored as a rule no token satisfies.
 */
export class WorkflowReferenceTagPatternError extends CliUsageError {
	constructor(
		public readonly reference: string,
		public readonly pin: string
	) {
		super(
			`--workflow-ref with '*' must pin a tag pattern 'refs/tags/<glob>'; got '${pin}' in '${reference}'`
		);
		this.name = 'WorkflowReferenceTagPatternError';
	}
}

/**
 * A configuration check evaluates the workflow release the caller will
 * actually run. Tag patterns describe a wider setup policy and cannot identify
 * that release.
 */
export class WorkflowReferenceExactRequiredError extends CliUsageError {
	constructor(public readonly reference: string) {
		super(
			`github check --workflow-ref must name the exact release tag or full commit id currently used by the caller; got tag pattern '${reference}'`
		);
		this.name = 'WorkflowReferenceExactRequiredError';
	}
}

export class WorkflowReferenceNotFoundError extends CliUsageError {
	constructor(public readonly reference: string) {
		super(
			`--workflow-ref does not resolve to a workflow file or published release on GitHub: '${reference}'`
		);
		this.name = 'WorkflowReferenceNotFoundError';
	}
}

/**
 * Optional trust-rule removals failed after the new configuration was already
 * applied. The result report names each rule that stayed behind; the non-zero
 * exit tells scripts the cleanup is incomplete.
 */
export class GithubSetupRemovalError extends CliError {
	constructor(
		public readonly ruleIds: readonly string[],
		options: { readonly cause: unknown }
	) {
		super(
			`The new configuration was applied, but removing ${
				ruleIds.length === 1 ? 'trust rule' : 'trust rules'
			} ${ruleIds.join(', ')} failed. ` +
				'Remove each with `cupboard oidc-trust remove` or re-run setup.',
			{ cause: options.cause }
		);
		this.name = 'GithubSetupRemovalError';
	}
}

export class GithubSetupOwnerRuleConflictError extends CliUsageError {
	constructor() {
		super(
			'The immutable owner trust rule can match this GitHub workflow. ' +
				'Change the deployment owner OIDC configuration before running github setup.'
		);
		this.name = 'GithubSetupOwnerRuleConflictError';
	}
}

/** Basic read credentials come as a pair; half a pair is a mistake. */
export class ReadCredentialPairError extends CliUsageError {
	constructor() {
		super('--read-user and --read-password must be supplied together');
		this.name = 'ReadCredentialPairError';
	}
}

export class GithubCheckFailedError extends CliError {
	constructor(public readonly checks: readonly string[]) {
		super(`Configuration checks failed: ${checks.join(', ')}`);
		this.name = 'GithubCheckFailedError';
	}
}

/**
 * Some invariants could not be verified in this environment (no `gh`, no
 * evaluated manifest). Nothing failed, but a green run was not proven either,
 * so the exit is EX_UNAVAILABLE rather than success.
 */
export class GithubCheckIncompleteError extends CliError {
	constructor(public readonly checks: readonly string[]) {
		super(`Could not verify: ${checks.join(', ')}`);
		this.name = 'GithubCheckIncompleteError';
	}

	override get exitCode(): number {
		return unavailableExitCode;
	}
}

/**
 * No candidate runtime directory yields a hook socket path that fits within
 * `sun_path`, so the invocation endpoint cannot be created anywhere.
 */
export class SocketPathTooLongError extends CliError {
	constructor(
		public readonly socketPath: string,
		public readonly limitBytes: number
	) {
		super(
			`No runtime directory yields a hook socket path within ` +
				`${String(limitBytes)} bytes; the shortest candidate was ${socketPath}`
		);
		this.name = 'SocketPathTooLongError';
	}
}

/** A build event the invocation listener refused to accept. */
export abstract class BuildEventRejectedError extends CliError {}

export type BuildEventMalformedKind =
	'missing-line' | 'invalid-json' | 'invalid-event';

export class BuildEventMalformedError extends BuildEventRejectedError {
	constructor(public readonly kind: BuildEventMalformedKind) {
		super(`Rejected a malformed build event: ${kind}`);
		this.name = 'BuildEventMalformedError';
	}
}

/**
 * Streaming publication needs the daemon: temporary roots exist only behind
 * it, and the daemonless local backend has no connection to hold one on. The
 * socket path names where a daemon was looked for.
 */
export class DaemonRequiredError extends CliError {
	constructor(public readonly socketPath: string) {
		super(
			`Streaming publication requires a Nix daemon, and no daemon socket ` +
				`exists at ${socketPath}. Start nix-daemon, or run without streaming.`
		);
		this.name = 'DaemonRequiredError';
	}

	override get exitCode(): number {
		return unavailableExitCode;
	}
}

/**
 * The daemon does not trust this client, so it would silently ignore the
 * invocation's `post-build-hook` override and the build would stream nothing.
 * Refused before the expensive build starts; `requiredSetting` names the
 * daemon setting that admits the user.
 */
export class UntrustedDaemonError extends CliError {
	public readonly requiredSetting = 'trusted-users';

	constructor(public readonly trust: 'not-trusted' | 'unknown') {
		super(
			`The Nix daemon does not trust this user, so it would ignore the ` +
				`post-build-hook this run sets. Add the user to the daemon's ` +
				`trusted-users setting.`
		);
		this.name = 'UntrustedDaemonError';
	}

	override get exitCode(): number {
		return authExitCode;
	}
}

/**
 * The effective configuration already sets `post-build-hook`. Nix supports
 * exactly one, so streaming mode refuses; it never silently overrides an
 * operator's hook.
 */
export class PostBuildHookConflictError extends CliError {
	constructor(public readonly existingHook: string) {
		super(
			`The Nix configuration already sets post-build-hook (${existingHook}), ` +
				`and Nix supports exactly one. Remove it, or run without streaming.`
		);
		this.name = 'PostBuildHookConflictError';
	}
}

/**
 * The token's granted authorization_details do not cover an operation this
 * run needs on a root, so a later phase would fail after the expensive build;
 * refused up front, naming the missing authority.
 */
export class MissingGrantError extends CliError {
	constructor(
		public readonly operation: string,
		public readonly root: string
	) {
		super(
			`The access token does not grant ${operation} on root ${root}; ` +
				`request it in the token exchange's authorization_details.`
		);
		this.name = 'MissingGrantError';
	}

	override get exitCode(): number {
		return authExitCode;
	}
}

/**
 * This installation carries no compiled hook helper at any expected location,
 * so streaming publication cannot start. The candidates name every location
 * that was checked.
 */
export class HookHelperMissingError extends CliError {
	constructor(public readonly candidates: readonly string[]) {
		super(
			`This installation is missing its cupboard-hook-relay hook helper; ` +
				`checked: ${candidates.join(', ')}. Set CUPBOARD_HOOK_HELPER to ` +
				`name one explicitly.`
		);
		this.name = 'HookHelperMissingError';
	}
}

/**
 * A well-formed build event naming an output path outside the selected store
 * directory. Only paths beneath that directory are publication candidates, so
 * the event is refused before anything enters the accepted set.
 */
export class BuildEventOutsideStoreError extends BuildEventRejectedError {
	constructor(
		public readonly storePath: string,
		public readonly storeDirectory: string
	) {
		super(
			`Rejected a build event: ${storePath} is not beneath ${storeDirectory}`
		);
		this.name = 'BuildEventOutsideStoreError';
	}
}

/**
 * The supervised build command itself failed. The run exits with the child's
 * own status, or 128 plus the number of the signal that killed it, so a build
 * failure is never re-labelled as a cache failure.
 */
export class BuildCommandFailedError extends CliError {
	constructor(
		public readonly status: number | undefined,
		public readonly signal: string | undefined,
		private readonly code: number
	) {
		super(
			signal === undefined
				? `The build command failed with status ${String(status ?? code)}`
				: `The build command was killed by ${signal}`
		);
		this.name = 'BuildCommandFailedError';
	}

	override get exitCode(): number {
		return this.code;
	}
}

/** A build-push run takes exactly one build input. */
export class CohortInputError extends CliUsageError {
	constructor() {
		super('pass a build command after -- or --cohorts-file, and not both');
		this.name = 'CohortInputError';
	}
}

/** The cohorts file did not parse into the typed cohort schema. */
export class CohortsFileInvalidError extends CliUsageError {
	constructor(options?: { readonly cause: unknown }) {
		super(
			'the cohorts file must be JSON of the shape ' +
				'{"cohorts": [{"command": [...]} | {"installables": [...]}]}',
			options
		);
		this.name = 'CohortsFileInvalidError';
	}
}

/**
 * The build succeeded but its publication or retention did not complete. The
 * exit code carries the classified sysexits category, so a cache failure is
 * never presented as a build failure; the receipt names each lost path.
 */
export class BuildPublicationFailedError extends CliError {
	constructor(
		public readonly failedPaths: readonly string[],
		private readonly code: number,
		options: { readonly cause?: unknown } = {}
	) {
		super(
			failedPaths.length === 0
				? 'Publication did not complete; the receipt records the cause'
				: `${String(failedPaths.length)} path(s) failed to publish or ` +
						`retain; the receipt records each cause: ${failedPaths.join(', ')}`,
			options
		);
		this.name = 'BuildPublicationFailedError';
	}

	override get exitCode(): number {
		return this.code;
	}
}

/**
 * The sysexits category a set of publication failures maps to:
 * authentication first, then transient, then unavailable, and the
 * publication code for anything not otherwise classified.
 */
export function publicationFailureExitCode(causes: readonly unknown[]): number {
	const codes = new Set(
		causes
			.filter((cause): cause is CliError => cause instanceof CliError)
			.map((cause) => cause.exitCode)
	);

	for (const code of [authExitCode, transientExitCode, unavailableExitCode]) {
		if (codes.has(code)) {
			return code;
		}
	}

	return publicationExitCode;
}
