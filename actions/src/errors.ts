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

export class DuplicateRunnerLabelError extends UsageError {
	constructor(public readonly label: string) {
		super(
			`runner label '${label}' is configured more than once. Duplicate ` +
				`entries make the routing order-dependent, and a bare duplicate ` +
				`would silently replace a group-pinned route, so each label must ` +
				`appear exactly once.`
		);
		this.name = 'DuplicateRunnerLabelError';
	}
}

export class RunnerNotAllowedError extends UsageError {
	constructor(public readonly labels: readonly string[]) {
		super(
			`the target manifest requests runner labels the workflow does not ` +
				`allow: ${labels.join(', ')}. The manifest is evaluated from the ` +
				`flake, so an arbitrary label would let a pull request route its ` +
				`build onto a privileged runner; every permitted label must be ` +
				`named in the CUPBOARD_RUNNERS repository variable, which only a ` +
				`repository operator can edit. Add the labels there, and verify ` +
				`locally with \`cupboard github check --manifest\`.`
		);
		this.name = 'RunnerNotAllowedError';
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

export class DuplicateGroupKeyError extends CodedError {
	constructor(public readonly key: string) {
		super(`Two publish plan groups share the key ${key}`);
		this.name = 'DuplicateGroupKeyError';
	}
}

export class ConfirmCommandError extends CodedError {
	readonly wasReported: boolean;

	constructor(options: {
		readonly cause: unknown;
		readonly wasReported?: boolean;
	}) {
		super('Could not confirm the destination-resident paths', {
			cause: options.cause
		});
		this.name = 'ConfirmCommandError';
		this.wasReported = options.wasReported ?? false;
	}
}

export class ConfirmResultMissingError extends CodedError {
	constructor() {
		super(
			'Cupboard recorded no result while confirming the destination-resident paths'
		);
		this.name = 'ConfirmResultMissingError';
	}
}

export class ConfirmResultInvalidError extends CodedError {
	constructor(options: { readonly cause: unknown }) {
		super(
			'Cupboard recorded an invalid result while confirming the destination-resident paths',
			{ cause: options.cause }
		);
		this.name = 'ConfirmResultInvalidError';
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

export class IntermediateRootInvalidError extends UsageError {
	constructor(public readonly limit: number) {
		super(
			`the generated intermediate retention root is invalid; shorten root-prefix ` +
				`and ensure system and runner labels contain no control characters so the ` +
				`root is at most ${String(limit)} characters`
		);
		this.name = 'IntermediateRootInvalidError';
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
export class CacheProbeError extends CodedError {
	constructor(
		public readonly storePath: string,
		public readonly status: number
	) {
		super(`Could not check ${storePath} in the cache: HTTP ${String(status)}`);
		this.name = 'CacheProbeError';
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
 * One path a `require-grace` push cannot account for: `no-policy-matched`
 * names a path whose grace fact was empty (no cache policy covers it),
 * `pending` one whose fact carried only a captured `graceSeconds`, still
 * awaiting the deferred upload that would materialise its deadline.
 */
export interface MissingGracePath {
	readonly storePathHash: string;
	readonly storePath?: string;
	readonly reason: 'no-policy-matched' | 'pending';
}

/**
 * Raised when `require-grace` is set and the push report names at least one
 * path with no positive grace deadline: the publication half of grace mode's
 * fail-closed rule (see PLAN.md, "Planning and destination adoption").
 */
export class GraceDeadlineMissingError extends CodedError {
	constructor(public readonly paths: readonly MissingGracePath[]) {
		super(
			`${String(paths.length)} path(s) lack a positive grace deadline: ` +
				paths
					.map(
						(path) => `${path.storePath ?? path.storePathHash} (${path.reason})`
					)
					.join(', ')
		);
		this.name = 'GraceDeadlineMissingError';
	}
}
