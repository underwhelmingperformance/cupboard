import {
	cacheUrl,
	reuseViewUrl,
	urlWithCredential
} from '@cupboard/nix-store/cache-url';
import { type StoredCache } from '@cupboard/nix-store/scalars';
import { type BasicCredential } from '@cupboard/shared/http';

const cacheHeaders: Readonly<Record<string, string>> = {
	accept: 'text/plain',
	'user-agent': 'cupboard-action'
};

/**
 * A configured cache and its optional read credential. Private caches provide
 * a cache-specific credential. Public caches omit it and can use the tenant
 * credential from netrc when the tenant requires authentication.
 */
export interface CacheSelection {
	readonly cache: StoredCache;
	readonly credential?: BasicCredential;
}

export function cacheUrlFor(baseUrl: URL, cache: StoredCache): URL {
	return cacheUrl(baseUrl, cache);
}

/**
 * Returns the substituter URL for one cache. A private-cache URL contains its
 * read credential because netrc is keyed by host and cannot select one cache.
 * A `nix-cache-info` probe uses `cacheUrlFor` instead and sends the credential
 * in an `authorization` header because fetch ignores URL credentials.
 */
export function substituterUrlFor(
	baseUrl: URL,
	selection: CacheSelection
): URL {
	const url = cacheUrl(baseUrl, selection.cache);

	return selection.credential === undefined
		? url
		: urlWithCredential(url, selection.credential);
}

/**
 * A reuse view spans every cache in a tenant. Build its URL from the tenant
 * base rather than nesting it under a cache-specific prefix.
 */
export function reuseViewUrlFor(baseUrl: URL, view: string): URL {
	return reuseViewUrl(baseUrl, view.trim());
}

export function cachePublicKeyRequestHeaders(): Readonly<
	Record<string, string>
> {
	return cacheHeaders;
}
