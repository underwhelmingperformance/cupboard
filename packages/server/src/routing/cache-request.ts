/**
 * Creates the request used as the Workers Cache key for a public tenant read.
 *
 * Client query parameters and fragments do not select different cache content,
 * and neither do read credentials: a request that reaches this point needed no
 * credential to pass the guard, so `authorization` and `cookie` are stripped
 * before the forward. Two readers that differ only in what they authenticate as
 * therefore share one cache entry, and no read credential enters the
 * cache-owning tenant Worker.
 */
export function canonicalCacheRequest(request: Request): Request {
	const canonical = new URL(request.url);
	canonical.search = '';
	canonical.hash = '';

	const forwarded = new Request(canonical, request);
	forwarded.headers.delete('authorization');
	forwarded.headers.delete('cookie');

	return forwarded;
}
