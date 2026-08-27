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
