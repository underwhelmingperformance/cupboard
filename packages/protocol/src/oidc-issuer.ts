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
 * A validated OpenID Connect issuer identifier. Construction enforces the
 * transport rule while preserving the exact identifier because discovery
 * metadata and token issuer comparisons are case-sensitive string comparisons.
 */
export class IssuerUrl {
	static parse(raw: string): IssuerUrl | undefined {
		if (!isAllowedIssuerUrl(raw) || hasForbiddenRawIssuerComponent(raw)) {
			return undefined;
		}

		// URL parsing erases empty query, fragment and userinfo components. Keep the
		// parsed checks as well so non-empty components cannot enter by another URL
		// spelling.
		const url = new URL(raw);

		if (
			url.search !== '' ||
			url.hash !== '' ||
			url.username !== '' ||
			url.password !== ''
		) {
			return undefined;
		}

		return new IssuerUrl(raw);
	}

	private constructor(readonly value: string) {}

	get discoveryUrl(): string {
		const separator = this.value.endsWith('/') ? '' : '/';

		return `${this.value}${separator}.well-known/openid-configuration`;
	}

	matches(other: string): boolean {
		return IssuerUrl.parse(other)?.value === this.value;
	}
}

function hasForbiddenRawIssuerComponent(raw: string): boolean {
	if (raw.includes('?') || raw.includes('#')) {
		return true;
	}

	const authority = /^https?:\/\/([^/?#]*)/iu.exec(raw)?.[1];

	return authority === undefined || authority.includes('@');
}

/**
 * The stored issuer value to replace during an explicit trailing-slash
 * compatibility repair, or `undefined` when no repair applies.
 */
export function legacyNormalisedIssuer(
	exactIssuer: string
): string | undefined {
	const exact = IssuerUrl.parse(exactIssuer);

	if (!exact?.value.endsWith('/')) {
		return undefined;
	}

	const legacy = exact.value.slice(0, -1);

	return IssuerUrl.parse(legacy)?.value;
}

// The issuer and audience Cupboard puts in its own access tokens, and pins when
// verifying them, when a deployment leaves CUPBOARD_AUTH_ISSUER and _AUDIENCE
// unset. One default keeps the issued token, its verification and the published
// OAuth metadata reporting the same identity.
export const defaultAuthIssuer = 'cupboard';
export const defaultAuthAudience = 'cupboard';
