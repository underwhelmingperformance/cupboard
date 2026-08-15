import { InvalidCacheUrlSegmentError } from './errors.ts';
import { DEFAULT_CACHE, type StoredCache } from './scalars.ts';

// The URLs that address a cache and its views, derived from a base URL that may
// already include a tenant path (`/t/<slug>`). Every builder appends its
// segments to that path, so the tenant prefix, scheme, host and port survive.
// `encodeURIComponent` leaves `.` and `..` unchanged and the `URL` path parser
// then resolves them away, so a name of `.`, `..` or the empty string is
// rejected outright. Any of the three would address the base path itself, or a
// level above it, instead of a child of it. Bases come from `parseBaseUrl`,
// which checks that a base has only an origin and a path.

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

/**
 * The base URL a tenant's caches are served under: the deployment's base with
 * the tenant's `/t/<slug>` path appended.
 */
export function tenantUrl(baseUrl: URL, tenant: string): URL {
	return appendPathSegments(baseUrl, 't', tenant);
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
