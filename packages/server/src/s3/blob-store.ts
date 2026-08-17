import { bytesToHex } from '@cupboard/nix-store/encoding';
import {
	InternalError,
	InvalidPartError,
	NoSuchUploadError
} from '@cupboard/s3/errors';
import type {
	ByteRange,
	CompletedUpload,
	GetObjectResult,
	MultipartUpload,
	ObjectStat,
	PutObjectMeta,
	PutObjectResult,
	UploadedPart
} from '@cupboard/s3/ports';

/**
The uploaded object did not match its expected SHA-256.
*/
export class BlobSha256MismatchError extends Error {
	constructor(options?: ErrorOptions) {
		super(undefined, options);
	}
}

/**
 * Byte storage addressed by fully resolved internal keys.
 * `NixCacheObjectStore` maps S3 keys to these keys, then delegates byte reads
 * and staging writes to the R2-backed implementation.
 */
export interface BlobStore {
	head(key: string): Promise<ObjectStat | undefined>;
	get(
		key: string,
		range: ByteRange | undefined
	): Promise<GetObjectResult | undefined>;
	put(
		key: string,
		body: ReadableStream<Uint8Array>,
		meta: PutObjectMeta,
		// The object's SHA-256 as a hex string, recorded on the R2 object (and
		// verified against the body). The commit pipeline reads it back as the
		// staged blob's file hash.
		sha256?: string
	): Promise<PutObjectResult>;
	delete(key: string): Promise<void>;

	createMultipartUpload(
		key: string,
		meta: PutObjectMeta
	): Promise<MultipartUpload>;
	uploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		contentLength: number,
		body: ReadableStream<Uint8Array>
	): Promise<UploadedPart>;
	completeMultipartUpload(
		key: string,
		uploadId: string,
		parts: readonly UploadedPart[]
	): Promise<CompletedUpload>;
	abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

/**
 * A {@link BlobStore} backed by an R2 bucket binding. Metadata (ETag,
 * `Last-Modified`) is whatever R2 reports, so the S3 layer relays it unchanged.
 */
export function createR2BlobStore(bucket: R2Bucket): BlobStore {
	return {
		async head(key) {
			const object = await bucket.head(key);
			return object === null ? undefined : statOf(object);
		},

		async get(key, range) {
			const object = await bucket.get(key, {
				range: range === undefined ? undefined : toR2Range(range)
			});
			if (object === null) {
				return;
			}

			return {
				stat: statOf(object),
				body: asByteStream(object.body),
				range:
					range === undefined ? undefined : resolveRange(range, object.size)
			};
		},

		async put(key, body, meta, sha256) {
			if (sha256 === undefined || meta.contentLength === undefined) {
				const object = await bucket.put(key, body, {
					httpMetadata: httpMetadataFor(meta),
					sha256
				});

				return { etag: object.etag };
			}

			const digestingBody = sha256DigestingBody(body, meta.contentLength);

			try {
				const object = await bucket.put(key, digestingBody.stream, {
					httpMetadata: httpMetadataFor(meta),
					sha256
				});
				await digestingBody.complete;

				return { etag: object.etag };
			} catch (error) {
				const digest = await digestingBody.digestAfterFailure(error);

				if (digest !== undefined && bytesToHex(digest) !== sha256) {
					throw new BlobSha256MismatchError({ cause: error });
				}

				throw error;
			}
		},

		async delete(key) {
			await bucket.delete(key);
		},

		async createMultipartUpload(key, meta) {
			try {
				const upload = await bucket.createMultipartUpload(key, {
					httpMetadata: httpMetadataFor(meta)
				});
				return { uploadId: upload.uploadId };
			} catch (error) {
				throwMultipartError(error);
			}
		},

		async uploadPart(key, uploadId, partNumber, contentLength, body) {
			try {
				const upload = bucket.resumeMultipartUpload(key, uploadId);
				const fixedLength = new FixedLengthStream(contentLength);
				const [part] = await Promise.all([
					upload.uploadPart(partNumber, fixedLength.readable),
					body.pipeTo(fixedLength.writable)
				]);
				return { partNumber: part.partNumber, etag: part.etag };
			} catch (error) {
				throwMultipartError(error);
			}
		},

		async completeMultipartUpload(key, uploadId, parts) {
			try {
				const upload = bucket.resumeMultipartUpload(key, uploadId);
				const object = await upload.complete(
					parts.map((part) => ({
						partNumber: part.partNumber,
						etag: part.etag
					}))
				);
				return { etag: object.etag };
			} catch (error) {
				throwMultipartError(error);
			}
		},

		async abortMultipartUpload(key, uploadId) {
			try {
				const upload = bucket.resumeMultipartUpload(key, uploadId);
				await upload.abort();
			} catch (error) {
				throwMultipartError(error);
			}
		}
	};
}

function throwMultipartError(error: unknown): never {
	const code =
		typeof error === 'object' && error !== null && 'code' in error
			? error.code
			: undefined;

	if (code === 10_024) {
		throw new NoSuchUploadError({ cause: error });
	}

	if (code === 10_025 || code === 10_048) {
		throw new InvalidPartError({ cause: error });
	}

	throw new InternalError({ cause: error });
}

interface Sha256DigestingBody {
	readonly stream: ReadableStream<Uint8Array>;
	readonly complete: Promise<void>;
	digestAfterFailure(reason: unknown): Promise<Uint8Array | undefined>;
}

function sha256DigestingBody(
	body: ReadableStream<Uint8Array>,
	contentLength: number
): Sha256DigestingBody {
	const digestStream = new crypto.DigestStream('SHA-256');
	const digestComplete = completedDigest(digestStream);
	const writer = digestStream.getWriter();
	const fixedLength = new FixedLengthStream(contentLength);
	const complete = ignoreRejection(
		body
			.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					async transform(chunk, controller) {
						await writer.write(chunk);
						controller.enqueue(chunk);
					},
					async flush() {
						await writer.close();
					}
				})
			)
			.pipeTo(fixedLength.writable)
	);

	return {
		stream: fixedLength.readable,
		complete,
		async digestAfterFailure(reason) {
			await Promise.allSettled([writer.abort(reason), complete]);

			return digestComplete;
		}
	};
}

async function completedDigest(
	digestStream: DigestStream
): Promise<Uint8Array | undefined> {
	const [result] = await Promise.allSettled([digestStream.digest]);
	if (result.status === 'rejected') {
		return;
	}

	return new Uint8Array(result.value);
}

async function ignoreRejection(promise: Promise<unknown>): Promise<void> {
	await Promise.allSettled([promise]);
}

/**
 * Converts R2's loosely typed body to `ReadableStream<Uint8Array>` with an
 * identity transform, without buffering or a cast.
 */
function asByteStream(stream: ReadableStream): ReadableStream<Uint8Array> {
	return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>());
}

function statOf(object: R2Object): ObjectStat {
	return {
		size: object.size,
		etag: object.etag,
		contentType: object.httpMetadata?.contentType,
		lastModified: object.uploaded
	};
}

function resolveRange(
	range: ByteRange,
	size: number
): { readonly start: number; readonly end: number } {
	if ('suffix' in range) {
		const length = Math.min(range.suffix, size);
		return { start: size - length, end: size - 1 };
	}

	const end =
		range.length === undefined
			? size - 1
			: Math.min(range.offset + range.length - 1, size - 1);
	return { start: range.offset, end };
}

function toR2Range(range: ByteRange): R2Range {
	if ('suffix' in range) {
		return { suffix: range.suffix };
	}

	return range.length === undefined
		? { offset: range.offset }
		: { offset: range.offset, length: range.length };
}

function httpMetadataFor(meta: PutObjectMeta): R2HTTPMetadata | undefined {
	return meta.contentType === undefined
		? undefined
		: { contentType: meta.contentType };
}
