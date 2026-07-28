import { InvalidCacheUrlSegmentError } from './errors.ts';
import { DEFAULT_CACHE, type StoredCache } from './scalars.ts';

// The URLs that address a cache and its views, derived from a base URL that may
// already carry a tenant path (`/t/<slug>`). Every builder appends to that path
// through `URL`, so the tenant prefix, scheme, host and port are preserved and
// a name that cannot form a path segment is refused rather than silently
// climbing or collapsing the path. Bases come from `parseBaseUrl`, which is
// where a base is checked for carrying nothing beyond origin and path.

/**
 * The substituter URL for a cache: the base URL for the default cache, or the
 * base with a `/cache/<name>` segment for a named one.
 */
export function cacheUrl(baseUrl: URL, cache: StoredCache | undefined): URL {
	if (cache === undefined || cache === DEFAULT_CACHE) {
		return new URL(baseUrl);
	}

	return appendPathSegments(baseUrl, 'cache', cache);
}

/** The URL that serves a named reuse view under a cache base URL. */
export function reuseViewUrl(baseUrl: URL, view: string): URL {
	return appendPathSegments(baseUrl, 'reuse', view);
}

/** The URL that serves a cache's narinfo signing keys. */
export function publicKeyUrl(baseUrl: URL): URL {
	return appendPathSegments(baseUrl, 'pubkey');
}

function appendPathSegments(baseUrl: URL, ...segments: string[]): URL {
	const url = new URL(baseUrl);
	const basePath = url.pathname.replace(/\/+$/u, '');
	const encoded = segments.map((segment) => encodeSegment(segment));

	url.pathname = `${basePath}/${encoded.join('/')}`;

	return url;
}

function encodeSegment(segment: string): string {
	if (['', '.', '..'].includes(segment)) {
		throw new InvalidCacheUrlSegmentError(segment);
	}

	return encodeURIComponent(segment);
}
