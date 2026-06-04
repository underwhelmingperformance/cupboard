import { z } from 'zod';

export const nixSha256HashPattern = /^sha256:[0-9a-df-np-sv-z]{52}$/;
export const storePathHashPattern = /^[0-9a-df-np-sv-z]{32}$/;
export const storePathNamePattern = /^[0-9A-Za-z+._?=-]+$/;
export const storePathBasenamePattern =
	/^[0-9a-df-np-sv-z]{32}-[0-9A-Za-z+._?=-]+$/;
export const storePathPattern =
	/^\/nix\/store\/[0-9a-df-np-sv-z]{32}-[0-9A-Za-z+._?=-]+$/;

export const rootNameMaxLength = 256;
export const rootTtlMinSeconds = 1;
export const rootTtlMaxSeconds = 315_360_000;

export function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;

		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}

	return false;
}

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
 * the transport rule — HTTPS, or HTTP only for loopback — and removes a trailing
 * slash, so that an issuer compares equal to a token's `iss` regardless of a
 * trailing slash, the discovery URL is exact, and the metadata `issuer` check
 * (OpenID Connect Discovery §4.3) is slash-insensitive.
 */
export class IssuerUrl {
	private constructor(readonly value: string) {}

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
		// trimmed — deliberately not host-lowercased or otherwise URL-normalised,
		// since OpenID Connect compares the issuer as a case-sensitive string.
		return new IssuerUrl(raw.endsWith('/') ? raw.slice(0, -1) : raw);
	}

	get discoveryUrl(): string {
		return `${this.value}/.well-known/openid-configuration`;
	}

	matches(other: string): boolean {
		return IssuerUrl.parse(other)?.value === this.value;
	}
}

// The issuer and audience cupboard stamps into, and pins when verifying, its own
// access tokens when a deployment leaves CUPBOARD_AUTH_ISSUER / _AUDIENCE unset.
// One default keeps the minted token, its verification, and the published OAuth
// metadata reporting the same identity.
export const defaultAuthIssuer = 'cupboard';
export const defaultAuthAudience = 'cupboard';

export const nixSha256HashSchema = z
	.string()
	.regex(nixSha256HashPattern)
	.brand('NixSha256Hash');
export type NixSha256HashString = z.infer<typeof nixSha256HashSchema>;

export const storePathHashSchema = z
	.string()
	.regex(storePathHashPattern)
	.brand('StorePathHash');
export type StorePathHash = z.infer<typeof storePathHashSchema>;

export const storePathSchema = z
	.string()
	.regex(storePathPattern)
	.brand('StorePath');
export type StorePathString = z.infer<typeof storePathSchema>;

export const storePathBasenameSchema = z
	.string()
	.regex(storePathBasenamePattern)
	.brand('StorePathBasename');
export type StorePathBasename = z.infer<typeof storePathBasenameSchema>;

export const rootNameSchema = z
	.string()
	.min(1)
	.max(rootNameMaxLength)
	.refine((value) => !hasControlCharacter(value))
	.brand('RootName');
export type RootName = z.infer<typeof rootNameSchema>;

export const ttlSecondsSchema = z
	.number()
	.int()
	.min(rootTtlMinSeconds)
	.max(rootTtlMaxSeconds)
	.brand('TtlSeconds');
export type TtlSeconds = z.infer<typeof ttlSecondsSchema>;

// The bootstrap signing key keeps the fixed id `active`; rotated keys are
// minted with a random UUID.
export const signingKeyIdSchema = z
	.union([z.literal('active'), z.uuid()])
	.brand('SigningKeyId');
export type SigningKeyId = z.infer<typeof signingKeyIdSchema>;

export const positiveIntSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER);

export const cacheNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;

// The default (unnamed) cache served at the bare root. Named caches carry a
// non-empty name matching `cacheNamePattern`; the empty string is reserved for
// the default and is deliberately not a valid cache name.
export const DEFAULT_CACHE = '';

export const cacheNameSchema = z
	.string()
	.regex(cacheNamePattern)
	.brand('CacheName');
export type CacheName = z.infer<typeof cacheNameSchema>;

// A tenant slug: the outer addressing boundary, one isolated namespace per tenant
// at `/t/<tenant>/`. It shares the cache-name shape but is its own branded type;
// named caches nest within a tenant at `/t/<tenant>/cache/<name>/`.
export const tenantIdSchema = z
	.string()
	.regex(cacheNamePattern)
	.brand('TenantId');
export type TenantId = z.infer<typeof tenantIdSchema>;

// A Nix substituter priority: a non-negative integer where lower is preferred.
export const cachePrioritySchema = z
	.number()
	.int()
	.min(0)
	.max(Number.MAX_SAFE_INTEGER)
	.brand('CachePriority');
export type CachePriority = z.infer<typeof cachePrioritySchema>;

export const compressionSchema = z.literal('zstd');

export const referencesSchema = z.array(storePathBasenameSchema);
