import { operationSchema } from '@cupboard/protocol/grants';
import { formatErrorWithCauses } from '@cupboard/shared/errors';
import { RequestError } from '@octokit/request-error';
import { ORPCError } from '@orpc/client';
import { APIError } from 'cloudflare';
import { CommanderError } from 'commander';
import { z } from 'zod';

import {
	GithubOidcRequestError,
	GithubOidcResponseError,
	GithubOidcUnavailableError
} from './auth/github-oidc.ts';
import { OidcLoginError } from './auth/oidc-login.ts';
import { CloudflareLoginError } from './deploy/cloudflare-oauth.ts';
import * as errors from './errors.ts';
import { humanOperation } from './human-permissions.ts';

export interface HumanErrorOptions {
	readonly debug?: boolean;
	readonly action?: string;
	readonly target?: URL;
}

/**
Describes a command failure for the person running the command.
*/
export function formatHumanError(
	error: unknown,
	options: HumanErrorOptions = {}
): string {
	const summary =
		authenticationError(error, options) ??
		requestError(error, options) ??
		validationError(error) ??
		publicationError(error) ??
		deploymentError(error, options) ??
		ordinaryError(error, options);

	if (options.debug !== true) {
		return redactCredentials(summary);
	}

	return redactCredentials(`${summary}\n${formatErrorWithCauses(error)}`);
}

function loginCommand(options: HumanErrorOptions): string {
	return `cupboard login ${options.target?.href.replace(/\/$/u, '') ?? '<url>'}`;
}

function operation(options: HumanErrorOptions): string {
	return `${options.action ?? 'complete this command'}${options.target === undefined ? '' : ` for ${options.target.href.replace(/\/$/u, '')}`}`;
}

function authenticationError(
	error: unknown,
	options: HumanErrorOptions
): string | undefined {
	if (
		error instanceof errors.SessionRejectedError ||
		error instanceof errors.OwnerLoginRequiredError
	) {
		return `Your saved sign-in was refused. Run \`${loginCommand(options)}\` to sign in again.`;
	}

	if (error instanceof errors.ScopeForbiddenError) {
		return `You do not have permission to ${operation(options)}. Ask the tenant administrator or deployment operator to grant this access.`;
	}

	if (error instanceof errors.MissingGrantError) {
		const parsed = operationSchema.safeParse(error.operation);
		const action = parsed.success
			? humanOperation(parsed.data)
			: 'perform this operation';
		return `You do not have permission to ${action} on root ${error.root}. Ask the tenant administrator to grant this access.`;
	}

	if (error instanceof GithubOidcUnavailableError) {
		return 'This command needs a GitHub Actions job with `permissions: id-token: write`. Add that permission to the publishing job.';
	}

	if (
		error instanceof GithubOidcRequestError ||
		error instanceof GithubOidcResponseError
	) {
		return 'GitHub could not provide the publishing identity. Check the job permissions and retry the workflow.';
	}

	if (error instanceof CloudflareLoginError) {
		return 'Cloudflare sign-in failed. Sign in again and check that the account permits this deployment.';
	}

	if (error instanceof OidcLoginError) {
		return oidcLoginError(error, options);
	}

	return undefined;
}

function oidcLoginError(
	error: OidcLoginError,
	options: HumanErrorOptions
): string {
	switch (error.kind) {
		case 'authorization-declined':
		case 'device-denied': {
			return `Sign-in was declined. Run \`${loginCommand(options)}\` again to authorise access.`;
		}
		case 'loopback-bind': {
			return 'The local sign-in callback could not start. Close another sign-in attempt or use --headless to sign in on another device.';
		}
		case 'loopback-timeout':
		case 'device-expired': {
			return `Sign-in timed out. Run \`${loginCommand(options)}\` again and complete the browser instructions.`;
		}
		case 'unsupported-device-flow': {
			return 'This identity provider does not support signing in on another device. Sign in from a machine with a browser.';
		}
		default: {
			return `The identity provider could not complete sign-in. Check the provider and client settings, then run \`${loginCommand(options)}\` again. Use --debug for diagnostic information.`;
		}
	}
}

function requestError(
	error: unknown,
	options: HumanErrorOptions
): string | undefined {
	if (error instanceof errors.UnreachableHostError) {
		return `Could not connect to ${error.host}. Check the deployment URL and your network connection, then retry.`;
	}

	if (error instanceof errors.AdminApiTransientError) {
		return 'The server is temporarily unavailable or busy. Wait a moment, then retry the command.';
	}

	if (error instanceof errors.CupboardHttpError) {
		const oauth = oauthFailure(error, options);
		if (oauth !== undefined) {
			return oauth;
		}
		return httpError(error.status, options);
	}

	if (error instanceof APIError) {
		return 'Cloudflare could not complete the deployment request. Check the account permissions and deployment status before retrying. Use --debug for diagnostic information.';
	}

	if (error instanceof RequestError) {
		return 'GitHub could not complete the repository request. Check the repository reference and your GitHub access, then retry. Use --debug for diagnostic information.';
	}

	if (error instanceof ORPCError) {
		const code: unknown = error.code;
		return rpcError(typeof code === 'string' ? code : 'UNKNOWN', options);
	}

	if (error instanceof errors.CupboardResponseError) {
		return 'The deployment returned an unexpected response. Check that the CLI and deployment versions are compatible. Use --debug for diagnostic information.';
	}

	return undefined;
}

function oauthFailure(
	error: errors.CupboardHttpError,
	options: HumanErrorOptions
): string | undefined {
	const oauth = error.oauthError;
	if (oauth === undefined) {
		return undefined;
	}
	if (oauth.error === 'invalid_grant') {
		return `Your saved sign-in can no longer be renewed. Run \`${loginCommand(options)}\` to sign in again.`;
	}
	if (oauth.error === 'invalid_request') {
		switch (oauth.problem) {
			case 'subject-token-untrusted': {
				return 'This sign-in identity is not trusted for the requested access. Ask the tenant administrator or deployment operator to review the trust rules for the identity provider.';
			}
			case 'subject-token-claim-mismatch': {
				return 'The sign-in identity does not match the trust-rule restrictions. Ask the tenant administrator or deployment operator to review the identity claims and required permissions.';
			}
			case 'subject-token-invalid': {
				return `The sign-in identity could not be verified. Run \`${loginCommand(options)}\` again. If the problem continues, ask the administrator to check the identity provider settings.`;
			}
			default: {
				return 'The requested sign-in could not be accepted. Check the identity provider and required permissions. Use --debug for diagnostic information.';
			}
		}
	}
	if (oauth.error === 'invalid_authorization_details') {
		return 'The requested permissions could not be accepted. Review the job permissions and trust-rule restrictions. Use --debug for diagnostic information.';
	}
	return undefined;
}

function httpError(status: number, options: HumanErrorOptions): string {
	if (status === 401) {
		return `Sign-in was refused. Run \`${loginCommand(options)}\` to sign in again.`;
	}

	if (status === 403) {
		return `You do not have permission to ${operation(options)}. Ask the tenant administrator or deployment operator to grant this access.`;
	}

	if ([408, 429, 503].includes(status)) {
		return 'The server is temporarily unavailable or busy. Wait a moment, then retry the command.';
	}

	return options.action === 'publish'
		? 'The server could not complete the request. Publication may be incomplete. Check its status before retrying.'
		: 'The server could not complete the request. Check whether the requested change was applied before retrying. Use --debug for diagnostic information.';
}

function rpcError(code: string, options: HumanErrorOptions): string {
	const target = options.target?.href.replace(/\/$/u, '') ?? '<url>';
	switch (code) {
		case 'UNAUTHORIZED': {
			return httpError(401, options);
		}
		case 'FORBIDDEN': {
			return httpError(403, options);
		}
		case 'SIGNING_KEY_ROTATION_IN_PROGRESS': {
			return `A signing-key rotation is already updating the cache signatures. Use \`cupboard key status ${target}\` to check its progress before starting another rotation.`;
		}
		case 'SIGNING_KEY_BACKFILL_INCOMPLETE': {
			return `The cache signatures are still being updated. Check \`cupboard key status ${target}\` and wait for completion before retiring a signing key.`;
		}
		case 'SIGNING_KEY_ROTATION_ABORT_NOT_ALLOWED': {
			return `This signing-key rotation cannot be cancelled. Check \`cupboard key status ${target}\` before changing the signing keys.`;
		}
		case 'CACHE_ACCESS_MIGRATION_PENDING': {
			return 'The cache access change is still being applied. Check the cache settings before retrying.';
		}
		case 'CACHE_RETENTION_MIGRATION_PENDING': {
			return 'The cache retention change is still being applied. Check the cache settings before retrying.';
		}
		case 'CACHE_GRANT_MIGRATION_PENDING': {
			return 'The cache permissions are still being updated. Review the trust rule before retrying.';
		}
		case 'CACHE_LISTING_PROJECTION_PENDING': {
			return 'The list of caches is still being updated. Wait a moment, then list the caches again.';
		}
		case 'CACHE_ALREADY_EXISTS': {
			return 'The cache already exists. Inspect its settings before updating it, or choose a different cache name.';
		}
		case 'CACHE_NOT_EMPTY': {
			return 'The cache still contains published paths. Review the contents and remove the paths before removing the cache, or use --force after reviewing the consequences.';
		}
		case 'CACHE_CLOSED': {
			return 'The cache is closed to new publication. Reopen the cache if publication should continue.';
		}
		case 'CACHE_RETIREMENT_TTL_REQUIRED': {
			return 'Automatic cache retirement needs a finite retention period. Set --retention-ttl before enabling retirement.';
		}
		case 'CACHE_RETENTION_RULE_LIMIT_EXCEEDED': {
			return 'The cache has too many retention rules. Simplify the retention settings before retrying.';
		}
		case 'OIDC_TRUST_RULE_CHANGED': {
			return 'The trust rule changed while this command was running. Review the current rule and run the command again.';
		}
		case 'INSUFFICIENT_STORAGE': {
			return `The tenant has insufficient storage for this request. ${errors.overQuotaAdvice}`;
		}
		case 'NOT_FOUND': {
			return 'The requested resource was not found. Check the deployment or tenant URL and the resource ID.';
		}
		case 'BAD_REQUEST': {
			return 'The deployment rejected the command options. Check the command help and supplied values. Use --debug for diagnostic information.';
		}
		default: {
			return unknownError(options);
		}
	}
}

function validationError(error: unknown): string | undefined {
	if (error instanceof z.ZodError) {
		return `Invalid command input. ${validationIssues(error)}`;
	}

	if (error instanceof errors.InvalidCacheCredentialsError) {
		return error.cause instanceof z.ZodError
			? `Invalid cache credentials. ${validationIssues(error.cause)}`
			: 'Invalid cache credentials. Supply a JSON array with a cache scope, user and password for each selected cache.';
	}

	if (
		error instanceof errors.InvalidCohortTargetsFileError ||
		error instanceof errors.InvalidMeasureTargetsFileError
	) {
		return `Invalid workflow targets file ${error.path}. Check the file against the automation command reference. Use --debug for diagnostic information.`;
	}

	if (error instanceof errors.InvalidClaimError) {
		return 'Invalid trust-rule claim. Supply --claim key=value, or check the rule file against the trust-rule reference. Use --debug for diagnostic information.';
	}

	if (error instanceof errors.AttestationBundleInvalidError) {
		return `Invalid attestation bundle ${error.path}. Supply a Sigstore bundle with an in-toto statement. Use --debug for diagnostic information.`;
	}

	return undefined;
}

function validationIssues(error: z.ZodError): string {
	return error.issues
		.map(
			(issue) =>
				`${issue.path.map(String).join('.') || 'input'}: ${validationConstraint(issue)}.`
		)
		.join(' ');
}

function validationConstraint(issue: z.core.$ZodIssue): string {
	switch (issue.code) {
		case 'invalid_type': {
			return `expected ${issue.expected}`;
		}
		case 'too_small': {
			return `must be at least ${String(issue.minimum)}`;
		}
		case 'too_big': {
			return `must be at most ${String(issue.maximum)}`;
		}
		case 'unrecognized_keys': {
			return `remove unsupported fields ${issue.keys.join(', ')}`;
		}
		case 'custom': {
			return issue.message;
		}
		default: {
			return 'check the value against the command reference';
		}
	}
}

function publicationError(error: unknown): string | undefined {
	if (
		error instanceof errors.CommitCapacityTimeoutError ||
		error instanceof errors.CommitCapacityQueuedError
	) {
		return 'Publication could not continue because the server is busy. Previously completed paths remain published. Retry the push later.';
	}

	if (
		error instanceof errors.CommitSocketProtocolError ||
		error instanceof errors.UnexpectedUploadDecisionError ||
		error instanceof errors.UploadNegotiationMismatchError
	) {
		return 'The deployment returned an unexpected publication response. Check the published paths before retrying. Use --debug for diagnostic information.';
	}

	if (
		error instanceof errors.AttestationBundleResponseMismatchError ||
		error instanceof errors.AttestationAttachResponseMismatchError ||
		error instanceof errors.UnexpectedAttestationDecisionError ||
		error instanceof errors.AttestationNegotiationMismatchError
	) {
		return 'The deployment returned an unexpected attestation result. Check the path attestations before retrying. Use --debug for diagnostic information.';
	}

	if (
		error instanceof errors.AttestationUploadUnavailableError ||
		error instanceof errors.AttestationBundleTransportUnavailableError
	) {
		return 'This deployment does not support the requested attestation upload. Check that the CLI and deployment versions are compatible.';
	}

	if (error instanceof errors.UploadWaitTimeoutError) {
		return `Publication checks are still pending for ${String(error.pending)} paths after ${String(error.timeoutSeconds)} seconds. The server may still publish them. Retry the push later and contact the tenant administrator if the delay continues.`;
	}

	if (error instanceof errors.UploadVerificationFailedError) {
		switch (error.status) {
			case 'mismatch': {
				return 'An uploaded archive did not match its declared checksum. Run `cupboard push` again to retry.';
			}
			case 'over-quota': {
				return `Publication would exceed the tenant's storage quota. ${errors.overQuotaAdvice}`;
			}
			case 'absent': {
				return 'The uploaded archive was not stored. Run `cupboard push` again to retry.';
			}
		}
	}

	if (error instanceof errors.UploadGraceFactsUnsupportedError) {
		return 'This deployment cannot report how long unretained paths will remain available. Upgrade the deployment before publishing without retention or using this preview.';
	}

	if (error instanceof errors.PushNarMetadataMismatchError) {
		return `The archive of ${error.storePath} does not match the local Nix store's recorded checksum or size. Check the path in the selected Nix store before retrying publication. Use --debug for diagnostic information.`;
	}

	if (
		error instanceof errors.BuildOutputDivergedError ||
		error instanceof errors.AttestationDivergedPathError
	) {
		return `${error.storePath} contains different bytes in the build store and destination cache. Check the build for reproducibility before changing the cached path. Use --debug to compare the checksums.`;
	}

	if (error instanceof errors.AttestationPathUnservableError) {
		return `The cache no longer serves path ${error.storePathHash}. The attestation was not attached. Publish the path again before attaching the attestation.`;
	}

	if (error instanceof errors.PathsNotConfirmedError) {
		return `Availability could not be confirmed for these paths, so their retention was not extended: ${error.storePaths.join(', ')}. Review the path status before retrying publication or retention.`;
	}

	if (error instanceof errors.ConfirmIncompleteError) {
		return `${String(error.confirmedBatches)} of ${String(error.totalBatches)} groups of paths had their retention extended before the command failed. Completed extensions remain in effect. ${formatHumanError(error.cause)}`;
	}

	if (error instanceof errors.ReferenceUploadRequiredError) {
		return `The destination no longer has the archive for ${error.storePath}. Publish the path from a Nix store that contains it before retrying publication by reference.`;
	}

	if (error instanceof errors.TokenProviderError) {
		return 'The publishing credential could not be obtained. Check the configured credential provider. Use --debug for diagnostic information.';
	}

	return undefined;
}

function deploymentError(
	error: unknown,
	options: HumanErrorOptions
): string | undefined {
	if (error instanceof errors.LocalStepUnreachedError) {
		const target =
			error.url?.href.replace(/\/$/u, '') ??
			options.target?.href.replace(/\/$/u, '') ??
			'<url>';
		return `${String(error.pending)} tenant updates have not completed${error.stragglers.length === 0 ? '' : `: ${error.stragglers.join(', ')}`}. Run \`cupboard deployment status ${target}\` to inspect the updates, then \`cupboard deployment resume ${target}\` to retry them. Complete the deployment with the same release and source if deployment changes remain unfinished.`;
	}

	if (error instanceof errors.WorkersNotServingBuildError) {
		return `The uploaded release ${error.buildVersion} is not yet serving all deployment traffic. Wait for Cloudflare to complete the rollout, then rerun deployment with the same release and source.`;
	}

	if (error instanceof errors.TransitionNotExpandedError) {
		return 'Deployment preparation is incomplete. Rerun deployment with the same release and source before continuing.';
	}

	if (error instanceof errors.TransitionIncompleteError) {
		const releaseConstraint =
			error.completedBy === undefined
				? 'Do not deploy a release older than the currently deployed release.'
				: `The intermediate release must be ${error.completedBy} or later and must not be older than the currently deployed release.`;
		return `An earlier upgrade must complete before this release can be deployed. Run again with --debug to check which releases can complete the upgrade before choosing an intermediate release. ${releaseConstraint} If the currently deployed release is compatible, rerun it with the same source to finish the earlier upgrade, then deploy this release.`;
	}

	if (
		error instanceof errors.MisclassifiedD1MigrationsError ||
		error instanceof errors.TransitionMigrationsMissingError
	) {
		return 'The release database changes do not match the recorded deployment state. Deployment stopped before proceeding. Check the release and deployment history with --debug before changing the database.';
	}

	return undefined;
}

function ordinaryError(error: unknown, options: HumanErrorOptions): string {
	if (error instanceof errors.CliError && error.humanMessage !== undefined) {
		return error.humanMessage;
	}

	if (error instanceof errors.QuotaExceededError) {
		return `The tenant has insufficient storage for this request. ${errors.overQuotaAdvice}`;
	}

	if (error instanceof errors.TenantOffboardingError) {
		return `Tenant ${error.tenant} is being removed. Its settings can no longer be changed, and removal cannot be undone. Use \`cupboard tenant list ${options.target?.origin ?? '<url>'}\` to check whether removal has finished.`;
	}

	if (
		error instanceof errors.CacheInfoTimeoutError ||
		error instanceof errors.CacheInfoRateLimitedError ||
		error instanceof errors.CacheInfoServerError
	) {
		return `The cache at ${error.target.href} is temporarily unavailable or busy. Check the URL and network connection, then retry.`;
	}

	if (
		error instanceof errors.CacheInfoUnavailableError ||
		error instanceof errors.NarInfoUnavailableError
	) {
		return `Could not read cache information from ${error.target.href}. Check the URL, cache availability and read credentials. Use --debug for diagnostic information.`;
	}

	if (
		error instanceof errors.CacheInfoUnparsableError ||
		error instanceof errors.NarInfoUnparsableError ||
		error instanceof errors.ReferencePathMismatchError
	) {
		return 'The cache returned invalid path information. Check the cache URL and server version before retrying. Use --debug for diagnostic information.';
	}

	if (error instanceof errors.InvalidWorkerUrlError) {
		return 'Invalid deployment or tenant URL. Use a URL such as https://cupboard.example.workers.dev or https://cupboard.example.workers.dev/t/acme.';
	}

	if (error instanceof errors.InvalidWorkerUrlBaseError) {
		return 'The deployment or tenant URL must not include credentials, a query string or a fragment.';
	}

	if (error instanceof errors.CheckDiscrepanciesError) {
		return 'The cache integrity check found problems. Review the reported paths and ask the tenant administrator to investigate.';
	}

	if (
		error instanceof errors.CliUsageError ||
		error instanceof CommanderError ||
		isSafeDomainError(error)
	) {
		return error.message;
	}

	return unknownError(options);
}

function unknownError(options: HumanErrorOptions): string {
	return `Could not ${operation(options)}. Run again with --debug for diagnostic information.`;
}

function redactCredentials(message: string): string {
	return message
		.replaceAll(
			/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s;,]+/giu,
			'$1[redacted]'
		)
		.replaceAll(
			/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/giu,
			'$1[redacted]@'
		)
		.replaceAll(
			/(["'](?:access_token|refresh_token|id_token|client_secret|accessToken|refreshToken|idToken|clientSecret|apiToken|password)["']\s*:\s*["'])[^"']+/giu,
			'$1[redacted]'
		)
		.replaceAll(
			/((?:access_token|refresh_token|id_token|client_secret|accessToken|refreshToken|idToken|clientSecret|apiToken|password)=)[^\s&;,"'}]+/giu,
			'$1[redacted]'
		);
}

function isSafeDomainError(error: unknown): error is Error {
	return (
		error instanceof errors.CliAbortError ||
		error instanceof errors.SigningKeyNotFoundError ||
		error instanceof errors.QuotaBelowUsageError ||
		error instanceof errors.PushIncompleteError ||
		error instanceof errors.AttestationSubjectNotPushedError ||
		error instanceof errors.GithubSetupDriftError ||
		error instanceof errors.GithubCheckFailedError ||
		error instanceof errors.GithubCheckIncompleteError ||
		error instanceof errors.GithubSetupRemovalError ||
		error instanceof errors.BuildCommandFailedError ||
		error instanceof errors.BuildObservationMissingError ||
		error instanceof errors.BuildRebuildRemoteDispatchError ||
		error instanceof errors.BuildPublicationFailedError
	);
}
