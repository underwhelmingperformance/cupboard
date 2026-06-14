import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

export abstract class ServerHttpError extends Error {
	abstract readonly status: number;
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

	constructor(public readonly issuer: string) {
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

export class CacheNotEmptyError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly cache: string) {
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

export class ControlNotConfiguredError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;

	constructor() {
		super('The control plane is not configured');
		this.name = 'ControlNotConfiguredError';
	}
}

export class LastControlKeyError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly kid: string) {
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

export class TenantNotConfiguredError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;

	constructor() {
		super('Tenant is not configured');
		this.name = 'TenantNotConfiguredError';
	}
}

// A suspended or offboarding tenant stops accepting writes at once: the Worker
// reads the authoritative status from D1 before dispatching a write, so the stop is
// effective before the read-path manifest TTL catches up.
export class TenantWritesStoppedError extends ServerHttpError {
	readonly status = StatusCodes.FORBIDDEN;

	constructor(
		public readonly tenant: string,
		public readonly tenantStatus: string
	) {
		super(`Writes for this tenant are stopped (${tenantStatus})`);
		this.name = 'TenantWritesStoppedError';
	}
}

// An offboarded tenant is a terminal tombstone: its slug is retired and can never be
// re-provisioned or moved back to another status, so a status mutation targeting it
// is refused as Gone rather than silently resurrecting the slug.
export class TenantRetiredError extends ServerHttpError {
	readonly status = StatusCodes.GONE;

	constructor(public readonly tenant: string) {
		super(`Tenant '${tenant}' is offboarded and its slug is retired`);
		this.name = 'TenantRetiredError';
	}
}

// Resume only moves a suspended tenant back to active. A tenant that is already
// active cannot be resumed (an offboarding or offboarded one is a
// `TenantRetiredError`), so the mutation is refused as a conflict rather than
// silently no-oping.
export class TenantNotSuspendedError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly tenant: string) {
		super(`Tenant '${tenant}' is not suspended`);
		this.name = 'TenantNotSuspendedError';
	}
}

// Committing this blob would take the tenant past its storage quota. The charge is
// gated on the tenant's 0-to-1 blob transition, so this is raised only when the
// tenant does not already hold the hash and the new bytes would exceed the limit.
export class QuotaExceededError extends ServerHttpError {
	readonly status = StatusCodes.INSUFFICIENT_STORAGE;

	constructor(public readonly tenant: string) {
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

	constructor(public readonly kid: string) {
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

	constructor(public readonly rootName: string) {
		super('Token is not permitted to set this root');
		this.name = 'RootNotPermittedError';
	}
}

export class RootTargetsUnavailableError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(
		public readonly rootName: string,
		public readonly targets: readonly string[]
	) {
		super(
			`Cannot activate root: ${String(targets.length)} target(s) are not yet servable`
		);
		this.name = 'RootTargetsUnavailableError';
	}
}

export type OAuthErrorCode =
	| 'invalid_request'
	| 'invalid_grant'
	| 'unsupported_grant_type';

/**
 * An OAuth 2.0 error (RFC 6749 §5.2). The `error` code and the message become
 * the `error` and `error_description` of a JSON envelope sent with `no-store`.
 * A concrete cause may also surface a `problem` that refines the RFC code for
 * clients that understand it.
 */
export abstract class OAuthError extends ServerHttpError {
	abstract readonly error: OAuthErrorCode;
	readonly problem?: string;
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
	readonly problem = 'subject-token-untrusted';
}

/** No tenant trust rule matched the subject token. */
export class TenantSubjectTokenUntrustedError extends SubjectTokenUntrustedError {
	constructor() {
		super('No trust rule matches the subject token');
		this.name = 'TenantSubjectTokenUntrustedError';
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
// reached. This is an upstream/transient condition, not a bad token, so it is a
// 503 the caller can retry — never an `invalid_grant` the caller treats as
// permanent.
export class IssuerUnavailableError extends ServerHttpError {
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;

	constructor(
		public readonly issuer: string,
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
		public readonly uploadId: string,
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
		public readonly storePathHash: string,
		public override readonly cause: Error
	) {
		super('Stored narinfo references are invalid');
		this.name = 'StoredReferencesInvalidError';
	}
}

export class StoredSignaturesInvalidError extends ServerHttpError {
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(
		public readonly storePathHash: string,
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

export class UploadNotPreparedError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(public readonly uploadId: string) {
		super('Upload has not been prepared');
		this.name = 'UploadNotPreparedError';
	}
}

export class ReusableUploadNotPreparableError extends ServerHttpError {
	readonly status = StatusCodes.CONFLICT;

	constructor(public readonly uploadId: string) {
		super('Upload reuses an existing blob and must be committed, not prepared');
		this.name = 'ReusableUploadNotPreparableError';
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

export class UploadNotFoundError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly uploadId: string) {
		super('Upload not found');
		this.name = 'UploadNotFoundError';
	}
}

export class UploadExpiredError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly uploadId: string) {
		super('Upload expired');
		this.name = 'UploadExpiredError';
	}
}

export class UploadCacheMismatchError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(
		public readonly uploadId: string,
		public readonly negotiatedCache: string,
		public readonly requestedCache: string
	) {
		super('Upload prepared or committed under a different cache');
		this.name = 'UploadCacheMismatchError';
	}
}

export class UploadedObjectNotFoundError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(public readonly r2Key: string) {
		super('Uploaded object not found');
		this.name = 'UploadedObjectNotFoundError';
	}
}

export class AttestationUploadNotFoundError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly uploadId: string) {
		super('Attestation upload not found');
		this.name = 'AttestationUploadNotFoundError';
	}
}

export class AttestationUploadExpiredError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly uploadId: string) {
		super('Attestation upload expired');
		this.name = 'AttestationUploadExpiredError';
	}
}

export class AttestationUploadCacheMismatchError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(
		public readonly uploadId: string,
		public readonly negotiatedCache: string,
		public readonly requestedCache: string
	) {
		super('Attestation upload prepared or attached under a different cache');
		this.name = 'AttestationUploadCacheMismatchError';
	}
}

export class AttestationPathNotFoundError extends ServerHttpError {
	readonly status = StatusCodes.NOT_FOUND;

	constructor(public readonly storePathHash: string) {
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
		public readonly r2Key: string,
		public readonly expectedSize: number,
		public readonly actualSize: number
	) {
		super('Uploaded object size does not match metadata');
		this.name = 'UploadedObjectSizeMismatchError';
	}
}

export class UploadedObjectChecksumMissingError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(public readonly r2Key: string) {
		super('Uploaded object SHA-256 checksum is missing');
		this.name = 'UploadedObjectChecksumMissingError';
	}
}

export class UploadedObjectChecksumMismatchError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(
		public readonly r2Key: string,
		public readonly expectedFileHash: string,
		public readonly actualFileHash: string
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
		public readonly r2Key: string,
		public readonly reason:
			| 'nar-hash-mismatch'
			| 'nar-size-mismatch'
			| 'undecodable'
	) {
		super('Uploaded NAR does not match its declared hash or size');
		this.name = 'NarVerificationFailedError';
	}
}

// The declared uncompressed NAR is larger than the server will decompress to
// verify within its CPU budget, so it could never be served safely. Rejected at
// commit rather than stored as an unservable path.
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
