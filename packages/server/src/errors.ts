import {
	type AuthKeyId,
	type NixSha256HashString,
	type RootName,
	type StoredCache,
	type StoreDirectory,
	type StorePathHash,
	type StorePathString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type OidcIssuer } from '@cupboard/protocol/oidc';
import { type ClaimMismatch } from '@cupboard/protocol/oidc-trust-match';
import { type TenantStatus } from '@cupboard/protocol/tenants';
import { type UploadId } from '@cupboard/protocol/upload';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { type R2ObjectKey } from './http/http.ts';

export abstract class ServerHttpError extends Error {
	abstract readonly status: number;

	// When set, the response carries a Retry-After header: the refusal is
	// transient and a client that waits this long may succeed.
	readonly retryAfterSeconds?: number;
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

export class OwnerConfigurationInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(public readonly issuer: OidcIssuer) {
		super('The configured owner issuer is not a valid https issuer URL');
		this.name = 'OwnerConfigurationInvalidError';
	}
}

export class CommitUpgradeRequiredError extends ServerHttpError {
	readonly status = StatusCodes.UPGRADE_REQUIRED;

	constructor() {
		super('The commit endpoint is a WebSocket; upgrade the request');
		this.name = 'CommitUpgradeRequiredError';
	}
}

// One tenant's Durable Object holds a bounded set of live commit sockets. A
// socket is an optimisation over durable status polling, so an upgrade past
// the bound is refused retryably: the turned-away client polls the upload
// status, or retries once a session closes.
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

	constructor(public readonly cache: StoredCache) {
		super('Cache is not empty; pass force to tear it down');
		this.name = 'CacheNotEmptyError';
	}
}

export class LastSigningKeyError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly id: string) {
		super('Cannot retire the last signing key');
		this.name = 'LastSigningKeyError';
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

/** A control trust rule was submitted without a pinned subject. */
export class ControlTrustSubjectRequiredError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor() {
		super('A control trust rule must pin a subject claim');
		this.name = 'ControlTrustSubjectRequiredError';
	}
}

// A missing deployment configuration is a server-side fault an operator must
// fix; a client cannot clear it by retrying, so it joins the other
// missing-configuration faults as a 500.
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
		super('Global admin has already been claimed by another principal');
		this.name = 'GlobalAdminAlreadyClaimedError';
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
		super('No such tenant');
		this.name = 'TenantNotFoundError';
	}
}

// Creation configures a tenant's Durable Object before it admits the slug, so
// an admitted tenant whose object was never configured breaks a provisioning
// invariant. An operator resolves it by re-running the idempotent create. It
// is not a client condition, and a retry does not clear it.
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

// An offboarded tenant is a terminal tombstone: its slug is retired and can never be
// re-provisioned or moved back to another status. A status mutation targeting it
// is refused as Gone.
export class TenantRetiredError extends ServerHttpError {
	readonly status = StatusCodes.GONE;

	constructor(public readonly tenant: TenantId) {
		super(`Tenant '${tenant}' is offboarded and its slug is retired`);
		this.name = 'TenantRetiredError';
	}
}

// Resume only moves a suspended tenant back to active. A tenant that is already
// active cannot be resumed (an offboarding or offboarded one is a
// `TenantRetiredError`). The mutation is refused as a conflict.
export class TenantNotSuspendedError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly tenant: TenantId) {
		super(`Tenant '${tenant}' is not suspended`);
		this.name = 'TenantNotSuspendedError';
	}
}

// Committing this blob would take the tenant past its storage quota. The charge is
// gated on the tenant's 0-to-1 blob transition, so this is raised only when the
// tenant does not already hold the hash and the new bytes would exceed the limit.
export class QuotaExceededError extends ServerHttpError {
	readonly status = StatusCodes.INSUFFICIENT_STORAGE;

	constructor(public readonly tenant: TenantId) {
		super('This tenant is over its storage quota');
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
		super('Stored control signing key could not be unwrapped');
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
		super('Cannot change the owner rule; update deploy config instead');
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
			`Cannot set root: ${String(targets.length)} target(s) have no uploaded path`
		);
		this.name = 'RootTargetsUnavailableError';
	}
}

// A binary cache serves one store directory: the directory its
// `nix-cache-info` advertises. A path from another store has a different
// identity, because the store directory is an input to the path hash, and no
// client of this cache could substitute it. Such a path is refused where the
// request arrives.
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
 * An OAuth 2.0 error (RFC 6749 §5.2). The `error` code and the message become
 * the `error` and `error_description` of a JSON envelope sent with `no-store`.
 * A concrete cause may also surface a `problem` that refines the RFC code for
 * clients that understand it, and a structured `detail` carrying the facts of
 * that problem.
 */
export abstract class OAuthError extends ServerHttpError {
	abstract readonly error: OAuthErrorCode;
	readonly problem?: string;
	readonly detail?: Readonly<Record<string, string>>;
}

/** `invalid_request`: the request is malformed or missing a parameter. */
export abstract class InvalidRequestError extends OAuthError {
	readonly status = StatusCodes.BAD_REQUEST;
	readonly error = 'invalid_request';
}

/** A token-exchange request omitted the required `subject_token`. */
export class SubjectTokenRequiredError extends InvalidRequestError {
	readonly problem = 'subject-token-required';

	constructor() {
		super('subject_token is required');
		this.name = 'SubjectTokenRequiredError';
	}
}

/** A token request carried a `subject_token_type` the server does not accept. */
export class UnsupportedSubjectTokenTypeError extends InvalidRequestError {
	readonly problem = 'unsupported-subject-token-type';

	constructor(public readonly subjectTokenType: string) {
		super(`Unsupported subject_token_type: ${subjectTokenType}`);
		this.name = 'UnsupportedSubjectTokenTypeError';
	}
}

/** A refresh-token grant omitted the required `refresh_token`. */
export class RefreshTokenRequiredError extends InvalidRequestError {
	readonly problem = 'refresh-token-required';

	constructor() {
		super('refresh_token is required');
		this.name = 'RefreshTokenRequiredError';
	}
}

/** A token request body failed schema validation. */
export class TokenRequestBodyInvalidError extends InvalidRequestError {
	readonly problem = 'schema-mismatch';

	constructor(public override readonly cause: z.ZodError) {
		super(z.prettifyError(cause));
		this.name = 'TokenRequestBodyInvalidError';
	}
}

/**
 * A claim-bound (CI) exchange omitted `authorization_details`. Only the
 * interactive owner class may exchange without naming the grants it wants; a
 * CI rule must declare them explicitly.
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
		super('the requested authorization_details are not permitted');
		this.problem = problem;
		this.name = 'InvalidAuthorizationDetailsError';
	}
}

/** `invalid_grant`: the supplied grant or token is invalid, expired, or untrusted. */
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

/** A subject token was structurally or cryptographically unusable. */
export abstract class SubjectTokenInvalidError extends InvalidGrantError {
	readonly problem = 'subject-token-invalid';
}

/** The subject token was not a well-formed JWT. */
export class SubjectTokenNotJwtError extends SubjectTokenInvalidError {
	constructor() {
		super('Subject token is not a JWT');
		this.name = 'SubjectTokenNotJwtError';
	}
}

/** The subject token's signature or claims failed verification. */
export class SubjectTokenVerificationFailedError extends SubjectTokenInvalidError {
	constructor() {
		super('Subject token failed verification');
		this.name = 'SubjectTokenVerificationFailedError';
	}
}

/** The subject token carried no subject claim. */
export class SubjectTokenSubjectMissingError extends SubjectTokenInvalidError {
	constructor() {
		super('Subject token has no subject');
		this.name = 'SubjectTokenSubjectMissingError';
	}
}

/** No enabled trust rule matched the subject token. */
export abstract class SubjectTokenUntrustedError extends InvalidGrantError {
	override readonly problem: string = 'subject-token-untrusted';
}

/** No tenant trust rule matched the subject token. */
export class TenantSubjectTokenUntrustedError extends SubjectTokenUntrustedError {
	constructor() {
		super('No trust rule matches the subject token');
		this.name = 'TenantSubjectTokenUntrustedError';
	}
}

/**
 * A trust rule pinned to the caller's repository ids refused the token over
 * one configured claim. Raised only after the token's signature verified
 * against that rule's issuer, so the diagnostic discloses the rule's shape only
 * to a repository the rule already pins; every other caller receives the flat
 * {@link TenantSubjectTokenUntrustedError}.
 */
export class TenantSubjectTokenClaimMismatchError extends SubjectTokenUntrustedError {
	override readonly problem = 'subject-token-claim-mismatch';
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

/** No control trust rule matched the subject token. */
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

// Discovery (or the JWKS behind it) for the subject token's issuer could not be
// reached. This is an upstream/transient condition, not a bad token: a 503 the
// caller can retry, not an `invalid_grant` the caller treats as permanent.
export class IssuerUnavailableError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;
	override readonly retryAfterSeconds = 5;

	constructor(
		public readonly issuer: OidcIssuer,
		options: { readonly cause: unknown }
	) {
		super(
			`Could not reach issuer ${issuer} to verify the subject token`,
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
		super('Push id is not recognised');
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
		public readonly negotiatedCache: StoredCache,
		public readonly requestedCache: StoredCache
	) {
		super('Upload committed under a different cache than it negotiated');
		this.name = 'UploadCacheMismatchError';
	}
}

export class UploadedObjectNotFoundError extends ServerHttpError {
	// NOT_FOUND, matching a reaped upload slot. Every flow that raises this
	// error (a staging object gone before commit, a reused blob gone between
	// negotiate and commit) has the same remedy: the re-negotiation the push
	// already performs when a commit returns 404.
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

// D1 sheds load under sustained pressure by throwing an overload error with no
// structured code. The fault is transient, so callers that wait briefly may
// succeed; the refusal is a 503 carrying Retry-After for them to honour.
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

// The runtime aborted the request with a fault it marks as retryable: the
// Durable Object serving the request was reset or overloaded, so the request
// died with the object, independent of anything about the request itself.
export class TenantDispatchInterruptedError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;
	override readonly retryAfterSeconds = 5;

	constructor(public override readonly cause: unknown) {
		super('Tenant is temporarily unavailable');
		this.name = 'TenantDispatchInterruptedError';
	}
}

// A storage subrequest (R2, D1 or the Cache API) did not settle within its
// deadline. The caller abandons the call and refuses retryably. Otherwise a
// stalled call holds the Durable Object's input gate until the runtime resets
// the object at the ~30s `blockConcurrencyWhile` limit, and that reset fails
// every concurrent request. The abandoned call is idempotent, so the client's
// retry resumes safely. The `subrequest` label names the operation that timed
// out, for observability. `abandoned` resolves once the abandoned call finally
// settles, and is absent when the call was never started.
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
		public readonly negotiatedCache: StoredCache,
		public readonly requestedCache: StoredCache
	) {
		super(
			'Attestation upload attached under a different cache than it negotiated'
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

// The uploaded blob's compressed bytes match their checksum, but decompressing
// them does not reproduce the NAR hash or size the narinfo would commit to and
// sign. The bytes are rejected so the server never signs an unverified mapping.
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

// The declared uncompressed NAR is larger than the server will decompress to
// verify within its CPU budget, so it could never be served safely. Rejected at
// commit.
export class NarTooLargeError extends ServerHttpError {
	readonly status = StatusCodes.REQUEST_TOO_LONG;

	constructor(
		public readonly narSize: number,
		public readonly maxNarSize: number
	) {
		super('NAR is too large to verify and cannot be served');
		this.name = 'NarTooLargeError';
	}
}

// The runtime does not provide native zstd decompression, so the server cannot
// verify NAR contents. Raised loudly at Durable Object initialisation rather
// than as an opaque stream error at the first verified commit.
export class ZstdUnavailableError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(options: { readonly cause?: unknown } = {}) {
		super('Native zstd decompression is unavailable on this runtime', options);
		this.name = 'ZstdUnavailableError';
	}
}

/**
 * A bounded I/O wrapper refused a member it cannot bound: sessions and
 * multipart handles issue their own network calls outside the wrapper, so
 * handing one out would let those calls escape the per-call limit with no
 * error reported. Take the handle from the raw binding instead, outside any
 * critical section.
 */
export class UnboundableIoError extends Error {
	constructor(public readonly member: string) {
		super(`${member} cannot be bounded; use the raw binding off the gate`);
		this.name = 'UnboundableIoError';
	}
}
