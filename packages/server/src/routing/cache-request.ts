import {
	cacheGenerationSchema,
	cacheReadRevisionSchema
} from '@cupboard/nix-store/scalars';

import { type CacheLifecycleVersion } from '../db/cache-generation.ts';

// The cache-key parameters carrying the addressed cache's generation and its
// read revision.
const generationParameter = 'cache-generation';
const readRevisionParameter = 'cache-read-revision';

/**
 * The version component in the Workers Cache key for every read the tenant
 * Worker serves.
 *
 * Workers Cache keys a stored response by the request path and query. Deploying
 * new code does not remove responses written by an earlier version. Increment
 * this value when a change alters which readers may receive a response, so the
 * a new deployment uses a cache-key format that earlier versions did not
 * populate.
 */
const cacheKeyVersion = '2';

/**
 * Creates the request used as the Workers Cache key for a public tenant read.
 *
 * Client query parameters, fragments, and read credentials do not select
 * different cache content. Every request passed here has cleared the guard
 * without relying on a credential. Strip `authorization` and `cookie` before
 * forwarding the request so no read credential enters the cache-owning tenant
 * Worker and requests that differ only in their credentials share one cache
 * entry.
 *
 * The addressed cache's generation and read revision are part of the key. A
 * cache name can be deleted and created again, and R2 keys narinfo objects by
 * path within a cache, so without the generation a reader of the new cache
 * could receive a response the previous one produced.
 */
export function canonicalCacheRequest(
	request: Request,
	version: CacheLifecycleVersion
): Request {
	const canonical = new URL(request.url);
	canonical.search = '';
	canonical.hash = '';
	canonical.searchParams.set('cache-key-version', cacheKeyVersion);
	canonical.searchParams.set(generationParameter, String(version.generation));
	canonical.searchParams.set(
		readRevisionParameter,
		String(version.readRevision)
	);

	const forwarded = new Request(canonical, request);
	forwarded.headers.delete('authorization');
	forwarded.headers.delete('cookie');

	return forwarded;
}

/**
 * The cache version {@link canonicalCacheRequest} wrote into a request's key,
 * or undefined when either parameter is absent or malformed.
 *
 * The tenant Worker reads it back from the request it receives. Only the
 * canonical request reaches that Worker, so a request without both parameters
 * was not keyed by cache incarnation: serving it would store a response that no
 * later deletion or access change can displace.
 */
export function cacheRequestVersion(
	request: Request
): CacheLifecycleVersion | undefined {
	const { searchParams } = new URL(request.url);
	const generation = cacheGenerationSchema.safeParse(
		Number(searchParams.get(generationParameter))
	);
	const readRevision = cacheReadRevisionSchema.safeParse(
		Number(searchParams.get(readRevisionParameter))
	);

	if (!generation.success || !readRevision.success) {
		return undefined;
	}

	return { generation: generation.data, readRevision: readRevision.data };
}
