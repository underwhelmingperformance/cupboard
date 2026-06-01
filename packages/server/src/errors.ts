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

export class CronGarbageCollectionFailedError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string
	) {
		super(`Cron garbage collection failed with HTTP ${String(status)}`);
		this.name = 'CronGarbageCollectionFailedError';
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
