import type {
	NixSha256HashString,
	StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	NonCacheWriteError,
	NoSuchBucketError,
	NoSuchKeyError
} from '@cupboard/s3/errors';
import type {
	ByteRange,
	CompletedUpload,
	GetObjectResult,
	ListObjectsQuery,
	ListObjectsResult,
	MultipartUpload,
	ObjectStat,
	ObjectStore,
	PutObjectMeta,
	PutObjectResult,
	S3Principal,
	UploadedPart
} from '@cupboard/s3/ports';

import type { BlobStore } from './blob-store.ts';
import {
	cacheScopedKey,
	type CacheTarget,
	internalKeyFor,
	type NixCacheObject,
	resolveCacheTarget,
	resolveListPrefix
} from './nix-cache-keys.ts';

/**
 * Rendered `nix-cache-info` for a cache, or `undefined` if the cache does not
 * exist. ETag and `Last-Modified` come from the cache record so reads are stable.
 */
export interface RenderedCacheInfo {
	readonly body: Uint8Array;
	readonly etag: string;
	readonly lastModified: Date;
}

/**
 * The Nix-specific collaborator the decorator delegates to for everything that
 * is not a plain byte read: authorisation, cache existence and `nix-cache-info`,
 * listing, the write/ingestion pipeline, and removal.
 */
export interface NixCacheBackend {
	authorizeRead(
		cache: string,
		principal: S3Principal | undefined
	): Promise<void>;
	authorizeWrite(
		cache: string,
		principal: S3Principal | undefined
	): Promise<void>;

	cacheExists(cache: string): Promise<boolean>;
	cacheInfo(cache: string): Promise<RenderedCacheInfo | undefined>;
	list(cache: string, query: ListObjectsQuery): Promise<ListObjectsResult>;

	/**
	 * Resolves the hash in a `nar/<hash>` key to the canonical NAR hash of a blob
	 * this tenant is permitted to read, or `undefined` when the blob is absent or
	 * not referenced by this tenant. NAR blobs are content-addressed and shared
	 * across tenants at rest, so this gate stops one tenant reading or probing
	 * another's blob by hash, and resolves a key named by the compressed file
	 * hash to the stored object.
	 */
	resolveServableNar(
		hash: NixSha256HashString
	): Promise<NixSha256HashString | undefined>;

	stageNar(
		fileHash: NixSha256HashString,
		body: ReadableStream<Uint8Array>,
		meta: PutObjectMeta
	): Promise<PutObjectResult>;
	beginNarUpload(
		fileHash: NixSha256HashString,
		meta: PutObjectMeta
	): Promise<MultipartUpload>;
	uploadNarPart(
		fileHash: NixSha256HashString,
		uploadId: string,
		partNumber: number,
		body: ReadableStream<Uint8Array>
	): Promise<UploadedPart>;
	completeNarUpload(
		fileHash: NixSha256HashString,
		uploadId: string,
		parts: readonly UploadedPart[]
	): Promise<CompletedUpload>;
	abortNarUpload(
		fileHash: NixSha256HashString,
		uploadId: string
	): Promise<void>;

	commitNarinfo(
		cache: string,
		storePathHash: StorePathHash,
		body: ReadableStream<Uint8Array>,
		meta: PutObjectMeta,
		principal: S3Principal | undefined
	): Promise<PutObjectResult>;
	remove(
		cache: string,
		object: NixCacheObject,
		principal: S3Principal | undefined
	): Promise<void>;
}

/**
 * An {@link ObjectStore} that projects a tenant's Nix cache as an S3 bucket.
 * Reads of narinfo and NAR objects are genuine delegation to the R2-backed
 * {@link BlobStore}; `nix-cache-info`, listing, writes and removal are the
 * materialisation carve-outs handled by the {@link NixCacheBackend}.
 */
export function createNixCacheObjectStore(
	tenant: string,
	blobStore: BlobStore,
	backend: NixCacheBackend
): ObjectStore {
	// The internal R2 key a readable object lives at, or `undefined` when it is
	// not present for this tenant. A NAR is gated on this tenant referencing the
	// hash and resolved to its canonical key, so a content-addressed blob another
	// tenant owns is never served or probed.
	async function readKeyFor(
		object: NixCacheObject,
		cache: string
	): Promise<string | undefined> {
		if (object.kind !== 'nar') {
			return internalKeyFor(object, tenant, cache);
		}

		const narHash = await backend.resolveServableNar(object.hash);
		return narHash === undefined
			? undefined
			: internalKeyFor({ kind: 'nar', hash: narHash }, tenant, cache);
	}

	return {
		async stat(context) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			await backend.authorizeRead(cache, context.principal);

			if (object.kind === 'cache-info') {
				const stat = statOf(await backend.cacheInfo(cache));
				if (stat === undefined) {
					throw new NoSuchKeyError(context.key);
				}
				return stat;
			}

			const key = await readKeyFor(object, cache);
			const stat = key === undefined ? undefined : await blobStore.head(key);
			if (stat === undefined) {
				throw new NoSuchKeyError(context.key);
			}
			return stat;
		},

		async get(context, range) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			await backend.authorizeRead(cache, context.principal);

			if (object.kind === 'cache-info') {
				const result = cacheInfoResult(await backend.cacheInfo(cache), range);
				if (result === undefined) {
					throw new NoSuchKeyError(context.key);
				}
				return result;
			}

			const key = await readKeyFor(object, cache);
			const result =
				key === undefined ? undefined : await blobStore.get(key, range);
			if (result === undefined) {
				throw new NoSuchKeyError(context.key);
			}
			return result;
		},

		async put(context, body, meta) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			await backend.authorizeWrite(cache, context.principal);

			if (object.kind === 'nar') {
				return backend.stageNar(object.hash, body, meta);
			}
			if (object.kind === 'narinfo') {
				return backend.commitNarinfo(
					cache,
					object.storePathHash,
					body,
					meta,
					context.principal
				);
			}

			throw new NonCacheWriteError(context.key);
		},

		async delete(context) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			await backend.authorizeWrite(cache, context.principal);
			await backend.remove(cache, object, context.principal);
		},

		async list(bucket, query, principal) {
			assertBucket(tenant, bucket);
			const { cache, objectPrefix } = resolveListPrefix(query.prefix);
			await backend.authorizeRead(cache, principal);

			const result = await backend.list(cache, {
				...query,
				prefix: objectPrefix
			});
			return scopeListing(cache, result);
		},

		async bucketExists(bucket, principal) {
			if (bucket !== tenant) {
				return false;
			}

			// The bucket is the tenant. A credential scoped to any of this tenant's
			// caches can see it, so existence is gated on that cache, not the default
			// one, and is reported as a boolean rather than an authorisation throw.
			if (principal?.tenant !== tenant) {
				return false;
			}
			return backend.cacheExists(principal.cache);
		},

		async createMultipartUpload(context, meta) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			await backend.authorizeWrite(cache, context.principal);

			if (object.kind !== 'nar') {
				throw new NonCacheWriteError(context.key);
			}
			return backend.beginNarUpload(object.hash, meta);
		},

		async uploadPart(context, uploadId, partNumber, body) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			await backend.authorizeWrite(cache, context.principal);

			if (object.kind !== 'nar') {
				throw new NonCacheWriteError(context.key);
			}
			return backend.uploadNarPart(object.hash, uploadId, partNumber, body);
		},

		async completeMultipartUpload(context, uploadId, parts) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			await backend.authorizeWrite(cache, context.principal);

			if (object.kind !== 'nar') {
				throw new NonCacheWriteError(context.key);
			}
			return backend.completeNarUpload(object.hash, uploadId, parts);
		},

		async abortMultipartUpload(context, uploadId) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			await backend.authorizeWrite(cache, context.principal);

			if (object.kind !== 'nar') {
				throw new NonCacheWriteError(context.key);
			}
			await backend.abortNarUpload(object.hash, uploadId);
		}
	};
}

function target(key: string): CacheTarget {
	const resolved = resolveCacheTarget(key);
	if (resolved === undefined) {
		throw new NoSuchKeyError(key);
	}
	return resolved;
}

function assertBucket(tenant: string, bucket: string): void {
	if (bucket !== tenant) {
		throw new NoSuchBucketError();
	}
}

function statOf(info: RenderedCacheInfo | undefined): ObjectStat | undefined {
	if (info === undefined) {
		return undefined;
	}

	return {
		size: info.body.length,
		etag: info.etag,
		contentType: 'text/x-nix-cache-info',
		lastModified: info.lastModified
	};
}

function cacheInfoResult(
	info: RenderedCacheInfo | undefined,
	range: ByteRange | undefined
): GetObjectResult | undefined {
	const stat = statOf(info);
	if (info === undefined || stat === undefined) {
		return undefined;
	}

	if (range === undefined) {
		return { stat, body: streamOfBytes(info.body) };
	}

	const { start, end } = resolveInfoRange(range, info.body.length);
	return {
		stat,
		body: streamOfBytes(info.body.slice(start, end + 1)),
		range: { start, end }
	};
}

function resolveInfoRange(
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

function streamOfBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});
}

function scopeListing(
	cache: string,
	result: ListObjectsResult
): ListObjectsResult {
	return {
		...result,
		objects: result.objects.map((object) => ({
			...object,
			key: cacheScopedKey(cache, object.key)
		})),
		commonPrefixes: result.commonPrefixes.map((prefix) =>
			cacheScopedKey(cache, prefix)
		)
	};
}
