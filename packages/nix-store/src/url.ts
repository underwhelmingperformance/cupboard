import { InvalidCacheUrlBaseError } from './errors.ts';

/**
 * The base a cache's URLs are built from, checked once so every builder and
 * every request derived from it can take the result on trust. Only the origin
 * and path are addressable, so a base is refused when it carries embedded
 * credentials, which would be sent on every request built from it, or a query
 * or fragment, which appending a path to would corrupt. Trailing slashes are
 * dropped from the path so one deployment has one base.
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

	base.pathname = base.pathname.replace(/\/+$/u, '') || '/';

	return base;
}

/**
 * Renders a URL for exact-string contexts: a Nix substituter list, an OIDC
 * audience claim, a stored trust rule's audience, a session-store key.
 * `URL#href` adds a trailing slash to a bare origin, so two references to the
 * same deployment could render as different strings; stripping trailing
 * slashes gives every URL one rendering, the form the workflows and docs use.
 */
export function canonicalHref(url: URL): string {
	return url.href.replace(/\/+$/u, '');
}
