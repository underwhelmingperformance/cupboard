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
 * Byte storage keyed by a single, fully-resolved storage key. The S3 layer's
 * `NixCacheObjectStore` decorator translates the S3 key space onto this and
 * delegates reads to it, so the same R2-backed implementation serves both the
 * staging/canonical write paths and the read path.
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
		meta: PutObjectMeta
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

		async put(key, body, meta) {
			const object = await bucket.put(key, body, {
				httpMetadata: httpMetadataFor(meta)
			});
			return { etag: object.etag };
		},

		async delete(key) {
			await bucket.delete(key);
		},

		async createMultipartUpload(key, meta) {
			const upload = await bucket.createMultipartUpload(key, {
				httpMetadata: httpMetadataFor(meta)
			});
			return { uploadId: upload.uploadId };
		},

		async uploadPart(key, uploadId, partNumber, body) {
			const upload = bucket.resumeMultipartUpload(key, uploadId);
			const part = await upload.uploadPart(partNumber, body);
			return { partNumber: part.partNumber, etag: part.etag };
		},

		async completeMultipartUpload(key, uploadId, parts) {
			const upload = bucket.resumeMultipartUpload(key, uploadId);
			const object = await upload.complete(
				parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag }))
			);
			return { etag: object.etag };
		},

		async abortMultipartUpload(key, uploadId) {
			const upload = bucket.resumeMultipartUpload(key, uploadId);
			await upload.abort();
		}
	};
}

/**
 * Bridges R2's loosely-typed (`ReadableStream<any>`) body to a typed byte
 * stream through an identity transform. Streaming, no buffering, no cast.
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
