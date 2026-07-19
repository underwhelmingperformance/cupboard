import { cacheUrl } from '@cupboard/nix-store/cache-url';

const cacheHeaders: Readonly<Record<string, string>> = {
	accept: 'text/plain',
	'user-agent': 'cupboard-action'
};

export function cacheUrlFor(baseUrl: string, cache: string): string {
	return cacheUrl(baseUrl, cache.trim());
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
