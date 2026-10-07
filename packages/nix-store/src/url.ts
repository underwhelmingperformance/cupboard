import { InvalidCacheUrlBaseError } from './errors.ts';

/**
 * Returns `value` without its trailing slashes, as {@link canonicalHref} removes
 * them from a URL.
 */
// An anchored `/+$` expression can rescan a long suffix from every trailing
// slash. Scan backwards once so trimming remains linear in the path length.
export function withoutTrailingSlashes(value: string): string {
	let end = value.length;

	while (end > 0 && value.codePointAt(end - 1) === 0x2f) {
		end -= 1;
	}

	return value.slice(0, end);
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Whether a URL uses HTTPS, or plain HTTP to a loopback host. Callers use this
 * predicate to validate issuer and cupboard URLs before sending credentials.
 * The loopback exception lets local development and tests run without a
 * certificate.
 */
export function isHttpsOrLoopbackHttp(url: URL): boolean {
	if (url.protocol === 'https:') {
		return true;
	}

	return url.protocol === 'http:' && loopbackHosts.has(url.hostname);
}

/**
 * Validates and canonicalises a base URL for cache requests. It accepts only
 * HTTP and HTTPS URLs without credentials, a query or a fragment. The returned
 * URL is a copy, so the input remains unchanged. Its path has no trailing
 * slashes unless it is the root path, which remains `/`.
 */
export function parseBaseUrl(url: URL): URL {
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		url.hash !== ''
	) {
		throw new InvalidCacheUrlBaseError();
	}

	const base = new URL(url);

	base.pathname = withoutTrailingSlashes(base.pathname) || '/';

	return base;
}

/**
 * Returns the stable string used in Nix substituter lists, OIDC audience
 * claims, stored trust-rule audiences and session-store keys. `URL#href` adds a
 * trailing slash to a bare origin. Removing trailing slashes prevents the same
 * deployment from acquiring different exact-string identities.
 */
export function canonicalHref(url: URL): string {
	return withoutTrailingSlashes(url.href);
}
