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

/** A canonical cupboard coordinate could not be decoded from the job output. */
export class CupboardResolutionJsonError extends UsageError {
	constructor(public override readonly cause: unknown) {
		super('resolved-cupboard is not valid canonical JSON', { cause });
		this.name = 'CupboardResolutionJsonError';
	}
}

/** GitHub returned a release-discovery page outside its declared schema. */
export class MalformedReleaseDiscoveryResponseError extends CodedError {
	constructor(options: { readonly cause?: unknown } = {}) {
		super(
			'the GitHub GraphQL API returned an unexpected release response',
			withCause(options.cause)
		);
		this.name = 'MalformedReleaseDiscoveryResponseError';
	}
}

/** Release discovery exceeded the bounded response and pagination policy. */
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

/** A release asset URL is unsafe for an authenticated GitHub API request. */
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

/** A release asset exceeded the bounded size accepted by the action. */
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

/** A release attestation bundle exceeded the action's bounded input size. */
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

/** An attestation lookup exceeded the bounded candidate or page policy. */
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

/** A historical release cannot satisfy the current action's runtime contract. */
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

/** A release archive's executable does not identify as the selected tag. */
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

/** A verified release archive omitted an executable required at runtime. */
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

/** An installed executable no longer has the bytes in its verified archive. */
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

/** Persisted installation state cannot be trusted for recovery. */
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

/** A persisted installation lock is corrupt or from an unsupported installer. */
export class ReleaseInstallationLockStateError extends CodedError {
	constructor(public readonly lockPath: string) {
		super(
			`Cupboard release installation lock ${lockPath} has an unsupported owner record; confirm no installation is running before removing it`
		);
		this.name = 'ReleaseInstallationLockStateError';
	}
}

/** The installer could not identify a process strongly enough to fence its lock. */
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

/** The installer was fenced out before it could commit its release. */
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

/** An expired lease still names the same process that acquired the lock. */
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

/** A release failed to publish and its previous installation was not fully restored. */
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

/** A supplied executable succeeded but did not identify its version. */
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
 * Every published attestation candidate failed acquisition or verification.
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

/**
 * A receipt subject whose committed NAR hash differs from the destination's.
 */
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

/**
 * A receipt subject whose committed deriver differs from the destination's.
 */
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

/**
 * A receipt subject for which no committed destination metadata was supplied.
 */
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

/** A committed narinfo could not be read from the destination cache. */
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

/** A destination response was not a valid narinfo for the requested subject. */
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

/** Realised outputs for which a current-run provenance receipt cannot be made. */
export class ProvenanceSubjectsIncompleteError extends CodedError {
	constructor(public readonly storePaths: readonly string[]) {
		super(
			`Could not establish current-run build provenance for: ${storePaths.join(', ')}`
		);
		this.name = 'ProvenanceSubjectsIncompleteError';
	}
}

/** The installed CLI emitted no valid attachment result. */
export class AttestationAttachmentResultError extends CodedError {
	constructor(message: string, options: { readonly cause?: unknown } = {}) {
		super(message, withCause(options.cause));
		this.name = 'AttestationAttachmentResultError';
	}
}

/** Signed receipt subjects without a completed attachment. */
export class AttestationAttachmentIncompleteError extends CodedError {
	constructor(public readonly storePaths: readonly string[]) {
		super(
			`Attestation attachment was incomplete for: ${storePaths.join(', ')}`
		);
		this.name = 'AttestationAttachmentIncompleteError';
	}
}

/** Receipt subjects whose signed checksum is absent or no longer exact. */
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

/** The build-origin predicate file is not readable as a JSON object to sign. */
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

/**
 * The reuse-view priority check fetched `nix-cache-info` for the destination
 * cache or for the view, and the response had a non-2xx status.
 */
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

/**
 * The reuse-view priority check could not parse a `nix-cache-info` document it
 * fetched. Nix itself would default a missing priority to 30, but the check
 * must not guess: it needs the real value to compare, so the parse failure
 * carries through as the cause.
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
 * Raised when a configured reuse view's priority is not numerically greater
 * than the destination's. Nix tries lower priorities first, so this is the
 * destination-before-view invariant (see PLAN.md, "Named tenant reuse
 * views"): a divergent input-addressed path already adopted by the
 * destination must never be replaced by a view candidate.
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

/**
 * Two targets name the same cohort but declare different execution contexts
 * (system, os, remote). A cohort is the manifest's own statement that its
 * members run together in one job, so members that could never share a job
 * are a manifest error, not a planning decision to resolve either way.
 */
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

/**
 * One cohort groups a best-effort target with a required target. A cohort runs
 * as one job, so its members must agree whether failure is tolerated rather
 * than silently overriding one target's declaration.
 */
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

/**
 * A publish matrix asks for more jobs than GitHub runs for a single matrix.
 * Raised at plan time, naming the matrix and the counts, so the operator can
 * split the manifest.
 */
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
 * A component-publication target declares more components than a retention
 * root accepts in one write (`rootSetMaxTargets`), which binds `root:set` and
 * `roots.ensure` identically. A larger set cannot be published today. Paging
 * that write loses the all-or-nothing `retained` property that retention
 * depends on, and a paged write would need a retention mechanism built on
 * attach with a generation marker, which cupboard does not yet have. The
 * target is therefore refused, not paged or truncated.
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
			`Timed out probing ${url}; the cache did not answer within the probe deadline`
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

/** A captured command exceeded the memory budget for its standard output. */
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
	readonly kind: 'target' | 'protocol';
	readonly outcome: string;
	readonly message: string;
}

/** A remote keep-going build did not report one final result per target. */
export class RemoteCohortBuildFailedError extends CodedError {
	constructor(public readonly failures: readonly RemoteCohortBuildFailure[]) {
		super(
			`Remote Nix did not report exactly one final result for every requested target. Valid outputs were published before the action failed: ${failures.map((failure) => `${failure.target} (${failure.outcome}: ${failure.message})`).join('; ')}`
		);
		this.name = 'RemoteCohortBuildFailedError';
	}
}

/** A remote daemon returned a malformed keyed result batch. */
export class RemoteCohortProtocolError extends CodedError {
	constructor(public readonly failures: readonly RemoteCohortBuildFailure[]) {
		super(
			`Remote Nix daemon returned an invalid keyed result batch: ${failures.map((failure) => `${failure.target} (${failure.outcome}: ${failure.message})`).join('; ')}`
		);
		this.name = 'RemoteCohortProtocolError';
	}
}

export interface CohortEvaluationMismatch {
	readonly installable: string;
	readonly planned: string;
	readonly evaluated: readonly string[];
}

/** A local installable no longer evaluates to its planned derivation. */
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
 * The cupboard binary exited non-zero. It has already reported the cause
 * through its own output, so this error adds no diagnosis of its own: it
 * carries the exit status the action adopts and any result events the run
 * recorded before it failed.
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

/**
 * A `cupboard push` succeeded but recorded no push summary, so the action has
 * no counts to publish as its outputs. `kinds` lists the result kinds the run
 * did record, so a caller inspecting the error can see what it produced
 * instead.
 */
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
 * yet produced a deadline. If the cache has no grace policy, the cache-level
 * {@link GracePolicyMissingError} is used instead.
 */
export interface MissingGracePath {
	readonly storePathHash: string;
	readonly storePath?: string;
	readonly reason: 'not-present' | 'pending';
}

// The remedy for each missing-grace reason. It is rendered alongside the
// reason so the operator can act on the failure without reading cupboard's
// source.
const missingGraceRemedies: Record<MissingGracePath['reason'], string> = {
	'not-present':
		'no longer committed at the destination; rebuild or republish the path',
	pending:
		'its deferred upload has not completed; retry once the push completes'
};

/**
 * Raised when `require-grace` is set and at least one path has no positive
 * grace deadline.
 */
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

/**
 * The destination cache has no grace policy while the push uses
 * `require-grace`. The publication fails because an unretained path would have
 * no retention deadline. Grace policies apply to the cache, so one missing
 * grace fact indicates that every path is uncovered.
 */
export class GracePolicyMissingError extends CodedError {
	constructor(public readonly cache: string) {
		super(
			`No grace policy covers ${cache === '' ? 'the default cache' : `cache ${cache}`}: add one with \`cupboard policy add-grace\` or publish without require-grace`
		);
		this.name = 'GracePolicyMissingError';
	}
}
