import { cacheUrl, reuseViewUrl } from '@cupboard/nix-store/cache-url';

const cacheHeaders: Readonly<Record<string, string>> = {
	accept: 'text/plain',
	'user-agent': 'cupboard-action'
};

export function cacheUrlFor(baseUrl: string, cache: string): string {
	return cacheUrl(baseUrl, cache.trim());
}

/**
 * The URL for a named tenant reuse view. Unlike {@link cacheUrlFor}, this
 * always hangs off the tenant base: a reuse view spans caches, so it has no
 * per-cache prefix to nest under.
 */
export function reuseViewUrlFor(baseUrl: string, view: string): string {
	return reuseViewUrl(baseUrl, view.trim());
}

/**
 * The cache's signing-key URL for a cache base URL. The base URL carries the
 * tenant path (`/t/<slug>`), so the key path is appended to the whole URL to
 * keep that path.
 */
export function cachePublicKeyUrl(cacheUrl: string): string {
	return `${cacheUrl.replace(/\/+$/u, '')}/pubkey`;
}

export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);

		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

export function cachePublicKeyRequestHeaders(): Readonly<
	Record<string, string>
> {
	return cacheHeaders;
}
