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
 * Creates the request used as the Workers Cache key for a public cache read.
 *
 * Client query parameters, fragments, and read credentials do not select
 * different cache content. Every request passed here has cleared the guard
 * without relying on a credential. Strip `authorization` and `cookie` before
 * forwarding the request so no read credential enters the cache-owning tenant
 * Worker and requests that differ only in their credentials share one cache
 * entry.
 */
export function canonicalCacheRequest(request: Request): Request {
	const canonical = new URL(request.url);
	canonical.search = '';
	canonical.hash = '';
	canonical.searchParams.set('cache-key-version', cacheKeyVersion);

	const forwarded = new Request(canonical, request);
	forwarded.headers.delete('authorization');
	forwarded.headers.delete('cookie');

	return forwarded;
}
