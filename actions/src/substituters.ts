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
 * The URL for a named tenant reuse view. Unlike {@link cacheUrlFor}, this
 * always hangs off the tenant base: a reuse view spans caches, so it has no
 * per-cache prefix to nest under.
 */
export function reuseViewUrlFor(baseUrl: URL, view: string): URL {
	return reuseViewUrl(baseUrl, view.trim());
}

export function cachePublicKeyRequestHeaders(): Readonly<
	Record<string, string>
> {
	return cacheHeaders;
}
