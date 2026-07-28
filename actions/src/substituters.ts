import { cacheUrl, reuseViewUrl } from '@cupboard/nix-store/cache-url';
import { type StoredCache } from '@cupboard/nix-store/scalars';

const cacheHeaders: Readonly<Record<string, string>> = {
	accept: 'text/plain',
	'user-agent': 'cupboard-action'
};

export function cacheUrlFor(baseUrl: string, cache: StoredCache): string {
	return cacheUrl(baseUrl, cache);
}

/**
 * The URL for a named tenant reuse view. Unlike {@link cacheUrlFor}, this
 * always hangs off the tenant base: a reuse view spans caches, so it has no
 * per-cache prefix to nest under.
 */
export function reuseViewUrlFor(baseUrl: string, view: string): string {
	return reuseViewUrl(baseUrl, view.trim());
}

// The endpoint URLs built from a url input derive from its origin and path
// alone, so a value carrying anything else is a copy mistake: refusing it at
// input resolution names the offending field before any request is made,
// where the shared URL builders could only name the value.
export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);

		return (
			(url.protocol === 'http:' || url.protocol === 'https:') &&
			url.username === '' &&
			url.password === '' &&
			url.search === '' &&
			url.hash === ''
		);
	} catch {
		return false;
	}
}

export function cachePublicKeyRequestHeaders(): Readonly<
	Record<string, string>
> {
	return cacheHeaders;
}
