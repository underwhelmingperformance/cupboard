import {
	InvalidCacheUrlBaseError,
	InvalidCacheUrlSegmentError
} from './errors.ts';
import { DEFAULT_CACHE } from './scalars.ts';

// The URLs that address a cache and its views, derived from a base URL that may
// already carry a tenant path (`/t/<slug>`). Every builder appends to that path
// through `URL`, so the tenant prefix, scheme, host and port are preserved and
// a name that cannot form a path segment is refused rather than silently
// climbing or collapsing the path. The base itself must carry nothing beyond
// origin and path: embedded credentials would be sent on every request built
// from the result, and a query or fragment would corrupt it.

/**
 * The substituter URL for a cache: the base URL for the default cache, or the
 * base with a `/cache/<name>` segment for a named one.
 */
export function cacheUrl(baseUrl: string, cache: string | undefined): string {
	if (cache === undefined || cache === DEFAULT_CACHE) {
		return trimRight(parseBaseUrl(baseUrl).href);
	}

	return appendPathSegments(baseUrl, 'cache', cache);
}

/** The URL that serves a named reuse view under a cache base URL. */
export function reuseViewUrl(baseUrl: string, view: string): string {
	return appendPathSegments(baseUrl, 'reuse', view);
}

/** The URL that serves a cache's narinfo signing keys. */
export function publicKeyUrl(baseUrl: string): string {
	return appendPathSegments(baseUrl, 'pubkey');
}

function parseBaseUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);

	if (
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		url.hash !== ''
	) {
		throw new InvalidCacheUrlBaseError();
	}

	return url;
}

function appendPathSegments(baseUrl: string, ...segments: string[]): string {
	const url = parseBaseUrl(baseUrl);
	const basePath = url.pathname.replace(/\/+$/u, '');
	const encoded = segments.map((segment) => encodeSegment(segment));

	url.pathname = `${basePath}/${encoded.join('/')}`;

	return trimRight(url.href);
}

function encodeSegment(segment: string): string {
	if (['', '.', '..'].includes(segment)) {
		throw new InvalidCacheUrlSegmentError(segment);
	}

	return encodeURIComponent(segment);
}

function trimRight(value: string): string {
	return value.replace(/\/+$/u, '');
}
