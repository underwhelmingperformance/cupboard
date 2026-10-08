import { Readable } from 'node:stream';

import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	HeadObjectCommand,
	NotFound,
	PutObjectCommand,
	S3Client,
	S3ServiceException,
	UploadPartCommand
} from '@aws-sdk/client-s3';
import { rootLogger } from '@cupboard/logger';
import { type PushCredential } from '@cupboard/protocol/upload';
import { StatusCodes } from 'http-status-codes';

import type { NarCompressionOptions } from '../nix/blob.ts';
import type { NarSource } from '../nix/nar-source.ts';

import {
	type Backoff,
	type CompressedNarUpload,
	type NarUploadObserver,
	type ObjectStore,
	type ObjectStoreBody,
	type ObjectStoreOperation,
	ObjectStoreRequestError,
	type RequestOptions,
	type StoredObject,
	unquotedEtag,
	uploadBytes,
	uploadCompressedNar
} from './nar-upload.ts';

export type CredentialProvider = () => Promise<PushCredential>;

/**
 * Uploads the objects of one push to its R2 bucket.
 */
export interface BlobUploader {
	/**
	 * Uploads a small object, such as an attestation bundle, with one
	 * `PutObject`, sending it again after a failure that another attempt can
	 * fix.
	 */
	uploadBytes(r2Key: string, body: ReadableStream<Uint8Array>): Promise<void>;
	/**
	 * Compresses a NAR and uploads it. See `uploadCompressedNar`.
	 */
	uploadNar(
		r2Key: string,
		source: NarSource,
		narSize: number,
		observer?: NarUploadObserver
	): Promise<CompressedNarUpload>;
}

export function awsCredentials(credential: PushCredential): {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken: string;
	readonly expiration: Date;
} {
	return {
		accessKeyId: credential.accessKeyId,
		secretAccessKey: credential.secretAccessKey,
		sessionToken: credential.sessionToken,
		expiration: new Date(credential.expiresAt)
	};
}

export interface R2BlobUploaderOptions {
	readonly endpoint: string;
	readonly bucket: string;
	readonly provider: CredentialProvider;
	/**
	 * Cancels uploads in progress. A cancelled multipart upload is aborted.
	 */
	readonly signal?: AbortSignal;
	readonly compression?: NarCompressionOptions;
	readonly backoff?: Backoff;
	readonly now?: () => number;
	/**
	 * Fails a request whose connection sends and receives nothing for this
	 * long. The default is five minutes.
	 */
	readonly socketTimeoutMs?: number;
}

// A connection that a NAT or proxy has dropped leaves a request waiting for
// ever. A connection that sends and receives nothing for five minutes fails,
// and the request is retried. Five minutes is far longer than R2's 15-second
// reset of a body that sends nothing, so it cannot cut off a slow body, and it
// gives a completion request minutes to answer. A completion whose response
// never arrives is checked with `HeadObject` after the retry.
const defaultSocketTimeoutMs = 5 * 60 * 1000;

const connectionTimeoutMs = 30_000;

/**
 * Builds a blob uploader bound to one push's R2 bucket. The S3 client signs with
 * the push credential and renews it through the provider as it expires, so a
 * push longer than a single credential's life recovers without re-driving the
 * upload from the caller.
 */
export function r2BlobUploader(options: R2BlobUploaderOptions): BlobUploader {
	const store = new R2ObjectStore(options);
	const signal = options.signal ?? new AbortController().signal;

	const requestOptions: RequestOptions = {
		signal,
		...(options.backoff !== undefined && { backoff: options.backoff }),
		...(options.now !== undefined && { now: options.now })
	};

	return {
		uploadBytes: async (r2Key, body) => {
			const bytes = new Uint8Array(await new Response(body).arrayBuffer());

			await uploadBytes(store, r2Key, bytes, requestOptions);
		},
		uploadNar: (r2Key, source, narSize, observer) =>
			uploadCompressedNar(store, r2Key, source, narSize, {
				...requestOptions,
				...(observer !== undefined && { observer }),
				...(options.compression !== undefined && {
					compression: options.compression
				})
			})
	};
}

const sdkLogger = rootLogger().getChild('s3');

function logSdkMessage(...content: unknown[]): void {
	sdkLogger.debug('{content}', { content });
}

/**
 * The S3 requests of an upload, sent to R2. The client never retries a
 * request itself: a streamed body cannot be sent twice, so the uploader
 * decides what to send again. It sends every body with its length and no
 * checksum, which makes the SDK sign the request with `UNSIGNED-PAYLOAD` and
 * stream the body as it is produced.
 */
class R2ObjectStore implements ObjectStore {
	private readonly client: S3Client;

	private readonly bucket: string;

	constructor(options: R2BlobUploaderOptions) {
		this.bucket = options.bucket;
		this.client = new S3Client({
			endpoint: options.endpoint,
			region: 'auto',
			forcePathStyle: true,
			credentials: async () => awsCredentials(await options.provider()),
			maxAttempts: 1,
			requestHandler: {
				connectionTimeout: connectionTimeoutMs,
				socketTimeout: options.socketTimeoutMs ?? defaultSocketTimeoutMs
			},
			requestChecksumCalculation: 'WHEN_REQUIRED',
			responseChecksumValidation: 'WHEN_REQUIRED',
			// The SDK warns on the console about every failed streamed request,
			// which the uploader retries and reports itself.
			logger: {
				debug: logSdkMessage,
				info: logSdkMessage,
				warn: logSdkMessage,
				error: logSdkMessage
			}
		});
	}

	private async send<T>(
		operation: ObjectStoreOperation,
		request: () => Promise<T>
	): Promise<T> {
		try {
			return await request();
		} catch (error) {
			throw requestError(operation, error);
		}
	}

	async putObject(key: string, body: ObjectStoreBody): Promise<void> {
		await this.send('PutObject', () =>
			this.client.send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: key,
					Body: requestBody(body),
					ContentLength: body.length
				}),
				{ abortSignal: body.signal }
			)
		);
	}

	async createMultipartUpload(
		key: string,
		signal: AbortSignal
	): Promise<string> {
		const output = await this.send('CreateMultipartUpload', () =>
			this.client.send(
				new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }),
				{ abortSignal: signal }
			)
		);

		return requireField('CreateMultipartUpload', output.UploadId);
	}

	async uploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		body: ObjectStoreBody
	): Promise<string> {
		const output = await this.send('UploadPart', () =>
			this.client.send(
				new UploadPartCommand({
					Bucket: this.bucket,
					Key: key,
					UploadId: uploadId,
					PartNumber: partNumber,
					Body: requestBody(body),
					ContentLength: body.length
				}),
				{ abortSignal: body.signal }
			)
		);

		return requireField('UploadPart', output.ETag);
	}

	async completeMultipartUpload(
		key: string,
		uploadId: string,
		parts: readonly { readonly partNumber: number; readonly etag: string }[],
		signal: AbortSignal
	): Promise<void> {
		await this.send('CompleteMultipartUpload', () =>
			this.client.send(
				new CompleteMultipartUploadCommand({
					Bucket: this.bucket,
					Key: key,
					UploadId: uploadId,
					MultipartUpload: {
						Parts: parts.map((part) => ({
							PartNumber: part.partNumber,
							ETag: part.etag
						}))
					}
				}),
				{ abortSignal: signal }
			)
		);
	}

	async headObject(
		key: string,
		signal: AbortSignal
	): Promise<StoredObject | undefined> {
		try {
			const output = await this.client.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
				{ abortSignal: signal }
			);

			return {
				length: output.ContentLength ?? 0,
				etag: unquotedEtag(output.ETag ?? '')
			};
		} catch (error) {
			if (error instanceof NotFound) {
				return undefined;
			}

			throw requestError('HeadObject', error);
		}
	}

	async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
		await this.send('AbortMultipartUpload', () =>
			this.client.send(
				new AbortMultipartUploadCommand({
					Bucket: this.bucket,
					Key: key,
					UploadId: uploadId
				})
			)
		);
	}
}

// S3 error codes that ask the client to send the same request again later.
const retryableCodes: ReadonlySet<string> = new Set([
	'InternalError',
	'RequestTimeout',
	'SlowDown',
	'Throttling',
	'ThrottlingException',
	'TooManyRequests'
]);

const retryableStatuses: ReadonlySet<number> = new Set<number>([
	StatusCodes.REQUEST_TIMEOUT,
	StatusCodes.TOO_MANY_REQUESTS
]);

const serverErrorStatus: number = StatusCodes.INTERNAL_SERVER_ERROR;

// Classifies a failed request. The store's own errors are retryable when they
// are server errors, time out or ask the client to slow down. An error without
// a status comes from the connection, which a new attempt can recover from,
// unless the request was aborted.
function requestError(
	operation: ObjectStoreOperation,
	error: unknown
): unknown {
	if (error instanceof S3ServiceException) {
		const status = error.$metadata.httpStatusCode ?? 0;

		return new ObjectStoreRequestError(
			operation,
			status >= serverErrorStatus ||
				retryableStatuses.has(status) ||
				retryableCodes.has(error.name),
			error.name,
			error.$metadata.httpStatusCode,
			{ cause: error }
		);
	}

	if (!(error instanceof Error) || error.name === 'AbortError') {
		return error;
	}

	return new ObjectStoreRequestError(
		operation,
		true,
		networkErrorCode(error) ?? error.name,
		undefined,
		{ cause: error }
	);
}

function networkErrorCode(error: Error): string | undefined {
	return 'code' in error && typeof error.code === 'string'
		? error.code
		: undefined;
}

function requireField(
	operation: ObjectStoreOperation,
	value: string | undefined
): string {
	if (value === undefined) {
		throw new ObjectStoreRequestError(
			operation,
			false,
			'MissingField',
			undefined
		);
	}

	return value;
}

// A body that fails also aborts its request through `body.signal`, which
// rejects the request with the body's error. The stream's own error event
// would otherwise be uncaught, because piping a stream into a request does not
// listen for the stream's errors.
function requestBody(body: ObjectStoreBody): Readable {
	const stream = Readable.from(body.body, { objectMode: false });
	stream.on('error', (error: unknown) => {
		sdkLogger.debug('A request body failed: {error}', { error });
	});

	return stream;
}
