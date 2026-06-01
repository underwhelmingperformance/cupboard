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
		super('CUPBOARD_OWNER_ISSUER is not a valid https issuer URL');
		this.name = 'OwnerConfigurationInvalidError';
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

export type OAuthErrorCode =
	| 'invalid_request'
	| 'invalid_grant'
	| 'unsupported_grant_type';

// An OAuth 2.0 error (RFC 6749 §5.2): the `error` code and the message become
// the `error`/`error_description` of a JSON envelope sent with `no-store`.
export abstract class OAuthError extends ServerHttpError {
	abstract readonly error: OAuthErrorCode;
}

export class InvalidRequestError extends OAuthError {
	readonly status = StatusCodes.BAD_REQUEST;
	readonly error = 'invalid_request';

	constructor(description: string) {
		super(description);
		this.name = 'InvalidRequestError';
	}
}

export class InvalidGrantError extends OAuthError {
	readonly status = StatusCodes.BAD_REQUEST;
	readonly error = 'invalid_grant';

	constructor(description: string) {
		super(description);
		this.name = 'InvalidGrantError';
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

export class UploadNotPreparedError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(public readonly uploadId: string) {
		super('Upload has not been prepared');
		this.name = 'UploadNotPreparedError';
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
