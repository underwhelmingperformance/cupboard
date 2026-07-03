const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Whether a URL may be used as an OIDC issuer or JWKS endpoint. HTTPS is
 * required so tokens and keys cannot be fetched over an interceptable channel;
 * plain HTTP is permitted only for loopback hosts, so local development and the
 * e2e stub issuer work without a certificate.
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
 * A validated, normalised OpenID Connect issuer identifier. Construction enforces
 * the transport rule (HTTPS, or HTTP only for loopback) and removes a trailing
 * slash, so that an issuer compares equal to a token's `iss` regardless of a
 * trailing slash, the discovery URL is exact, and the metadata `issuer` check
 * (OpenID Connect Discovery §4.3) is slash-insensitive.
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

		// The stored value is the raw identifier with only the trailing slash
		// trimmed, deliberately not host-lowercased or otherwise URL-normalised,
		// since OpenID Connect compares the issuer as a case-sensitive string.
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

// The issuer and audience cupboard stamps into, and pins when verifying, its own
// access tokens when a deployment leaves CUPBOARD_AUTH_ISSUER / _AUDIENCE unset.
// One default keeps the issued token, its verification, and the published OAuth
// metadata reporting the same identity.
export const defaultAuthIssuer = 'cupboard';
export const defaultAuthAudience = 'cupboard';
