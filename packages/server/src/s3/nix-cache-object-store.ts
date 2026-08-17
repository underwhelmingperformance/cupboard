import {
	DEFAULT_CACHE,
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash,
	type TenantId
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

export interface CacheMutationGate {
	run<T>(cache: StoredCache, operation: () => Promise<T>): Promise<T>;
}

/**
 * The Nix-specific collaborator the decorator delegates to for everything that
 * is not a plain byte read: authorisation, `nix-cache-info`, listing, the
 * write/ingestion pipeline, and removal.
 */
export interface NixCacheBackend {
	authoriseRead(
		cache: StoredCache,
		principal: S3Principal | undefined
	): Promise<void>;
	authoriseWrite(
		cache: StoredCache,
		principal: S3Principal | undefined
	): Promise<void>;

	cacheInfo(cache: StoredCache): Promise<RenderedCacheInfo | undefined>;
	list(cache: StoredCache, query: ListObjectsQuery): Promise<ListObjectsResult>;

	/**
	 * Resolves the hash in a `nar/<hash>` key to the canonical NAR hash of a blob
	 * that the selected cache references. Returns `undefined` when the cache has
	 * no committed reference to the blob. NAR blobs are shared across caches and
	 * tenants, so this check also prevents a credential from reading another
	 * cache's blob. A key may contain either the NAR hash or the compressed file
	 * hash; the latter resolves to the canonical NAR hash.
	 */
	resolveServableNar(
		cache: StoredCache,
		hash: NixSha256HashString
	): Promise<NixSha256HashString | undefined>;

	stageNar(
		cache: StoredCache,
		fileHash: NixSha256HashString,
		body: ReadableStream<Uint8Array>,
		meta: PutObjectMeta
	): Promise<PutObjectResult>;
	beginNarUpload(
		cache: StoredCache,
		fileHash: NixSha256HashString,
		meta: PutObjectMeta
	): Promise<MultipartUpload>;
	uploadNarPart(
		cache: StoredCache,
		fileHash: NixSha256HashString,
		uploadId: string,
		partNumber: number,
		contentLength: number | undefined,
		body: ReadableStream<Uint8Array>
	): Promise<UploadedPart>;
	completeNarUpload(
		cache: StoredCache,
		fileHash: NixSha256HashString,
		uploadId: string,
		parts: readonly UploadedPart[]
	): Promise<CompletedUpload>;
	abortNarUpload(
		cache: StoredCache,
		fileHash: NixSha256HashString,
		uploadId: string
	): Promise<void>;

	commitNarinfo(
		cache: StoredCache,
		storePathHash: StorePathHash,
		body: ReadableStream<Uint8Array>,
		meta: PutObjectMeta,
		principal: S3Principal | undefined
	): Promise<PutObjectResult>;
	remove(
		cache: StoredCache,
		object: NixCacheObject,
		principal: S3Principal | undefined
	): Promise<void>;
}

/**
 * An {@link ObjectStore} that projects a tenant's Nix cache as an S3 bucket.
 * The R2-backed {@link BlobStore} serves narinfo and NAR objects. The
 * {@link NixCacheBackend} handles `nix-cache-info`, listing, writes and removal
 * because those operations depend on cache metadata or the commit pipeline.
 */
export function createNixCacheObjectStore(
	tenant: TenantId,
	blobStore: BlobStore,
	backend: NixCacheBackend,
	mutationGate?: CacheMutationGate
): ObjectStore {
	const mutate = <T>(
		cache: StoredCache,
		operation: () => Promise<T>
	): Promise<T> =>
		mutationGate === undefined
			? operation()
			: mutationGate.run(cache, operation);
	// Returns the internal R2 key for an object this tenant may read. NAR lookup
	// first verifies that the selected cache references the hash, then resolves a
	// file hash to the canonical NAR key.
	async function readKeyFor(
		object: NixCacheObject,
		cache: StoredCache
	): Promise<string | undefined> {
		if (object.kind !== 'nar') {
			return internalKeyFor(object, tenant, cache);
		}

		const narHash = await backend.resolveServableNar(cache, object.hash);
		return narHash === undefined
			? undefined
			: internalKeyFor({ kind: 'nar', hash: narHash }, tenant, cache);
	}

	return {
		async stat(context) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			await backend.authoriseRead(cache, context.principal);

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
			await backend.authoriseRead(cache, context.principal);

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
			return mutate(cache, async () => {
				await backend.authoriseWrite(cache, context.principal);

				if (object.kind === 'nar') {
					return backend.stageNar(cache, object.hash, body, meta);
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
			});
		},

		async delete(context) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			await mutate(cache, async () => {
				await backend.authoriseWrite(cache, context.principal);
				await backend.remove(cache, object, context.principal);
			});
		},

		async list(bucket, query, principal) {
			assertBucket(tenant, bucket);
			const { cache, objectPrefix } = resolveListPrefix(query.prefix);
			await backend.authoriseRead(cache, principal);
			const scopedPrefix = cache === DEFAULT_CACHE ? '' : `${cache}/`;
			const continuationToken = query.continuationToken?.startsWith(
				scopedPrefix
			)
				? query.continuationToken.slice(scopedPrefix.length)
				: query.continuationToken;

			const result = await backend.list(cache, {
				...query,
				prefix: objectPrefix,
				continuationToken
			});
			return scopeListing(cache, result);
		},

		bucketExists(bucket, principal) {
			if (bucket !== tenant) {
				return Promise.resolve(false);
			}

			// The Worker admits an anonymous bucket operation only for an active,
			// public tenant. A verified credential belongs to this tenant, but its
			// cache is an object-key prefix rather than a separate bucket.
			return Promise.resolve(
				principal === undefined || principal.tenant === tenant
			);
		},

		async createMultipartUpload(context, meta) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			return mutate(cache, async () => {
				await backend.authoriseWrite(cache, context.principal);

				if (object.kind !== 'nar') {
					throw new NonCacheWriteError(context.key);
				}
				return backend.beginNarUpload(cache, object.hash, meta);
			});
		},

		async uploadPart(context, uploadId, partNumber, contentLength, body) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			return mutate(cache, async () => {
				await backend.authoriseWrite(cache, context.principal);

				if (object.kind !== 'nar') {
					throw new NonCacheWriteError(context.key);
				}
				return backend.uploadNarPart(
					cache,
					object.hash,
					uploadId,
					partNumber,
					contentLength,
					body
				);
			});
		},

		async completeMultipartUpload(context, uploadId, parts) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			return mutate(cache, async () => {
				await backend.authoriseWrite(cache, context.principal);

				if (object.kind !== 'nar') {
					throw new NonCacheWriteError(context.key);
				}
				return backend.completeNarUpload(cache, object.hash, uploadId, parts);
			});
		},

		async abortMultipartUpload(context, uploadId) {
			assertBucket(tenant, context.bucket);
			const { cache, object } = target(context.key);
			await mutate(cache, async () => {
				await backend.authoriseWrite(cache, context.principal);

				if (object.kind !== 'nar') {
					throw new NonCacheWriteError(context.key);
				}
				await backend.abortNarUpload(cache, object.hash, uploadId);
			});
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

function assertBucket(tenant: TenantId, bucket: string): void {
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
	cache: StoredCache,
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
		),
		nextContinuationToken:
			result.nextContinuationToken === undefined
				? undefined
				: cacheScopedKey(cache, result.nextContinuationToken)
	};
}
