const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * OIDC issuer and JWKS URLs must use HTTPS so tokens and keys do not cross an
 * interceptable channel. HTTP is accepted only for a loopback host, which
 * supports local development and test issuers.
 */
export function isAllowedIssuerUrl(value: string): boolean {
	let url: URL;

	try {
		url = new URL(value);
	} catch {
		return false;
	}

	if (url.protocol === 'https:') {
		return true;
	}

	return url.protocol === 'http:' && loopbackHosts.has(url.hostname);
}

/**
 * An issuer must pass {@link isAllowedIssuerUrl} and contain no query, fragment
 * or user information. Cupboard removes one trailing slash before comparing
 * issuer strings or building the discovery URL. This tolerance is local;
 * OpenID Connect specifies exact issuer-string comparisons.
 */
export class IssuerUrl {
	static parse(raw: string): IssuerUrl | undefined {
		if (!isAllowedIssuerUrl(raw)) {
			return undefined;
		}

		// An OIDC issuer identifier carries no query, fragment or userinfo. The
		// discovery URL is built by appending a path, so anything here would yield a
		// malformed `<issuer>?x=1/.well-known/...`; reject it instead.
		const url = new URL(raw);

		if (
			url.search !== '' ||
			url.hash !== '' ||
			url.username !== '' ||
			url.password !== ''
		) {
			return undefined;
		}

		// Preserve the supplied identifier apart from one trailing slash.
		// Reconstructing it from `url` could normalise characters even though
		// Cupboard's issuer comparisons are string-based.
		return new IssuerUrl(raw.endsWith('/') ? raw.slice(0, -1) : raw);
	}

	private constructor(readonly value: string) {}

	get discoveryUrl(): string {
		return `${this.value}/.well-known/openid-configuration`;
	}

	matches(other: string): boolean {
		return IssuerUrl.parse(other)?.value === this.value;
	}
}

export const defaultAuthIssuer = 'cupboard';
export const defaultAuthAudience = 'cupboard';
