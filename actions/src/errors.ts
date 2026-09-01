import type { CacheScope } from '@cupboard/nix-store/scalars';
import type { SubjectOrigin } from '@cupboard/protocol/build';
import type { ReporterResultEvent } from '@cupboard/reporter';
import {
	CodedError,
	genericExitCode,
	UsageError
} from '@cupboard/shared/errors';
import { z } from 'zod';

export class MissingInputError extends UsageError {
	constructor(public readonly input: string) {
		super(`${input} is required`);
		this.name = 'MissingInputError';
	}
}

export class CacheNameInvalidError extends UsageError {
	constructor(public readonly value: string) {
		super('cache must be a valid cache name');
		this.name = 'CacheNameInvalidError';
	}
}

export type UrlInputName = 'cache-url' | 'url';

export class UrlInputInvalidError extends UsageError {
	constructor(public readonly input: UrlInputName) {
		super(
			`${input} must be an http(s) URL without credentials, a query, or a fragment`
		);
		this.name = 'UrlInputInvalidError';
	}
}

export class ReadUserInvalidError extends UsageError {
	constructor(public readonly value: string) {
		super('read-user must not contain a colon');
		this.name = 'ReadUserInvalidError';
	}
}

export class BooleanInputInvalidError extends UsageError {
	constructor(
		public readonly input: string,
		public readonly value: string
	) {
		super(`${input} must be true or false`);
		this.name = 'BooleanInputInvalidError';
	}
}

export class ChoiceInputInvalidError extends UsageError {
	constructor(
		public readonly input: string,
		public readonly value: string,
		public readonly choices: readonly string[]
	) {
		super(`${input} must be one of ${choices.join(', ')}`);
		this.name = 'ChoiceInputInvalidError';
	}
}

export class BuildInstallablesMissingError extends UsageError {
	constructor() {
		super('installables must contain at least one value');
		this.name = 'BuildInstallablesMissingError';
	}
}

export class BuildInstallableInvalidError extends UsageError {
	constructor(public readonly installables: readonly string[]) {
		super(
			'installables must not start with a hyphen or contain control characters'
		);
		this.name = 'BuildInstallableInvalidError';
	}
}

export class BuildAttemptsInvalidError extends UsageError {
	constructor(public readonly value: string) {
		super('attempts must be a positive integer');
		this.name = 'BuildAttemptsInvalidError';
	}
}

export class GithubEndpointInvalidError extends UsageError {
	constructor(public readonly input: string) {
		super(`${input} must be a credential-safe HTTPS URL`);
		this.name = 'GithubEndpointInvalidError';
	}
}

export class GithubEndpointOriginMismatchError extends UsageError {
	constructor() {
		super('github-graphql-url must have the same origin as github-api-url');
		this.name = 'GithubEndpointOriginMismatchError';
	}
}

export class WorkflowShaInvalidError extends UsageError {
	constructor(public readonly value: string) {
		super('workflow-sha must be a lowercase, full 40-character Git commit id');
		this.name = 'WorkflowShaInvalidError';
	}
}

export class CupboardReleaseSelectionConflictError extends UsageError {
	constructor(public readonly input: 'cupboard' | 'cupboard-path') {
		super(`${input} cannot be combined with release selection inputs`);
		this.name = 'CupboardReleaseSelectionConflictError';
	}
}

export class PackCapacityInvalidError extends UsageError {
	constructor(public readonly value: string) {
		super('pack-capacity must be a positive integer byte count');
		this.name = 'PackCapacityInvalidError';
	}
}

export class RootNameInvalidError extends UsageError {
	constructor(
		public readonly target: string,
		public readonly maximumLength: number
	) {
		super(
			`root-prefix and rootSuffix for ${target} must form a root name of at most ${String(maximumLength)} characters without control characters`
		);
		this.name = 'RootNameInvalidError';
	}
}

export class RemoteOutputPathUnknownDuringPlanningError extends UsageError {
	constructor(public readonly targets: readonly string[]) {
		super(
			`Remote publication cannot build targets whose selected output paths are unknown during planning: ${targets.join(', ')}. Publish them from the local store until the Nix daemon can return and root newly discovered outputs atomically.`
		);
		this.name = 'RemoteOutputPathUnknownDuringPlanningError';
	}
}

export class PushPathsMissingError extends UsageError {
	constructor() {
		super('paths is required and must contain at least one path');
		this.name = 'PushPathsMissingError';
	}
}

export class RootGroupsPathsConflictError extends UsageError {
	constructor() {
		super('root-groups cannot be combined with paths');
		this.name = 'RootGroupsPathsConflictError';
	}
}

export class RootGroupsRootConflictError extends UsageError {
	constructor() {
		super(
			'root-groups cannot be combined with root: each group names its own root'
		);
		this.name = 'RootGroupsRootConflictError';
	}
}

export class RootGroupsRetentionConflictError extends UsageError {
	constructor() {
		super(
			'root-groups cannot be combined with no-retain: a group publishes under its own root'
		);
		this.name = 'RootGroupsRetentionConflictError';
	}
}

export class RootRetentionConflictError extends UsageError {
	constructor() {
		super('root cannot be combined with no-retain');
		this.name = 'RootRetentionConflictError';
	}
}

export class TtlRetentionConflictError extends UsageError {
	constructor() {
		super('ttl cannot be combined with no-retain');
		this.name = 'TtlRetentionConflictError';
	}
}

export class PermanentRetentionConflictError extends UsageError {
	constructor() {
		super('permanent cannot be combined with no-retain');
		this.name = 'PermanentRetentionConflictError';
	}
}

export class RetentionChoiceConflictError extends UsageError {
	constructor(
		readonly ttlOption: string,
		readonly permanentOption: string
	) {
		super(`${ttlOption} cannot be combined with ${permanentOption}`);
		this.name = 'RetentionChoiceConflictError';
	}
}

export class GraceWaitConflictError extends UsageError {
	constructor() {
		super('require-grace cannot be combined with wait: false');
		this.name = 'GraceWaitConflictError';
	}
}

export class ReferenceSourcePairingError extends UsageError {
	constructor() {
		super(
			'reference-paths-file and reference-source must be supplied together'
		);
		this.name = 'ReferenceSourcePairingError';
	}
}

export class RootGroupsJsonInvalidError extends UsageError {
	constructor(public override readonly cause: unknown) {
		super(
			`root-groups is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause }
		);
		this.name = 'RootGroupsJsonInvalidError';
	}
}

export class RootGroupsSchemaError extends UsageError {
	constructor(public override readonly cause: z.ZodError) {
		super(
			`root-groups does not match {root, paths}[]:\n${z.prettifyError(cause)}`,
			{ cause }
		);
		this.name = 'RootGroupsSchemaError';
	}
}

export class PredicateTypeRequiredError extends UsageError {
	constructor() {
		super('predicate-type is required when predicate-file is supplied');
		this.name = 'PredicateTypeRequiredError';
	}
}

/**
 * Individual grouping requires each statement to contain only its subject. The
 * action must therefore filter the predicate as well as the in-toto subject
 * list. It knows how to filter only a build-origin predicate, so it rejects any
 * other predicate type.
 */
export class PredicateGroupingUnsupportedError extends UsageError {
	constructor(public readonly predicateType: string) {
		super('subject-grouping individual requires a build-origin predicate');
		this.name = 'PredicateGroupingUnsupportedError';
	}
}

export class BuildOriginSubjectMissingError extends UsageError {
	constructor(public readonly subjects: readonly string[]) {
		super('the build-origin predicate contains none of the requested subjects');
		this.name = 'BuildOriginSubjectMissingError';
	}
}

export class AttestationSubjectsMissingError extends UsageError {
	constructor(public readonly checksumsFile: string) {
		super(`${checksumsFile} lists no subject to sign`);
		this.name = 'AttestationSubjectsMissingError';
	}
}

export class AttestationBundlesMissingError extends UsageError {
	constructor() {
		super('bundle is required and must name at least one attestation bundle');
		this.name = 'AttestationBundlesMissingError';
	}
}

export class CupboardVersionInvalidError extends UsageError {
	constructor(public readonly value: string) {
		super('cupboard-version must be latest or an exact release tag');
		this.name = 'CupboardVersionInvalidError';
	}
}

export class ExactCupboardVersionRequiredError extends UsageError {
	constructor() {
		super(
			'cupboard-version must be an exact release when expected-source-commit is set'
		);
		this.name = 'ExactCupboardVersionRequiredError';
	}
}

export class ExpectedSourceCommitInvalidError extends UsageError {
	constructor(public readonly value: string) {
		super('expected-source-commit must be a full 40-character Git commit id');
		this.name = 'ExpectedSourceCommitInvalidError';
	}
}

export class ExactReleaseTagRequiredError extends CodedError {
	constructor() {
		super('Release selection did not produce an exact tag.');
		this.name = 'ExactReleaseTagRequiredError';
	}
}

export class ArchiveSha256InvalidError extends CodedError {
	constructor(public readonly value: string) {
		super('The release archive digest is not a lowercase SHA-256 digest.');
		this.name = 'ArchiveSha256InvalidError';
	}
}

export class ReleaseRepositoryInvalidError extends UsageError {
	constructor(public readonly value: string) {
		super(`release-repository must be <owner>/<name>, got '${value}'`);
		this.name = 'ReleaseRepositoryInvalidError';
	}
}

export class CohortJsonInvalidError extends UsageError {
	constructor(public override readonly cause: unknown) {
		super(
			`cohort-json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause }
		);
		this.name = 'CohortJsonInvalidError';
	}
}

export class CohortJsonSchemaError extends UsageError {
	constructor(public override readonly cause: z.ZodError) {
		super(
			`cohort-json does not match a cohort-matrix entry:\n${z.prettifyError(cause)}`,
			{ cause }
		);
		this.name = 'CohortJsonSchemaError';
	}
}

export class ReadPasswordRequiredError extends UsageError {
	constructor() {
		super('read-password is required when read-user is supplied');
		this.name = 'ReadPasswordRequiredError';
	}
}

/**
 * The `cache-credentials` input is a JSON array of explicit cache scopes and
 * their read credentials.
 */
export class CacheCredentialsInvalidError extends UsageError {
	constructor(options?: { readonly cause: unknown }) {
		super(
			'cache-credentials must be a JSON array of cache scopes and credentials',
			options
		);
		this.name = 'CacheCredentialsInvalidError';
	}
}

/**
 * Each entry in `cache-credentials` must match a cache in `cache`.
 */
export class UnknownCacheCredentialError extends UsageError {
	constructor(public readonly cache: string) {
		super(`add '${cache}' to cache or remove its cache-credentials entry`);
		this.name = 'UnknownCacheCredentialError';
	}
}

export class ReadUserRequiredError extends UsageError {
	constructor() {
		super('read-user is required when read-password is supplied');
		this.name = 'ReadUserRequiredError';
	}
}

export class DestinationReadPasswordRequiredError extends UsageError {
	constructor() {
		super(
			'destination-read-password is required when destination-read-user is supplied'
		);
		this.name = 'DestinationReadPasswordRequiredError';
	}
}

export class DestinationReadUserRequiredError extends UsageError {
	constructor() {
		super(
			'destination-read-user is required when destination-read-password is supplied'
		);
		this.name = 'DestinationReadUserRequiredError';
	}
}

export class DestinationReadCredentialConflictError extends UsageError {
	constructor() {
		super(
			'destination read credentials and cache-credentials are mutually exclusive'
		);
		this.name = 'DestinationReadCredentialConflictError';
	}
}

export class DestinationReadCredentialCacheCountError extends UsageError {
	constructor() {
		super('destination read credentials require exactly one selected cache');
		this.name = 'DestinationReadCredentialCacheCountError';
	}
}

export class FallbackReadPasswordRequiredError extends UsageError {
	constructor() {
		super(
			'fallback-read-password is required when fallback-read-user is supplied'
		);
		this.name = 'FallbackReadPasswordRequiredError';
	}
}

export class FallbackReadUserRequiredError extends UsageError {
	constructor() {
		super(
			'fallback-read-user is required when fallback-read-password is supplied'
		);
		this.name = 'FallbackReadUserRequiredError';
	}
}

export class InvalidMaxJobsError extends UsageError {
	constructor(public readonly value: string) {
		super('max-jobs must be a non-negative 32-bit integer');
		this.name = 'InvalidMaxJobsError';
	}
}

export class RunRootRequiredError extends UsageError {
	constructor(public readonly ttl: string) {
		super('run-root-ttl requires run-root');
		this.name = 'RunRootRequiredError';
	}
}

export class RunRootPermanentRequiredError extends UsageError {
	constructor() {
		super('run-root-permanent requires run-root');
		this.name = 'RunRootPermanentRequiredError';
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

function withCause(cause: unknown): ErrorOptions | undefined {
	return cause === undefined ? undefined : { cause };
}

export interface GithubApiErrorOptions {
	readonly status?: number;
	readonly detail?: string;
	readonly cause?: unknown;
}

export class GithubApiError extends CodedError {
	readonly status: number | undefined;

	constructor(operation: string, options: GithubApiErrorOptions = {}) {
		const reason =
			options.detail ??
			(options.status === undefined
				? 'an unknown error'
				: String(options.status));
		super(`${operation}: ${reason}`, withCause(options.cause));
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

export class CupboardResolutionJsonError extends UsageError {
	constructor(public override readonly cause: unknown) {
		super('resolved-cupboard is not valid canonical JSON', { cause });
		this.name = 'CupboardResolutionJsonError';
	}
}

export class MalformedReleaseDiscoveryResponseError extends CodedError {
	constructor(options: { readonly cause?: unknown } = {}) {
		super(
			'the GitHub GraphQL API returned an unexpected release response',
			withCause(options.cause)
		);
		this.name = 'MalformedReleaseDiscoveryResponseError';
	}
}

export class ReleaseDiscoverySearchTooLargeError extends CodedError {
	constructor(
		public readonly maximumPageEntries: number,
		public readonly maximumCandidates: number,
		public readonly maximumPages: number,
		public readonly observedPageEntries: number,
		public readonly observedCandidates: number,
		public readonly observedPages: number
	) {
		super(
			`release discovery exceeded its limits: page ${String(observedPages)} contained ${String(observedPageEntries)} entries and brought the total to ${String(observedCandidates)}; maximum ${String(maximumPageEntries)} entries per page, ${String(maximumCandidates)} candidates and ${String(maximumPages)} pages`
		);
		this.name = 'ReleaseDiscoverySearchTooLargeError';
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

export class InvalidReleaseAssetUrlError extends CodedError {
	constructor(
		public readonly assetName: string,
		public readonly expectedOrigin: string
	) {
		super(
			`release asset ${assetName} does not have a credential-safe HTTPS URL on ${expectedOrigin}`
		);
		this.name = 'InvalidReleaseAssetUrlError';
	}
}

export class DownloadAssetTooLargeError extends CodedError {
	constructor(
		public readonly assetName: string,
		public readonly maximumBytes: number,
		public readonly observedBytes: number
	) {
		super(
			`release asset ${assetName} is ${String(observedBytes)} bytes, exceeding the ${String(maximumBytes)}-byte download limit`
		);
		this.name = 'DownloadAssetTooLargeError';
	}
}

export class ReleaseAttestationBundleTooLargeError extends CodedError {
	constructor(
		public readonly maximumBytes: number,
		public readonly observedBytes: number
	) {
		super(
			`release attestation bundle is ${String(observedBytes)} bytes, exceeding the ${String(maximumBytes)}-byte input limit`
		);
		this.name = 'ReleaseAttestationBundleTooLargeError';
	}
}

export class ReleaseAttestationSearchTooLargeError extends CodedError {
	constructor(
		public readonly maximumCandidates: number,
		public readonly maximumPages: number,
		public readonly observedCandidates: number,
		public readonly observedPages: number
	) {
		super(
			`release attestation search exceeded its ${String(maximumCandidates)}-candidate or ${String(maximumPages)}-page limit after ${String(observedCandidates)} candidate(s) across ${String(observedPages)} page(s)`
		);
		this.name = 'ReleaseAttestationSearchTooLargeError';
	}
}

export class ReleaseCompatibilityError extends CodedError {
	constructor(
		public readonly tag: string,
		public readonly minimumTag: string
	) {
		super(
			`release ${tag} predates the cupboard-hook-relay helper required by this action; select ${minimumTag} or newer`
		);
		this.name = 'ReleaseCompatibilityError';
	}
}

export class InstalledReleaseVersionMismatchError extends CodedError {
	constructor(
		public readonly expected: string,
		public readonly actual: string
	) {
		super(
			`release ${expected} installed an executable reporting version '${actual}'`
		);
		this.name = 'InstalledReleaseVersionMismatchError';
	}
}

export class ReleaseInstallationIncompleteError extends CodedError {
	constructor(
		public readonly path: string,
		options: { readonly cause?: unknown } = {}
	) {
		super(
			`released Cupboard is missing executable file ${path}`,
			withCause(options.cause)
		);
		this.name = 'ReleaseInstallationIncompleteError';
	}
}

export class ReleaseInstallationIntegrityError extends CodedError {
	constructor(
		public readonly generationDirectory: string,
		public readonly executable: string
	) {
		super(
			`release generation does not match the verified archive: ${executable} in ${generationDirectory}`
		);
		this.name = 'ReleaseInstallationIntegrityError';
	}
}

export class ReleaseInstallationStateError extends CodedError {
	constructor(
		public readonly statePath: string,
		options: { readonly cause?: unknown } = {}
	) {
		super(
			`Cupboard release installation state at ${statePath} is invalid; inspect it before removing it`,
			withCause(options.cause)
		);
		this.name = 'ReleaseInstallationStateError';
	}
}

export class ReleaseInstallationLockStateError extends CodedError {
	constructor(public readonly lockPath: string) {
		super(
			`Cupboard release installation lock ${lockPath} has an unsupported owner record; confirm no installation is running before removing it`
		);
		this.name = 'ReleaseInstallationLockStateError';
	}
}

export class ReleaseInstallationProcessIdentityError extends CodedError {
	constructor(
		public readonly pid: number,
		options: { readonly cause?: unknown } = {}
	) {
		super(
			`Could not establish the process identity for Cupboard release installation PID ${String(pid)}`,
			withCause(options.cause)
		);
		this.name = 'ReleaseInstallationProcessIdentityError';
	}
}

export class ReleaseInstallationLockLostError extends CodedError {
	constructor(
		public readonly lockPath: string,
		options: { readonly cause?: unknown } = {}
	) {
		super(
			`Cupboard release installation lock ${lockPath} was lost`,
			withCause(options.cause)
		);
		this.name = 'ReleaseInstallationLockLostError';
	}
}

export class ReleaseInstallationLockOwnerAliveError extends CodedError {
	constructor(
		public readonly lockPath: string,
		public readonly pid: number,
		options: { readonly cause?: unknown } = {}
	) {
		super(
			`Cupboard release installation lock ${lockPath} has an expired lease, but its owning process at PID ${String(pid)} still exists; stop that installer or confirm it has exited before removing the lock`,
			withCause(options.cause)
		);
		this.name = 'ReleaseInstallationLockOwnerAliveError';
	}
}

export class ReleaseInstallationRollbackError extends CodedError {
	constructor(
		public readonly transactionPath: string,
		options: { readonly cause?: unknown } = {}
	) {
		super(
			`Could not restore the previous Cupboard installation; inspect ${transactionPath} before retrying`,
			withCause(options.cause)
		);
		this.name = 'ReleaseInstallationRollbackError';
	}
}

export class CupboardVersionOutputMissingError extends CodedError {
	constructor(public readonly binaryPath: string) {
		super(`${binaryPath} --version produced no output`);
		this.name = 'CupboardVersionOutputMissingError';
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
 * `cause` contains the last candidate's failure; earlier attempts may have
 * failed for other reasons.
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

export class SubjectNarHashMovedError extends CodedError {
	constructor(
		public readonly storePath: string,
		public readonly recorded: string,
		public readonly held: string
	) {
		super(
			`${storePath} was recorded with NAR hash ${recorded}, but the destination cache serves ${held}`
		);
		this.name = 'SubjectNarHashMovedError';
	}
}

export class SubjectDeriverMovedError extends CodedError {
	constructor(
		public readonly storePath: string,
		public readonly recorded: string,
		public readonly held: string | undefined
	) {
		super(
			`${storePath} was recorded with deriver ${recorded}, but the destination cache serves ${held ?? 'none'}`
		);
		this.name = 'SubjectDeriverMovedError';
	}
}

export class SubjectNotHeldError extends CodedError {
	constructor(
		public readonly storePath: string,
		public readonly origin: SubjectOrigin
	) {
		super(
			`${storePath} was recorded with origin ${origin}, but the destination cache does not serve it`
		);
		this.name = 'SubjectNotHeldError';
	}
}

export class CommittedSubjectUnavailableError extends CodedError {
	constructor(
		public readonly storePath: string,
		public readonly status: number
	) {
		super(
			`Could not read committed metadata for ${storePath} from the destination cache: HTTP ${String(status)}`
		);
		this.name = 'CommittedSubjectUnavailableError';
	}
}

export class CommittedSubjectInvalidError extends CodedError {
	constructor(
		public readonly storePath: string,
		public override readonly cause: unknown
	) {
		super(
			`The destination cache returned invalid committed metadata for ${storePath}`,
			withCause(cause)
		);
		this.name = 'CommittedSubjectInvalidError';
	}
}

export class ProvenanceSubjectsIncompleteError extends CodedError {
	constructor(public readonly storePaths: readonly string[]) {
		super(
			`Could not establish current-run build provenance for: ${storePaths.join(', ')}`
		);
		this.name = 'ProvenanceSubjectsIncompleteError';
	}
}

export class AttestationAttachmentResultError extends CodedError {
	constructor(message: string, options: { readonly cause?: unknown } = {}) {
		super(message, withCause(options.cause));
		this.name = 'AttestationAttachmentResultError';
	}
}

export class AttestationAttachmentIncompleteError extends CodedError {
	constructor(public readonly storePaths: readonly string[]) {
		super(
			`Attestation attachment was incomplete for: ${storePaths.join(', ')}`
		);
		this.name = 'AttestationAttachmentIncompleteError';
	}
}

export class AttestationChecksumsMismatchError extends CodedError {
	constructor(
		public readonly storePaths: readonly string[],
		public readonly unexpectedNames: readonly string[] = []
	) {
		const missing = storePaths.length === 0 ? '' : storePaths.join(', ');
		const unexpected =
			unexpectedNames.length === 0
				? ''
				: `; unexpected signed subjects: ${unexpectedNames.join(', ')}`;
		super(
			`Signed subject checksums do not exactly match the build receipt${missing === '' ? '' : ` for: ${missing}`}${unexpected}`
		);
		this.name = 'AttestationChecksumsMismatchError';
	}
}

/**
 * Signing a statement failed on every attempt, or failed once with a failure
 * the action treats as final. `attempts` is the number of attempts made, so one
 * means the first failure was final.
 */
export class AttestationSigningError extends CodedError {
	constructor(
		public readonly predicateType: string,
		public readonly attempts: number,
		options: { readonly cause: unknown }
	) {
		super(
			`Could not sign the ${predicateType} attestation after ${String(attempts)} attempt(s)`,
			withCause(options.cause)
		);
		this.name = 'AttestationSigningError';
	}
}

/**
 * A produced bundle failed its generation self-check. The action runs this
 * check before it writes the bundle to a file or the repository's attestation
 * store. Rekor may already have recorded an entry during signing.
 */
export abstract class AttestationSelfCheckError extends CodedError {}

export class AttestationEvidenceShapeError extends AttestationSelfCheckError {
	constructor(
		public readonly profile: string,
		public readonly expected: string,
		public readonly tlogEntryCount: number,
		public readonly timestampCount: number
	) {
		super(
			`The ${profile} profile requires ${expected}; the produced bundle has ${String(tlogEntryCount)} Rekor entries and ${String(timestampCount)} RFC 3161 timestamps`
		);
		this.name = 'AttestationEvidenceShapeError';
	}
}

export class AttestationBundleUnverifiedError extends AttestationSelfCheckError {
	constructor(
		public readonly detail: string,
		options: { readonly cause?: unknown } = {}
	) {
		super(`The produced bundle ${detail}`, withCause(options.cause));
		this.name = 'AttestationBundleUnverifiedError';
	}
}

/**
 * The attestation store refused a bundle, or `GITHUB_REPOSITORY` is not an
 * `owner/name` pair.
 */
export class AttestationStoreWriteError extends CodedError {
	constructor(
		public readonly repository: string,
		options: { readonly cause?: unknown } = {}
	) {
		super(
			`Could not record the bundle in the attestation store of ${repository}`,
			withCause(options.cause)
		);
		this.name = 'AttestationStoreWriteError';
	}
}

export class AttestationPredicateFileError extends CodedError {
	constructor(
		public readonly predicateFile: string,
		options: { readonly cause: unknown }
	) {
		super(
			`${predicateFile} does not parse as a JSON object to sign`,
			withCause(options.cause)
		);
		this.name = 'AttestationPredicateFileError';
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

export class ReleaseCoordinateMismatchError extends CodedError {
	constructor(
		public readonly tagName: string,
		public readonly expectedSourceCommit: string,
		public readonly sourceCommit: string
	) {
		super(
			`release ${tagName} was built from ${sourceCommit}, but the action expects ${expectedSourceCommit}`
		);
		this.name = 'ReleaseCoordinateMismatchError';
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

export class CacheInfoFetchError extends CodedError {
	constructor(
		public readonly side: 'destination' | 'view',
		public readonly url: string,
		public readonly status: number
	) {
		super(
			`failed to fetch nix-cache-info for the ${side} (${url}): HTTP ${String(status)}`
		);
		this.name = 'CacheInfoFetchError';
	}
}

export class CacheAccessProbeError extends CodedError {
	constructor(
		public readonly url: string,
		public readonly status: number
	) {
		super(
			`could not determine cache access from ${url}: expected HTTP 200 or 401, received HTTP ${String(status)}`
		);
		this.name = 'CacheAccessProbeError';
	}
}

/**
 * Nix defaults a missing cache priority to 30. The reuse-view check must compare
 * the configured values, so it rejects a document without a parseable priority.
 */
export class CacheInfoInvalidError extends CodedError {
	constructor(
		public readonly side: 'destination' | 'view',
		public readonly url: string,
		options: { readonly cause: unknown }
	) {
		super(`nix-cache-info for the ${side} (${url}) is invalid`, {
			cause: options.cause
		});
		this.name = 'CacheInfoInvalidError';
	}
}

/**
 * Nix tries lower priorities first. A reuse view must have a numerically higher
 * priority so the destination wins when both caches provide a path.
 */
export class ReuseViewPriorityError extends UsageError {
	constructor(
		public readonly destinationPriority: number,
		public readonly viewPriority: number
	) {
		super(
			`reuse-view priority ${String(viewPriority)} must be numerically greater than the destination's ${String(destinationPriority)}`
		);
		this.name = 'ReuseViewPriorityError';
	}
}

export class PublishTargetsJsonError extends UsageError {
	constructor(public override readonly cause: SyntaxError) {
		super(`targets is not valid JSON: ${cause.message}`);
		this.name = 'PublishTargetsJsonError';
	}
}

export class PublishTargetsSchemaError extends UsageError {
	constructor(public override readonly cause: z.ZodError) {
		super(
			`Targets do not match the publish manifest:\n${z.prettifyError(cause)}`
		);
		this.name = 'PublishTargetsSchemaError';
	}
}

export class TargetEvaluationError extends CodedError {
	constructor(
		public readonly attribute: string,
		options: { readonly cause: unknown }
	) {
		super(`Could not evaluate ${attribute}`, withCause(options.cause));
		this.name = 'TargetEvaluationError';
	}
}

export class TargetRootUnresolvedError extends CodedError {
	constructor(public readonly attribute: string) {
		super(`Target manifest did not resolve a derivation path for ${attribute}`);
		this.name = 'TargetRootUnresolvedError';
	}
}

export class TargetEvaluationResponseError extends CodedError {
	constructor(
		public readonly attribute: string,
		public override readonly cause: SyntaxError
	) {
		super(
			`Nix returned invalid derivation JSON for ${attribute}: ${cause.message}`
		);
		this.name = 'TargetEvaluationResponseError';
	}
}

export class DerivationGraphShapeError extends CodedError {
	override readonly cause: z.ZodError;

	constructor(
		public readonly attribute: string,
		options: { readonly cause: z.ZodError }
	) {
		super(
			`Invalid derivation graph for ${attribute}:\n${z.prettifyError(options.cause)}`
		);
		this.name = 'DerivationGraphShapeError';
		this.cause = options.cause;
	}
}

export class DerivationRootCountError extends CodedError {
	constructor(
		public readonly attribute: string,
		public readonly count: number
	) {
		super(
			`Invalid derivation graph for ${attribute}: evaluated to ${String(count)} root derivations`
		);
		this.name = 'DerivationRootCountError';
	}
}

export class DerivationNodeMissingError extends CodedError {
	constructor(
		public readonly attribute: string,
		public readonly drvPath: string
	) {
		super(
			`Invalid derivation graph for ${attribute}: does not contain ${drvPath}`
		);
		this.name = 'DerivationNodeMissingError';
	}
}

export class RootEnsureCommandError extends CodedError {
	readonly wasReported: boolean;

	constructor(
		public readonly root: string,
		options: { readonly cause: unknown; readonly wasReported?: boolean }
	) {
		super(`Could not ensure retention root ${root}`, { cause: options.cause });
		this.name = 'RootEnsureCommandError';
		this.wasReported = options.wasReported ?? false;
	}
}

export class RootEnsureResultMissingError extends CodedError {
	constructor(public readonly root: string) {
		super(`Cupboard recorded no result while ensuring ${root}`);
		this.name = 'RootEnsureResultMissingError';
	}
}

export class RootEnsureResultInvalidError extends CodedError {
	constructor(
		public readonly root: string,
		options: { readonly cause: unknown }
	) {
		super(`Cupboard recorded an invalid result while ensuring ${root}`, {
			cause: options.cause
		});
		this.name = 'RootEnsureResultInvalidError';
	}
}

export class RootTargetsCommandError extends CodedError {
	readonly wasReported: boolean;

	constructor(
		public readonly root: string,
		options: { readonly cause: unknown; readonly wasReported?: boolean }
	) {
		super(`Could not read the reconciled targets of ${root}`, {
			cause: options.cause
		});
		this.name = 'RootTargetsCommandError';
		this.wasReported = options.wasReported ?? false;
	}
}

export class RootTargetsResultMissingError extends CodedError {
	constructor(public readonly root: string) {
		super(`Cupboard recorded no result while reading the targets of ${root}`);
		this.name = 'RootTargetsResultMissingError';
	}
}

export class RootTargetsResultInvalidError extends CodedError {
	constructor(
		public readonly root: string,
		options: { readonly cause: unknown }
	) {
		super(
			`Cupboard recorded an invalid result while reading the targets of ${root}`,
			{ cause: options.cause }
		);
		this.name = 'RootTargetsResultInvalidError';
	}
}

export class DuplicateGroupKeyError extends CodedError {
	constructor(public readonly key: string) {
		super(`Two publish plan groups share the key ${key}`);
		this.name = 'DuplicateGroupKeyError';
	}
}

export class CohortExecutionContextError extends UsageError {
	constructor(
		public readonly cohort: string,
		public readonly firstAttribute: string,
		public readonly conflictingAttribute: string
	) {
		super(
			`cohort '${cohort}' groups '${firstAttribute}' and '${conflictingAttribute}' across different execution contexts (system, os, remote); a cohort must run in one job`
		);
		this.name = 'CohortExecutionContextError';
	}
}

export class CohortFailureToleranceError extends UsageError {
	constructor(
		public readonly cohort: string,
		public readonly bestEffortAttribute: string,
		public readonly requiredAttribute: string
	) {
		super(
			`cohort '${cohort}' groups best-effort target '${bestEffortAttribute}' with required target '${requiredAttribute}'; give them different cohort labels or make bestEffort consistent`
		);
		this.name = 'CohortFailureToleranceError';
	}
}

export class MeasureResultMissingError extends CodedError {
	constructor() {
		super('Cupboard recorded no result while measuring the target sizes');
		this.name = 'MeasureResultMissingError';
	}
}

export class MeasureResultInvalidError extends CodedError {
	constructor(options: { readonly cause: unknown }) {
		super(
			'Cupboard recorded an invalid result while measuring the target sizes',
			{
				cause: options.cause
			}
		);
		this.name = 'MeasureResultInvalidError';
	}
}

export class PublishPlanInvariantError extends CodedError {
	constructor(public readonly subject: string) {
		super(`Publish planner invariant failed: missing ${subject}`);
		this.name = 'PublishPlanInvariantError';
	}
}

export class MatrixJobLimitError extends UsageError {
	constructor(
		public readonly matrixName: string,
		public readonly count: number,
		public readonly limit: number
	) {
		super(
			`the ${matrixName} matrix needs ${String(count)} jobs, but GitHub ` +
				`runs at most ${String(limit)} jobs per matrix; split the publish ` +
				`manifest across workflow runs`
		);
		this.name = 'MatrixJobLimitError';
	}
}

export class PublishRootTargetLimitError extends UsageError {
	constructor(
		public readonly identifier: string,
		public readonly count: number,
		public readonly limit: number
	) {
		super(
			`the target ${identifier} may publish ${String(count)} paths to one ` +
				`retention root, but a root accepts at most ${String(limit)}; split ` +
				`its outputs across manifest targets with distinct rootSuffix values`
		);
		this.name = 'PublishRootTargetLimitError';
	}
}

/**
 * A component target exceeds the atomic `root:set` limit. Do not page this
 * update: retention requires one all-or-nothing target list. Supporting larger
 * lists requires generation-aware attachment.
 */
export class ComponentRootTargetLimitError extends UsageError {
	constructor(
		public readonly attribute: string,
		public readonly count: number,
		public readonly limit: number
	) {
		super(
			`target ${attribute} declares ${String(count)} components, but a ` +
				`retention root accepts at most ${String(limit)} targets in one ` +
				`write; a larger component set needs a retention mechanism built on ` +
				`attach with a generation marker, which cupboard does not yet support`
		);
		this.name = 'ComponentRootTargetLimitError';
	}
}

export class ProbeTimeoutError extends CodedError {
	constructor(public readonly url: string) {
		super(
			`Timed out probing ${url}; the cache did not return a response before the deadline`
		);
		this.name = 'ProbeTimeoutError';
	}
}

export class CacheAvailabilityQueryError extends CodedError {
	constructor(public readonly status: number) {
		super(`Could not query cache availability: HTTP ${String(status)}`);
		this.name = 'CacheAvailabilityQueryError';
	}
}

export class CacheAvailabilityResponseMalformedError extends CodedError {
	constructor(public override readonly cause: SyntaxError) {
		super(
			'the cache availability query returned malformed JSON',
			withCause(cause)
		);
		this.name = 'CacheAvailabilityResponseMalformedError';
	}
}

export class CacheAvailabilityResponseSchemaError extends CodedError {
	constructor(public override readonly cause: z.ZodError) {
		super(
			'the cache availability query returned an invalid response',
			withCause(cause)
		);
		this.name = 'CacheAvailabilityResponseSchemaError';
	}
}

export class CacheAvailabilityResponseUnexpectedHashError extends CodedError {
	constructor(public readonly storePathHash: string) {
		super(
			`the cache availability query returned an unrequested store-path hash: ${storePathHash}`
		);
		this.name = 'CacheAvailabilityResponseUnexpectedHashError';
	}
}

export class CommandOutputTooLargeError extends CodedError {
	constructor(
		public readonly command: string,
		public readonly maximumBytes: number,
		public readonly observedBytes: number
	) {
		super(
			`${command} stdout exceeded the ${String(maximumBytes)}-byte capture limit after ${String(observedBytes)} bytes`
		);
		this.name = 'CommandOutputTooLargeError';
	}
}

export class CommandFailedError extends CodedError {
	readonly signal: NodeJS.Signals | undefined;

	constructor(
		public readonly command: string,
		public readonly status: number | null,
		detail?: string,
		options: {
			readonly cause?: unknown;
			readonly signal?: NodeJS.Signals;
		} = {}
	) {
		super(
			detail === undefined
				? options.signal === undefined
					? `${command} failed with status ${String(status)}`
					: `${command} terminated by ${options.signal}`
				: `${command} could not run: ${detail}`,
			withCause(options.cause)
		);
		this.name = 'CommandFailedError';
		this.signal = options.signal;
	}
}

export interface RemoteCohortBuildFailure {
	readonly target: string;
	readonly kind: 'dependency' | 'dependency-protocol' | 'target' | 'protocol';
	readonly outcome: string;
	readonly message: string;
}

export class RemoteCohortBuildFailedError extends CodedError {
	constructor(public readonly failures: readonly RemoteCohortBuildFailure[]) {
		super(
			`Remote Nix did not complete every requested build. The action published any valid outputs before failing: ${failures.map((failure) => `${failure.target} (${failure.outcome}: ${failure.message})`).join('; ')}`
		);
		this.name = 'RemoteCohortBuildFailedError';
	}
}

export class RemoteCohortProtocolError extends CodedError {
	constructor(public readonly failures: readonly RemoteCohortBuildFailure[]) {
		super(
			`Remote Nix returned invalid keyed build results: ${failures.map((failure) => `${failure.target} (${failure.outcome}: ${failure.message})`).join('; ')}`
		);
		this.name = 'RemoteCohortProtocolError';
	}
}

export class RemotePublicationTargetUnresolvedError extends UsageError {
	constructor(public readonly installables: readonly string[]) {
		super(
			`Remote publication requires every build target to resolve to a Nix derived path that the remote daemon can build. The plan did not resolve these targets: ${installables.join(', ')}. Re-run planning with evaluable locked outputs or publish from the local store.`
		);
		this.name = 'RemotePublicationTargetUnresolvedError';
	}
}

export class RemoteBuildOwnerMissingError extends CodedError {
	constructor(public readonly target: string) {
		super(`Remote build result ${target} has no cohort owner.`);
		this.name = 'RemoteBuildOwnerMissingError';
	}
}

export class LocalBuildOwnerMissingError extends CodedError {
	constructor(public readonly installable: string) {
		super(`Local build result ${installable} has no cohort owner.`);
		this.name = 'LocalBuildOwnerMissingError';
	}
}

export class CohortTargetOwnerMissingError extends CodedError {
	constructor(public readonly targetPath: string) {
		super(`Cohort target path ${targetPath} has no declared root owner.`);
		this.name = 'CohortTargetOwnerMissingError';
	}
}

export class ReuseViewRequiredError extends CodedError {
	constructor() {
		super('publish-by-reference paths require a reuse view');
		this.name = 'ReuseViewRequiredError';
	}
}

export class PlannedTargetSourceMissingError extends CodedError {
	constructor(public readonly target: string) {
		super(
			`Planned target ${target} has no matching source installable. Re-run planning so the cohort's evaluated targets remain aligned.`
		);
		this.name = 'PlannedTargetSourceMissingError';
	}
}

export class PlannedTargetNotDerivationError extends UsageError {
	constructor(public readonly target: string) {
		super(
			`Planned target ${target} does not refer to a derivation. Re-run planning so every target resolves to a Nix derived path that the remote daemon can build.`
		);
		this.name = 'PlannedTargetNotDerivationError';
	}
}

export class RemoteBuildOutputUndeclaredError extends UsageError {
	constructor(
		public readonly installable: string,
		public readonly outputName: string
	) {
		super(
			`Remote build target ${installable} selects output '${outputName}', which its derivation does not declare.`
		);
		this.name = 'RemoteBuildOutputUndeclaredError';
	}
}

export class RemoteBuildOutputPathUnknownError extends UsageError {
	constructor(
		public readonly installable: string,
		public readonly outputName: string
	) {
		super(
			`Remote build target ${installable} selects output '${outputName}', whose content-addressed path is not known before the build. Publish it from a local store until remote builds can root floating outputs atomically.`
		);
		this.name = 'RemoteBuildOutputPathUnknownError';
	}
}

export class LocalBuildExpectedPathMissingError extends CodedError {
	constructor(
		public readonly installable: string,
		public readonly expectedPath: string
	) {
		super(
			`The local build result for ${installable} omitted its expected output path ${expectedPath}.`
		);
		this.name = 'LocalBuildExpectedPathMissingError';
	}
}

export class LocalDependencyBuildFailedError extends CodedError {
	constructor(
		public readonly path: string,
		public readonly installables: readonly string[]
	) {
		super(
			`The local store could not realise the required path ${path} from any known producer: ${installables.join(', ')}.`
		);
		this.name = 'LocalDependencyBuildFailedError';
	}
}

export class LocalBuildOutputsMissingError extends CodedError {
	constructor(public readonly installable: string) {
		super(
			`The local build result for ${installable} contained no output paths.`
		);
		this.name = 'LocalBuildOutputsMissingError';
	}
}

export class LocalBuildOutputsOutsideCohortError extends CodedError {
	constructor(
		public readonly installable: string,
		public readonly unexpectedPaths: readonly string[]
	) {
		super(
			`The local build result for ${installable} included output paths that the completed cohort build did not produce: ${unexpectedPaths.join(', ')}.`
		);
		this.name = 'LocalBuildOutputsOutsideCohortError';
	}
}

export interface CohortEvaluationMismatch {
	readonly installable: string;
	readonly planned: string;
	readonly evaluated: readonly string[];
}

export class CohortEvaluationDriftError extends CodedError {
	public readonly missing: readonly string[];
	public readonly evaluated: readonly string[];

	constructor(public readonly mismatches: readonly CohortEvaluationMismatch[]) {
		super(
			`Cohort installables no longer evaluate to their planned derivations: ${mismatches.map((mismatch) => `${mismatch.installable} planned ${mismatch.planned}, evaluated ${mismatch.evaluated.length === 0 ? 'no derivation' : mismatch.evaluated.join(', ')}`).join('; ')}. Re-run planning against the current locked source.`
		);
		this.name = 'CohortEvaluationDriftError';
		this.missing = mismatches.map((mismatch) => mismatch.planned);
		this.evaluated = [
			...new Set(mismatches.flatMap((mismatch) => mismatch.evaluated))
		];
	}
}

/**
 * The cupboard binary exited non-zero after reporting the cause. This error
 * stores the exit status adopted by the action and any result events recorded
 * before failure. It adds no diagnostic.
 */
export class CupboardReportedError extends CodedError {
	constructor(
		public readonly status: number | null,
		public readonly results: readonly ReporterResultEvent[],
		reportedMessage?: string,
		public readonly wasReported = false
	) {
		super(reportedMessage ?? `cupboard exited with status ${String(status)}`);
		this.name = 'CupboardReportedError';
	}

	override get exitCode(): number {
		return this.status ?? genericExitCode;
	}
}

export class PushSummaryMissingError extends CodedError {
	constructor(public readonly kinds: readonly string[]) {
		super('the cupboard push finished without recording a summary result');
		this.name = 'PushSummaryMissingError';
	}
}

export class CohortPlanCommandError extends CodedError {
	readonly wasReported: boolean;

	constructor(
		public readonly cohortKey: string,
		options: { readonly cause: unknown; readonly wasReported?: boolean }
	) {
		super(`Could not plan cohort ${cohortKey}`, { cause: options.cause });
		this.name = 'CohortPlanCommandError';
		this.wasReported = options.wasReported ?? false;
	}
}

export class CohortPlanResultMissingError extends CodedError {
	constructor(public readonly cohortKey: string) {
		super(`Cupboard recorded no plan-cohort result for ${cohortKey}`);
		this.name = 'CohortPlanResultMissingError';
	}
}

export class CohortPlanResultInvalidError extends CodedError {
	constructor(
		public readonly cohortKey: string,
		options: { readonly cause: unknown }
	) {
		super(`Cupboard recorded an invalid plan-cohort result for ${cohortKey}`, {
			cause: options.cause
		});
		this.name = 'CohortPlanResultInvalidError';
	}
}

/**
 * The cohort's availability check failed because the unknown-path count
 * exceeded its ceiling or the measured data would not fit in this store.
 * `cupboard plan cohort` reports a transient exit code for the first case and
 * an unavailable-resource exit code for the second. This error preserves that
 * distinction.
 */
export class CohortPlanRefusedError extends CodedError {
	constructor(
		public readonly cohortKey: string,
		public readonly status: number | null,
		message: string
	) {
		super(message);
		this.name = 'CohortPlanRefusedError';
	}

	override get exitCode(): number {
		return this.status ?? genericExitCode;
	}
}

export function wasAlreadyReported(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'wasReported' in error &&
		error.wasReported === true
	);
}

export class PushSummaryResponseError extends CodedError {
	constructor(public override readonly cause: z.ZodError) {
		super(
			`Cupboard reported an invalid push summary:\n${z.prettifyError(cause)}`
		);
		this.name = 'PushSummaryResponseError';
	}
}

export class LegacyPushSummaryError extends CodedError {
	constructor(public readonly version: string) {
		super(
			`cupboard ${version} does not report the per-path retention facts required by require-grace`
		);
		this.name = 'LegacyPushSummaryError';
	}
}

/**
 * A path without a positive grace deadline. `not-present` means the confirm no
 * longer found the path at the destination. `pending` means the upload has not
 * yet produced a deadline. If the cache has no configured grace, the
 * cache-level {@link CacheGraceMissingError} is used instead.
 */
export interface MissingGracePath {
	readonly storePathHash: string;
	readonly storePath?: string;
	readonly reason: 'not-present' | 'pending';
}

const missingGraceRemedies: Record<MissingGracePath['reason'], string> = {
	'not-present':
		'no longer committed at the destination; rebuild or republish the path',
	pending:
		'its deferred upload has not completed; retry once the push completes'
};

export class GraceDeadlineMissingError extends CodedError {
	constructor(public readonly paths: readonly MissingGracePath[]) {
		super(
			`${String(paths.length)} path(s) lack a positive grace deadline: ` +
				paths
					.map(
						(path) =>
							`${path.storePath ?? path.storePathHash} (${path.reason}: ${missingGraceRemedies[path.reason]})`
					)
					.join(', ')
		);
		this.name = 'GraceDeadlineMissingError';
	}
}

export class CacheGraceMissingError extends CodedError {
	constructor(public readonly cache: CacheScope) {
		super(
			`${cache.kind === 'default' ? 'The default cache' : `Cache ${cache.name}`} has no configured grace: set it with \`cupboard cache set-grace\` or publish without require-grace`
		);
		this.name = 'CacheGraceMissingError';
	}
}
