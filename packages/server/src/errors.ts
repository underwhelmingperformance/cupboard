import {
	type AuthKeyId,
	type CacheAccessMode,
	type CacheScope,
	type NixSha256HashString,
	type RootName,
	type SigningKeyId,
	type StoreDirectory,
	type StorePathHash,
	type StorePathString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import {
	type OidcIssuer,
	type SubjectTokenProblem,
	subjectTokenProblems
} from '@cupboard/protocol/oidc';
import { type ClaimMismatch } from '@cupboard/protocol/oidc-trust-match';
import { type TenantStatus } from '@cupboard/protocol/tenants';
import { type UploadId } from '@cupboard/protocol/upload';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { type R2ObjectKey } from './http/http.ts';

export abstract class ServerHttpError extends Error {
	abstract readonly status: number;

	// The Hono error renderer sends this value as Retry-After and marks the
	// response no-store.
	readonly retryAfterSeconds?: number;
}

export class DeploymentStateConflictError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor() {
		super('The deployment state or revision no longer matches this request');
		this.name = 'DeploymentStateConflictError';
	}
}

export abstract class InvalidRequestBodyError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;
}

export class MalformedRequestBodyError extends InvalidRequestBodyError {
	constructor(public override readonly cause: SyntaxError) {
		super('Malformed JSON request body');
		this.name = 'MalformedRequestBodyError';
	}
}

export class RequestBodySchemaMismatchError extends InvalidRequestBodyError {
	constructor(public override readonly cause: z.ZodError) {
		super(z.prettifyError(cause));
		this.name = 'RequestBodySchemaMismatchError';
	}
}

export class ColdPathTtlConfigurationInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly value: string) {
		super('CUPBOARD_COLD_PATH_TTL_SECONDS is not a valid TTL');
		this.name = 'ColdPathTtlConfigurationInvalidError';
	}
}

export type CacheCatalogueMigrationProblem =
	'tenant-missing' | 'lifecycle-incomplete' | 'lifecycle-invalid';

export class CacheCatalogueMigrationError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(
		public readonly tenant: TenantId,
		public readonly problem: CacheCatalogueMigrationProblem,
		public override readonly cause?: Error
	) {
		super(
			problem === 'tenant-missing'
				? 'The tenant registry row is missing during cache catalogue migration'
				: problem === 'lifecycle-incomplete'
					? 'A cache lifecycle is incomplete during cache catalogue migration'
					: 'A cache lifecycle is invalid during cache catalogue migration'
		);
		this.name = 'CacheCatalogueMigrationError';
	}
}

export class CommitCreditBudgetInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly value: string) {
		super('CUPBOARD_COMMIT_ENTRY_CREDIT_BUDGET is not a valid credit budget');
		this.name = 'CommitCreditBudgetInvalidError';
	}
}

export class CommitSocketCeilingInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly value: string) {
		super('CUPBOARD_COMMIT_SOCKET_CEILING is not a valid socket ceiling');
		this.name = 'CommitSocketCeilingInvalidError';
	}
}

export class OwnerConfigurationInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly issuer: OidcIssuer) {
		super('The configured owner issuer is not a valid HTTPS issuer URL');
		this.name = 'OwnerConfigurationInvalidError';
	}
}

export class OidcIssuerTransportRequiredError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(public readonly issuer: OidcIssuer) {
		super('OIDC issuers must use HTTPS');
		this.name = 'OidcIssuerTransportRequiredError';
	}
}

export class CommitUpgradeRequiredError extends ServerHttpError {
	readonly status = StatusCodes.UPGRADE_REQUIRED;

	constructor() {
		super('The commit endpoint requires a WebSocket upgrade');
		this.name = 'CommitUpgradeRequiredError';
	}
}

// An upgrade is refused when the tenant reaches either commit-session limit.
// Neither limit expresses publication capacity because entry credit paces the
// work admitted by a legitimate session.
//
// Every session counts towards the high anti-abuse limit. Sessions that did not
// negotiate credit also count towards a smaller limit because the server cannot
// pace their work.
//
// The client can poll upload status while it waits and retry after another
// session closes.
export class CommitSessionLimitError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;
	override readonly retryAfterSeconds = 5;

	constructor(public readonly limit: number) {
		super('Too many concurrent commit sessions');
		this.name = 'CommitSessionLimitError';
	}
}

export class CacheNotEmptyError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly cache: CacheScope) {
		super('The cache contains store paths. Set force to true to delete it.');
		this.name = 'CacheNotEmptyError';
	}
}

export class CacheAlreadyExistsError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly cache: CacheScope) {
		super('The requested cache already exists');
		this.name = 'CacheAlreadyExistsError';
	}
}

export class CacheNotFoundError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly cache: CacheScope) {
		super('The requested cache does not exist');
		this.name = 'CacheNotFoundError';
	}
}

export class CacheIdentityMissingError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly identity: CacheScope | { readonly id: number }) {
		super('The cache identity is missing from the cache registry');
		this.name = 'CacheIdentityMissingError';
	}
}

export class CacheAccessMismatchError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(
		public readonly cache: CacheScope,
		public readonly expected: CacheAccessMode,
		public readonly actual: CacheAccessMode
	) {
		super('The cache already exists with a different access mode');
		this.name = 'CacheAccessMismatchError';
	}
}

export class StoredRetentionPolicyInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly id: string) {
		super('The stored retention policy has no valid selector');
		this.name = 'StoredRetentionPolicyInvalidError';
	}
}

export class LastSigningKeyError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly id: SigningKeyId) {
		super('Cannot retire the last signing key');
		this.name = 'LastSigningKeyError';
	}
}

export class SigningKeyRotationInProgressError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly id: SigningKeyId) {
		super('A signing key backfill is already in progress');
		this.name = 'SigningKeyRotationInProgressError';
	}
}

export class SigningKeyBackfillIncompleteError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly id: SigningKeyId) {
		super('The signing key cannot be retired until backfill is complete');
		this.name = 'SigningKeyBackfillIncompleteError';
	}
}

export class SigningKeySequenceMissingError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('Stored signing key sequence is missing');
		this.name = 'SigningKeySequenceMissingError';
	}
}

export class SigningKeyInstanceMissingError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('Stored instance identity is missing');
		this.name = 'SigningKeyInstanceMissingError';
	}
}

export class SigningKeyVanishedError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly id: SigningKeyId) {
		super('The signing key vanished immediately after it was stored');
		this.name = 'SigningKeyVanishedError';
	}
}

export class SigningKeyRotationAbortNotAllowedError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly id: SigningKeyId) {
		super('Only an incomplete incoming signing key can be aborted');
		this.name = 'SigningKeyRotationAbortNotAllowedError';
	}
}

export class WorkersCacheUnavailableError extends Error {
	constructor() {
		super('Workers Cache is not available to the tenant Worker');
		this.name = 'WorkersCacheUnavailableError';
	}
}

export class WorkersCachePurgeError extends Error {
	constructor(public readonly details: string) {
		super(`Workers Cache purge failed: ${details}`);
		this.name = 'WorkersCachePurgeError';
	}
}

export class StoredControlTrustInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(
		public readonly id: string,
		public override readonly cause: Error
	) {
		super('Stored control trust rule is invalid');
		this.name = 'StoredControlTrustInvalidError';
	}
}

export class ControlTrustSubjectRequiredError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor() {
		super('A control trust rule must pin a subject claim');
		this.name = 'ControlTrustSubjectRequiredError';
	}
}

// A missing deployment configuration requires operator action. Retrying the
// request cannot fix it, so the server returns 500 rather than a retryable 503.
export class ControlNotConfiguredError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('The control plane is not configured');
		this.name = 'ControlNotConfiguredError';
	}
}

export class LastControlKeyError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly kid: AuthKeyId) {
		super('Cannot retire the last control signing key');
		this.name = 'LastControlKeyError';
	}
}

export class SignupForbiddenError extends ServerHttpError {
	readonly status = StatusCodes.FORBIDDEN;

	constructor() {
		super('The signup claim did not satisfy the deployment gate');
		this.name = 'SignupForbiddenError';
	}
}

export class GlobalAdminAlreadyClaimedError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor() {
		super(
			'The deployment has already assigned the global administrator role to another principal.'
		);
		this.name = 'GlobalAdminAlreadyClaimedError';
	}
}

export class InstanceAlreadyInitialisedError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor() {
		super('The instance name has already been initialised');
		this.name = 'InstanceAlreadyInitialisedError';
	}
}

export class TenantAlreadyExistsError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly id: string) {
		super('A tenant with this id already exists');
		this.name = 'TenantAlreadyExistsError';
	}
}

export class TenantNotFoundError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly id: string) {
		super('The requested tenant does not exist.');
		this.name = 'TenantNotFoundError';
	}
}

// Provisioning configures the Durable Object before admitting the tenant slug.
// If an admitted tenant is not configured, the provisioning sequence did not
// finish. The failing tenant request cannot repair this state; an operator must
// rerun the idempotent creation request.
export class TenantNotConfiguredError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('Tenant is not configured');
		this.name = 'TenantNotConfiguredError';
	}
}

// A suspended or offboarding tenant stops accepting writes at once: the Worker
// reads the authoritative status from D1 before dispatching a write, so the
// stop takes effect without waiting for the read-path manifest entry to expire.
export class TenantWritesStoppedError extends ServerHttpError {
	readonly status = StatusCodes.FORBIDDEN;

	constructor(
		public readonly tenant: TenantId,
		// The status the write was gated on. Undefined when the registry row is
		// gone, which the gate treats as not active and refuses just the same.
		public readonly tenantStatus: TenantStatus | undefined
	) {
		super(
			`Writes for this tenant are stopped (${tenantStatus ?? 'unregistered'})`
		);
		this.name = 'TenantWritesStoppedError';
	}
}

// An offboarded tenant has a terminal tombstone. Its slug cannot be provisioned
// again or restored to another status. A status change for this tenant returns
// 410 Gone.
export class TenantRetiredError extends ServerHttpError {
	readonly status = StatusCodes.GONE;

	constructor(public readonly tenant: TenantId) {
		super(`Tenant '${tenant}' is offboarded and its slug is retired`);
		this.name = 'TenantRetiredError';
	}
}

// Resume changes only a suspended tenant to active. An active tenant returns a
// conflict. An offboarding or offboarded tenant returns
// `TenantRetiredError`.
export class TenantNotSuspendedError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly tenant: TenantId) {
		super(`Tenant '${tenant}' is not suspended`);
		this.name = 'TenantNotSuspendedError';
	}
}

// Committing this blob would take the tenant past its storage quota. The charge
// is gated on the tenant's 0-to-1 blob transition, so this is raised only when
// the tenant does not already hold the hash and the new bytes would exceed the
// limit.
export class QuotaExceededError extends ServerHttpError {
	readonly status = StatusCodes.INSUFFICIENT_STORAGE;

	constructor(public readonly tenant: TenantId) {
		super("This upload would exceed the tenant's storage quota");
		this.name = 'QuotaExceededError';
	}
}

export class ControlKeyMissingError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('No control signing key is available');
		this.name = 'ControlKeyMissingError';
	}
}

export class ControlWrappingKeyInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly byteLength: number) {
		super('Control key-wrapping secret is not a 32-byte base64 key');
		this.name = 'ControlWrappingKeyInvalidError';
	}
}

export class ControlWrappedKeyMalformedError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('The server cannot unwrap the stored control signing key.');
		this.name = 'ControlWrappedKeyMalformedError';
	}
}

export class LastAuthKeyError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly kid: AuthKeyId) {
		super('Cannot retire the last auth key');
		this.name = 'LastAuthKeyError';
	}
}

export class OwnerRuleImmutableError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly id: string) {
		super(
			'The owner rule is configured at deployment. Update the deployment configuration to change it.'
		);
		this.name = 'OwnerRuleImmutableError';
	}
}

export class OidcTrustRuleNotFoundError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly id: string) {
		super('No such OIDC trust rule');
		this.name = 'OidcTrustRuleNotFoundError';
	}
}

export class UnauthenticatedError extends ServerHttpError {
	readonly status = StatusCodes.UNAUTHORIZED;

	constructor() {
		super('Unauthorised');
		this.name = 'UnauthenticatedError';
	}
}

export class InvalidAccessTokenError extends UnauthenticatedError {
	constructor() {
		super();
		this.name = 'InvalidAccessTokenError';
	}
}

export class InsufficientScopeError extends ServerHttpError {
	readonly status = StatusCodes.FORBIDDEN;

	constructor() {
		super('Forbidden');
		this.name = 'InsufficientScopeError';
	}
}

export class RootNotPermittedError extends ServerHttpError {
	readonly status = StatusCodes.FORBIDDEN;

	constructor(public readonly rootName: RootName) {
		super('Token is not permitted to set this root');
		this.name = 'RootNotPermittedError';
	}
}

export class RootTargetsUnavailableError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(
		public readonly rootName: RootName,
		public readonly targets: readonly StorePathString[]
	) {
		super(
			`The cache does not serve ${String(targets.length)} ${targets.length === 1 ? 'target' : 'targets'}, so the root cannot be set.`
		);
		this.name = 'RootTargetsUnavailableError';
	}
}

// A binary cache serves the store directory advertised by `nix-cache-info`. The
// directory contributes to the store-path hash, so a path from another store has
// a different identity and cannot be substituted from this cache. Upload and
// root routes reject such paths before processing them.
export class StorePathNotServedError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(
		public readonly storePath: StorePathString,
		public readonly storeDirectory: string,
		public readonly servedStoreDirectory: StoreDirectory
	) {
		super(
			`Store path is in '${storeDirectory}', but this cache serves '${servedStoreDirectory}'`
		);
		this.name = 'StorePathNotServedError';
	}
}

export type OAuthErrorCode =
	| 'invalid_request'
	| 'invalid_grant'
	| 'invalid_authorization_details'
	| 'unsupported_grant_type';

/**
 * An OAuth 2.0 error (RFC 6749 §5.2). The JSON response uses the error code and
 * message as `error` and `error_description`, and is sent with `no-store`. A
 * concrete error can also include `problem`, which refines the RFC code, and a
 * structured `detail` describing that problem.
 */
export abstract class OAuthError extends ServerHttpError {
	abstract readonly error: OAuthErrorCode;
	readonly problem?: string;
	readonly detail?: Readonly<Record<string, string>>;
}

export abstract class InvalidRequestError extends OAuthError {
	readonly status = StatusCodes.BAD_REQUEST;
	readonly error = 'invalid_request';
}

export class SubjectTokenRequiredError extends InvalidRequestError {
	readonly problem = 'subject-token-required';

	constructor() {
		super('subject_token is required');
		this.name = 'SubjectTokenRequiredError';
	}
}

export class UnsupportedSubjectTokenTypeError extends InvalidRequestError {
	readonly problem = 'unsupported-subject-token-type';

	constructor(public readonly subjectTokenType: string) {
		super(`Unsupported subject_token_type: ${subjectTokenType}`);
		this.name = 'UnsupportedSubjectTokenTypeError';
	}
}

export class RefreshTokenRequiredError extends InvalidRequestError {
	readonly problem = 'refresh-token-required';

	constructor() {
		super('refresh_token is required');
		this.name = 'RefreshTokenRequiredError';
	}
}

export class TokenRequestBodyInvalidError extends InvalidRequestError {
	readonly problem = 'schema-mismatch';

	constructor(public override readonly cause: z.ZodError) {
		super(z.prettifyError(cause));
		this.name = 'TokenRequestBodyInvalidError';
	}
}

/**
 * A rule without wildcard authority must receive explicit
 * `authorization_details`. Wildcard-permitting interactive rules may omit the
 * field and receive their full permitted authority.
 */
export class AuthorizationDetailsRequiredError extends InvalidRequestError {
	readonly problem = 'authorization-details-required';

	constructor() {
		super('authorization_details is required for this trust rule');
		this.name = 'AuthorizationDetailsRequiredError';
	}
}

/**
 * `invalid_authorization_details` (RFC 9396 §5): a requested grant was empty,
 * malformed, or not permitted by the matching trust rule. The request is refused
 * in full, so a client never silently receives less than it asked for.
 */
export class InvalidAuthorizationDetailsError extends OAuthError {
	readonly status = StatusCodes.BAD_REQUEST;
	readonly error = 'invalid_authorization_details';
	readonly problem: string;

	constructor(problem: string) {
		super('The requested authorization_details are not permitted');
		this.problem = problem;
		this.name = 'InvalidAuthorizationDetailsError';
	}
}

export abstract class InvalidGrantError extends OAuthError {
	readonly status = StatusCodes.BAD_REQUEST;
	readonly error = 'invalid_grant';
}

/**
 * A presented refresh token was unknown, mismatched, expired, or tied to a
 * retired rule. Every refresh failure raises this single error with one
 * message, so a probe cannot tell which part was wrong.
 */
export class StaleRefreshTokenError extends InvalidGrantError {
	readonly problem = 'stale-refresh-token';

	constructor() {
		super('Refresh token is invalid or expired');
		this.name = 'StaleRefreshTokenError';
	}
}

export abstract class SubjectTokenInvalidError extends InvalidRequestError {
	readonly problem = subjectTokenProblems.invalid;
}

export class SubjectTokenNotJwtError extends SubjectTokenInvalidError {
	constructor() {
		super('Subject token is not a JWT');
		this.name = 'SubjectTokenNotJwtError';
	}
}

export class SubjectTokenVerificationFailedError extends SubjectTokenInvalidError {
	constructor() {
		super('Subject token failed verification');
		this.name = 'SubjectTokenVerificationFailedError';
	}
}

export class SubjectTokenSubjectMissingError extends SubjectTokenInvalidError {
	constructor() {
		super('Subject token has no subject');
		this.name = 'SubjectTokenSubjectMissingError';
	}
}

export abstract class SubjectTokenUntrustedError extends InvalidRequestError {
	override readonly problem: SubjectTokenProblem =
		subjectTokenProblems.untrusted;
}

export class TenantSubjectTokenUntrustedError extends SubjectTokenUntrustedError {
	constructor() {
		super('No trust rule matches the subject token');
		this.name = 'TenantSubjectTokenUntrustedError';
	}
}

/**
 * The token matched a rule's repository pins but failed another configured
 * claim. This error is used only after the token's signature has been verified
 * against that rule's issuer. The detailed diagnostic is therefore disclosed
 * only to a repository that the rule already pins; every other caller receives
 * {@link TenantSubjectTokenUntrustedError}.
 */
export class TenantSubjectTokenClaimMismatchError extends SubjectTokenUntrustedError {
	override readonly problem = subjectTokenProblems.claimMismatch;
	override readonly detail: Readonly<Record<string, string>>;

	constructor(ruleId: string, mismatch: ClaimMismatch) {
		super(
			`Trust rule ${ruleId} does not match the subject token's ${mismatch.claim} claim`
		);
		this.name = 'TenantSubjectTokenClaimMismatchError';
		this.detail = {
			rule: ruleId,
			claim: mismatch.claim,
			expected: mismatch.expected,
			...(mismatch.presented !== undefined && { presented: mismatch.presented })
		};
	}
}

export class ControlSubjectTokenUntrustedError extends SubjectTokenUntrustedError {
	constructor() {
		super('No control trust rule matches the subject token');
		this.name = 'ControlSubjectTokenUntrustedError';
	}
}

export class UnsupportedGrantTypeError extends OAuthError {
	readonly status = StatusCodes.BAD_REQUEST;
	readonly error = 'unsupported_grant_type';

	constructor(public readonly grantType: string) {
		super(`Unsupported grant type: ${grantType}`);
		this.name = 'UnsupportedGrantTypeError';
	}
}

// Failure to retrieve the issuer metadata or signing keys is transient. Return
// a retryable 503 rather than the permanent `invalid_grant` used for a bad
// token.
export class IssuerUnavailableError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;
	override readonly retryAfterSeconds = 5;

	constructor(
		public readonly issuer: OidcIssuer,
		options: { readonly cause: unknown }
	) {
		super(
			`Could not retrieve metadata or signing keys for issuer ${issuer}`,
			options
		);
		this.name = 'IssuerUnavailableError';
	}
}

export class StoredUploadMetadataInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(
		public readonly uploadId: UploadId,
		public override readonly cause: Error
	) {
		super('Stored upload metadata is invalid');
		this.name = 'StoredUploadMetadataInvalidError';
	}
}

export class StoredOidcTrustInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(
		public readonly id: string,
		public override readonly cause: Error
	) {
		super('Stored OIDC trust rule is invalid');
		this.name = 'StoredOidcTrustInvalidError';
	}
}

export class StoredReuseViewSelectorInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly view: string) {
		super('Stored reuse-view selector is invalid');
		this.name = 'StoredReuseViewSelectorInvalidError';
	}
}

export class StoredReferencesInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(
		public readonly storePathHash: StorePathHash,
		public override readonly cause: Error
	) {
		super('Stored narinfo references are invalid');
		this.name = 'StoredReferencesInvalidError';
	}
}

export class StoredReferencesJsonMalformedError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly storePathHash: StorePathHash) {
		super('Stored narinfo references are malformed JSON');
		this.name = 'StoredReferencesJsonMalformedError';
	}
}

export class StoredReferencesNotArrayError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly storePathHash: StorePathHash) {
		super('Stored narinfo references are not an array');
		this.name = 'StoredReferencesNotArrayError';
	}
}

export class StoredSignaturesInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(
		public readonly storePathHash: StorePathHash,
		public override readonly cause: Error
	) {
		super('Stored narinfo signatures are invalid');
		this.name = 'StoredSignaturesInvalidError';
	}
}

export class BinaryFuseFilterInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('Binary fuse filter is invalid');
		this.name = 'BinaryFuseFilterInvalidError';
	}
}

export class BinaryFuseConstructionFailedError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('Binary fuse construction failed for every seed');
		this.name = 'BinaryFuseConstructionFailedError';
	}
}

export class BinaryFuseConstructionIndexOutOfBoundsError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('Binary fuse construction index is out of bounds');
		this.name = 'BinaryFuseConstructionIndexOutOfBoundsError';
	}
}

export type R2PresignBindingName =
	| 'R2_ACCOUNT_ID'
	| 'R2_ACCESS_KEY_ID'
	| 'R2_BUCKET_NAME'
	| 'R2_SECRET_ACCESS_KEY';

export class R2PresignConfigurationMissingError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(
		public readonly missingBindings: readonly R2PresignBindingName[]
	) {
		super('R2 presign configuration is incomplete');
		this.name = 'R2PresignConfigurationMissingError';
	}
}

export class PushIdSigningKeyMissingError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('PUSH_ID_SIGNING_KEY is not configured');
		this.name = 'PushIdSigningKeyMissingError';
	}
}

export class InvalidPushIdError extends ServerHttpError {
	readonly status = StatusCodes.FORBIDDEN;

	constructor() {
		super('Push ID is not recognised');
		this.name = 'InvalidPushIdError';
	}
}

export class UploadNotFoundError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly uploadId: UploadId) {
		super('Upload not found');
		this.name = 'UploadNotFoundError';
	}
}

export class UploadExpiredError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly uploadId: UploadId) {
		super('Upload expired');
		this.name = 'UploadExpiredError';
	}
}

export class UploadCacheMismatchError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(
		public readonly uploadId: UploadId,
		public readonly negotiatedCache: CacheScope,
		public readonly requestedCache: CacheScope
	) {
		super(
			'The request tried to commit the upload to a different cache from the one used during negotiation.'
		);
		this.name = 'UploadCacheMismatchError';
	}
}

export class UploadedObjectNotFoundError extends ServerHttpError {
	// Use 404 when staging bytes disappear before commit or a reusable blob
	// disappears after negotiation. The push client already renegotiates an
	// upload when commit returns this status.
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly r2Key: R2ObjectKey) {
		super('Uploaded object not found');
		this.name = 'UploadedObjectNotFoundError';
	}
}

export class TenantAdmissionUnavailableError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;
	override readonly retryAfterSeconds = 5;

	constructor(public override readonly cause: unknown) {
		super('Tenant admission is temporarily unavailable');
		this.name = 'TenantAdmissionUnavailableError';
	}
}

export class DatabaseOverloadedError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;
	override readonly retryAfterSeconds = 5;

	constructor(public override readonly cause: unknown) {
		super('Database is temporarily overloaded');
		this.name = 'DatabaseOverloadedError';
	}
}

// An authoritative shared-fact read behind a serve kept failing. Reporting the
// path as a miss would tell the client that the path does not exist and send it
// off to build the path locally, so the serve refuses retryably instead.
export class SharedFactsUnavailableError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;
	override readonly retryAfterSeconds = 5;

	constructor(public override readonly cause: unknown) {
		super('Cache facts are temporarily unavailable');
		this.name = 'SharedFactsUnavailableError';
	}
}

// Cloudflare marks some runtime faults as retryable when an overload or Durable
// Object reset interrupts a request. The same classification can occur outside
// a tenant route, so the diagnostic refers to the service rather than a tenant.
export class TenantDispatchInterruptedError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;
	override readonly retryAfterSeconds = 5;

	constructor(public override readonly cause: unknown) {
		super('The service was temporarily unavailable');
		this.name = 'TenantDispatchInterruptedError';
	}
}

// A storage subrequest to R2, D1, or the Cache API exceeded its deadline. The
// caller stops waiting and returns a retryable refusal. Without this deadline, a
// stalled call can keep the Durable Object's input gate until the runtime resets
// the object at the approximately 30-second `blockConcurrencyWhile` limit. That
// reset fails every concurrent request. The abandoned call is idempotent, so a
// client can retry safely. `subrequest` identifies the timed-out operation for
// observability. `abandoned` resolves when the call finishes and is absent when
// the call never started.
export class SubrequestTimeoutError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;
	override readonly retryAfterSeconds = 5;

	constructor(
		public readonly subrequest: string,
		public readonly abandoned?: Promise<void>
	) {
		super('A storage subrequest timed out');
		this.name = 'SubrequestTimeoutError';
	}
}

export class AttestationUploadNotFoundError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly uploadId: UploadId) {
		super('Attestation upload not found');
		this.name = 'AttestationUploadNotFoundError';
	}
}

export class AttestationUploadExpiredError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly uploadId: UploadId) {
		super('Attestation upload expired');
		this.name = 'AttestationUploadExpiredError';
	}
}

export class AttestationUploadCacheMismatchError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(
		public readonly uploadId: UploadId,
		public readonly negotiatedCache: CacheScope,
		public readonly requestedCache: CacheScope
	) {
		super(
			'The request tried to attach the attestation to a different cache from the one used during negotiation.'
		);
		this.name = 'AttestationUploadCacheMismatchError';
	}
}

export class AttestationPathNotFoundError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly storePathHash: StorePathHash) {
		super('Committed store path not found');
		this.name = 'AttestationPathNotFoundError';
	}
}

export class AttestationBundleInvalidError extends ServerHttpError {
	readonly status = StatusCodes.UNPROCESSABLE_ENTITY;

	constructor(message = 'Attestation bundle is not a supported DSSE bundle') {
		super(message);
		this.name = 'AttestationBundleInvalidError';
	}
}

export class AttestationBundleTooLargeError extends ServerHttpError {
	readonly status = StatusCodes.REQUEST_TOO_LONG;

	constructor(
		public readonly size: number,
		public readonly maxSize: number
	) {
		super('Attestation bundle is too large');
		this.name = 'AttestationBundleTooLargeError';
	}
}

export class AttestationSubjectMismatchError extends ServerHttpError {
	readonly status = StatusCodes.UNPROCESSABLE_ENTITY;

	constructor(
		public readonly expectedNarHash: string,
		public readonly subjectDigest: string
	) {
		super('Attestation subject digest does not match the committed NAR');
		this.name = 'AttestationSubjectMismatchError';
	}
}

export class AttestationDigestMismatchError extends ServerHttpError {
	readonly status = StatusCodes.UNPROCESSABLE_ENTITY;

	constructor(
		public readonly expectedDigest: string,
		public readonly actualDigest: string
	) {
		super('Attestation bundle digest does not match the negotiated digest');
		this.name = 'AttestationDigestMismatchError';
	}
}

export class UploadedObjectSizeMismatchError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(
		public readonly r2Key: R2ObjectKey,
		public readonly expectedSize: number,
		public readonly actualSize: number
	) {
		super('Uploaded object size does not match metadata');
		this.name = 'UploadedObjectSizeMismatchError';
	}
}

export class UploadedObjectChecksumMissingError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(public readonly r2Key: R2ObjectKey) {
		super('Uploaded object SHA-256 checksum is missing');
		this.name = 'UploadedObjectChecksumMissingError';
	}
}

export class UploadedObjectChecksumMismatchError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(
		public readonly r2Key: R2ObjectKey,
		public readonly expectedFileHash: NixSha256HashString,
		public readonly actualFileHash: NixSha256HashString
	) {
		super('Uploaded object SHA-256 checksum does not match metadata');
		this.name = 'UploadedObjectChecksumMismatchError';
	}
}

export class NarVerificationFailedError extends ServerHttpError {
	readonly status = StatusCodes.UNPROCESSABLE_ENTITY;

	constructor(
		public readonly r2Key: R2ObjectKey,
		public readonly reason:
			'nar-hash-mismatch' | 'nar-size-mismatch' | 'undecodable'
	) {
		super('Uploaded NAR does not match its declared hash or size');
		this.name = 'NarVerificationFailedError';
	}
}

export class NarTooLargeError extends ServerHttpError {
	readonly status = StatusCodes.REQUEST_TOO_LONG;

	constructor(
		public readonly narSize: number,
		public readonly maxNarSize: number
	) {
		super('The declared NAR size exceeds the verification limit');
		this.name = 'NarTooLargeError';
	}
}

export class ZstdUnavailableError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(options: { readonly cause?: unknown } = {}) {
		super('Native zstd decompression is unavailable on this runtime', options);
		this.name = 'ZstdUnavailableError';
	}
}

export class UnboundableIoError extends Error {
	constructor(public readonly member: string) {
		super(
			`${member} cannot be bounded; use the raw binding outside a critical section`
		);
		this.name = 'UnboundableIoError';
	}
}

/**
 * Returns the first instance of `errorType` in `error` or its `cause` chain.
 *
 * Drizzle wraps whatever its driver callback throws in an error of its own, so
 * a refusal from the D1 binding reaches the caller as the cause of a query
 * error rather than on its own.
 */
export function causedBy<T>(
	error: unknown,
	errorType: abstract new (...parameters: never[]) => T
): T | undefined {
	let current: unknown = error;

	while (current instanceof Error) {
		if (current instanceof errorType) {
			return current;
		}

		current = current.cause;
	}

	return undefined;
}

/**
 * Work that requires the invocation's D1 allowance but runs outside an
 * allowance scope.
 *
 * Production page-sizing calls run beneath a wrapped dispatch method. This
 * error exposes a dispatch method that is missing the wrapper.
 */
export class MissingStatementAllowanceError extends Error {
	constructor() {
		super('This work requires an invocation D1 allowance and none is in force');
		this.name = 'MissingStatementAllowanceError';
	}
}

/**
 * A D1 call that exceeds the invocation's remaining statement allowance. The
 * binding throws before dispatching the statement or batch.
 */
export class StatementAllowanceExceededError extends Error {
	constructor(
		public readonly subject: string,
		public readonly statements: number,
		public readonly available: number
	) {
		super(
			`${subject} needs ${String(statements)} D1 statements and this invocation has ${String(available)} left`
		);
		this.name = 'StatementAllowanceExceededError';
	}
}

/**
 * A D1 call with a statement count that cannot be determined before dispatch.
 * The active allowance requires an exact count.
 */
export class UncountableStatementError extends Error {
	constructor(public readonly subject: string) {
		super(
			`${subject} runs an unknown number of statements and cannot be counted against an invocation's D1 allowance`
		);
		this.name = 'UncountableStatementError';
	}
}

/**
 * A D1 statement with more bound parameters than the platform accepts. The
 * local binding enforces the production limit during tests.
 */
export class StatementParameterLimitError extends Error {
	constructor(
		public readonly parameters: number,
		public readonly limit: number
	) {
		super(
			`A D1 statement bound ${String(parameters)} parameters and the limit is ${String(limit)}`
		);
		this.name = 'StatementParameterLimitError';
	}
}

/**
 * A batch for one item that exceeds the D1 statement limit for an invocation.
 * The item cannot be split into a narrower chunk, so a later invocation would
 * reach the same limit.
 */
export class BatchStatementLimitError extends Error {
	constructor(
		public readonly statements: number,
		public readonly limit: number
	) {
		super(
			`A D1 batch for one item needs ${String(statements)} statements and an invocation may run ${String(limit)}`
		);
		this.name = 'BatchStatementLimitError';
	}
}

/**
 * A batch builder that produced an empty batch for a non-empty chunk. Reporting
 * the chunk as processed would acknowledge work that was not executed.
 */
export class EmptyStatementBatchError extends Error {
	constructor(public readonly items: number) {
		super(
			`A D1 batch builder produced no statements for a chunk of ${String(items)} items`
		);
		this.name = 'EmptyStatementBatchError';
	}
}
