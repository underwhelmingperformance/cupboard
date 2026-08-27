import { InvalidCacheUrlSegmentError } from './errors.ts';
import {
	DEFAULT_CACHE,
	isPrivateCache,
	privateCacheLocalName,
	type StoredCache
} from './scalars.ts';

export function cacheUrl(baseUrl: URL, cache: StoredCache | undefined): URL {
	if (cache === undefined || cache === DEFAULT_CACHE) {
		return new URL(baseUrl);
	}

	// A private cache uses a separate URL namespace. Appending its stored name as
	// one path segment would encode the slash as `%2F`.
	if (isPrivateCache(cache)) {
		return appendPathSegments(
			baseUrl,
			'private-cache',
			privateCacheLocalName(cache)
		);
	}

	return appendPathSegments(baseUrl, 'cache', cache);
}

/**
 * A read credential for a substituter URL.
 */
export interface CacheUrlCredential {
	readonly user: string;
	readonly password: string;
}

/**
 * Returns a copy of `url` with the credential in its userinfo. A private cache
 * uses the tenant credential unless it has its own credential. When it does,
 * the cache accepts only that credential. Nix resolves netrc entries by host,
 * so a cache-specific credential must be supplied through URL userinfo.
 */
export function urlWithCredential(
	url: URL,
	credential: CacheUrlCredential
): URL {
	const authenticated = new URL(url);

	// The URL setters escape userinfo delimiters but preserve `%`. Without this
	// explicit encoding, a literal `%` in a credential would be decoded as part
	// of an escape sequence. The setters preserve the escapes produced here.
	authenticated.username = encodeURIComponent(credential.user);
	authenticated.password = encodeURIComponent(credential.password);

	return authenticated;
}

export function tenantUrl(baseUrl: URL, tenant: string): URL {
	return appendPathSegments(baseUrl, 't', tenant);
}

export function reuseViewUrl(baseUrl: URL, view: string): URL {
	return appendPathSegments(baseUrl, 'reuse', view);
}

export function privateReuseViewUrl(baseUrl: URL, view: string): URL {
	return appendPathSegments(baseUrl, 'private-reuse', view);
}

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
	// encodeURIComponent leaves `.` and `..` unchanged, and URL pathname
	// assignment resolves dot segments. Reject them and the empty segment so the
	// result addresses a child of the base rather than the base or its parent.
	if (['', '.', '..'].includes(segment)) {
		throw new InvalidCacheUrlSegmentError(segment);
	}

	return encodeURIComponent(segment);
}
