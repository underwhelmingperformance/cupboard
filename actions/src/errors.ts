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
 * A `nix-cache-info` fetch the reuse-view priority check issued, for either
 * the destination cache or the view, came back with a non-2xx status.
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
 * A `nix-cache-info` document the reuse-view priority check fetched failed to
 * parse. Nix itself would default a missing priority to 30, but the check must
 * not guess: it needs the real value to compare, so the parse failure carries
 * through as the cause.
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
 * `roots.ensure` identically. A larger set has no remedy today: paging that
 * write loses the all-or-nothing `retained` property retention depends on, so
 * it needs a retention shape built on attach with a generation marker, which
 * cupboard does not yet have, and the target is refused rather than paged or
 * truncated.
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
				`write; a larger component set needs a retention shape built on ` +
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
 * The cupboard binary exited non-zero. It reported the cause itself through its
 * own output, so this carries only the exit status (which the action adopts as
 * its own) and any result events the run recorded before failing.
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
 * A `cupboard push` succeeded but recorded no push summary, so the action has no
 * counts to publish as its outputs. `kinds` lists the result kinds the run did
 * record, to show what arrived in the summary's place.
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
 * The cohort's own availability partition, computed on this runner's store,
 * refused to build: either the unknown-availability count settled over the
 * configured ceiling, or the measured substitutable bytes would not fit this
 * store. The refusing `cupboard plan cohort` invocation already exited with
 * the distinguishing sysexit (a routine transient for a ceiling breach, an
 * unavailable resource for a capacity refusal), which this error adopts as
 * its own so the job fails with the same numeric meaning.
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
 * One path a `require-grace` publication cannot account for: `not-present`
 * names a path the confirm no longer found committed at the destination, and
 * `pending` one whose fact carried only a captured `graceSeconds`, still
 * awaiting the deferred upload that would materialise its deadline. A path
 * with no grace fact at all is not a per-path condition: grace resolution is
 * cache-level, so an uncovered cache raises {@link GracePolicyMissingError}
 * instead.
 */
export interface MissingGracePath {
	readonly storePathHash: string;
	readonly storePath?: string;
	readonly reason: 'not-present' | 'pending';
}

/**
 * Raised when `require-grace` is set and the push report names at least one
 * path with no positive grace deadline: the publication half of grace mode's
 * fail-closed rule (see PLAN.md, "Planning and destination adoption").
 */
// The remedy each missing-grace reason points the operator at, rendered
// alongside the reason so the failure is actionable without reading cupboard
// source.
const missingGraceRemedies: Record<MissingGracePath['reason'], string> = {
	'not-present':
		'no longer committed at the destination; rebuild or republish the path',
	pending: 'its deferred upload has not settled; retry once the push completes'
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

/**
 * The destination cache has no covering grace policy while the push publishes
 * with `require-grace`. Without a policy nothing keeps an unretained path
 * alive, so the publication fails closed; a fact-less path shows the policy
 * is absent or vanished mid-run, and since resolution is cache-level, one
 * such path implies every path.
 */
export class GracePolicyMissingError extends CodedError {
	constructor(public readonly cache: string) {
		super(
			`No grace policy covers ${cache === '' ? 'the default cache' : `cache ${cache}`}: add one with \`cupboard policy add-grace\` or publish without require-grace`
		);
		this.name = 'GracePolicyMissingError';
	}
}
