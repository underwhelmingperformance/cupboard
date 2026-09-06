import {
	InvalidCacheUrlSegmentError,
	InvalidTenantCacheUrlError
} from './errors.ts';
import { cacheNameSchema, type CacheScope, tenantIdSchema } from './scalars.ts';
import { parseBaseUrl } from './url.ts';

export interface TenantCacheUrl {
	readonly tenantUrl: URL;
	readonly cache: CacheScope;
}

function canonicalPathSegment(encoded: string): string {
	const decoded = decodeURIComponent(encoded);

	if (encodeURIComponent(decoded) !== encoded) {
		throw new URIError('Path segment is not canonically encoded');
	}

	return decoded;
}

export function cacheUrl(baseUrl: URL, cache: CacheScope): URL {
	if (cache.kind === 'default') {
		return new URL(baseUrl);
	}

	return appendPathSegments(baseUrl, 'cache', cache.name);
}

/**
 * Separates a tenant cache URL into its tenant URL and cache scope. Only the
 * canonical tenant path and its named-cache child are accepted.
 */
export function parseTenantCacheUrl(value: URL): TenantCacheUrl {
	const href = value.href;

	try {
		const url = parseBaseUrl(value);
		const segments = url.pathname.split('/');
		const tenantMarker = segments.at(-2);
		const encodedTenant = segments.at(-1);

		if (tenantMarker === 't' && encodedTenant !== undefined) {
			tenantIdSchema.parse(canonicalPathSegment(encodedTenant));

			return { tenantUrl: url, cache: { kind: 'default' } };
		}

		const namedTenantMarker = segments.at(-4);
		const encodedNamedTenant = segments.at(-3);
		const cacheMarker = segments.at(-2);
		const encodedCache = segments.at(-1);

		if (
			namedTenantMarker !== 't' ||
			encodedNamedTenant === undefined ||
			cacheMarker !== 'cache' ||
			encodedCache === undefined
		) {
			throw new InvalidTenantCacheUrlError(href);
		}

		tenantIdSchema.parse(canonicalPathSegment(encodedNamedTenant));
		const name = cacheNameSchema.parse(canonicalPathSegment(encodedCache));
		const tenantUrl = new URL(url);
		tenantUrl.pathname = segments.slice(0, -2).join('/') || '/';

		return { tenantUrl, cache: { kind: 'named', name } };
	} catch (error) {
		if (error instanceof InvalidTenantCacheUrlError) {
			throw error;
		}

		throw new InvalidTenantCacheUrlError(href, { cause: error });
	}
}

/**
 * A read credential for a substituter URL.
 */
export interface CacheUrlCredential {
	readonly user: string;
	readonly password: string;
}

/**
 * Returns a copy of `url` with the credential in its userinfo. Nix resolves
 * netrc entries by host, so a cache-specific credential must be supplied
 * through URL userinfo.
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
