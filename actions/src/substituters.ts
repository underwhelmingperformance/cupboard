import { cacheUrl, reuseViewUrl } from '@cupboard/nix-store/cache-url';
import { type StoredCache } from '@cupboard/nix-store/scalars';

const cacheHeaders: Readonly<Record<string, string>> = {
	accept: 'text/plain',
	'user-agent': 'cupboard-action'
};

export function cacheUrlFor(baseUrl: URL, cache: StoredCache): URL {
	return cacheUrl(baseUrl, cache);
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
