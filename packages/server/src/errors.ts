import { ProtocolError } from '@cupboard/shared';
import { StatusCodes } from 'http-status-codes';

export abstract class ServerHttpError extends Error {
	abstract readonly status: number;
}

export class InvalidJsonRequestBodyError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(public override readonly cause: SyntaxError) {
		super('Invalid JSON request body');
		this.name = 'InvalidJsonRequestBodyError';
	}
}

export class InvalidUploadMetadataRequestError extends ServerHttpError {
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(public override readonly cause: ProtocolError) {
		super(`Invalid upload metadata: ${cause.message}`);
		this.name = 'InvalidUploadMetadataRequestError';
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
