import type { OidcAudience, OidcIssuer } from '@cupboard/protocol/oidc';
import { isAllowedIssuerUrl, IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import type { OidcClaims } from '@cupboard/protocol/oidc-trust-match';
import {
	createRemoteJWKSet,
	customFetch,
	decodeJwt,
	errors as joseErrors,
	type JWTPayload,
	jwtVerify,
	type JWTVerifyGetKey
} from 'jose';
import { z } from 'zod';

// Inbound OIDC tokens are signed by the identity provider with an asymmetric
// algorithm published in its JWKS. This allowlist is the outer bound: it rejects
// `alg: none` and the public-key-as-HMAC-secret confusion regardless of what an
// issuer advertises. EdDSA covers issuers that sign with Ed25519.
export const inboundAlgorithmAllowlist = ['RS256', 'PS256', 'ES256', 'EdDSA'];
const inboundClockToleranceSeconds = 30;

const jwksCacheMaxAgeMs = 10 * 60 * 1000;
const jwksCooldownMs = 30 * 1000;
const jwksTimeoutMs = 5 * 1000;

// `customFetch` is jose's `unique symbol`; widen it to `symbol` so it can be
// used as a computed property key without tripping the unsafe-key lint.
const customFetchKey: symbol = customFetch;

export class OidcTokenDecodeError extends Error {
	constructor(options: { readonly cause: unknown }) {
		super('Subject token is not a decodable JWT', { cause: options.cause });
		this.name = 'OidcTokenDecodeError';
	}
}

export class OidcTokenVerificationError extends Error {
	constructor(options: { readonly cause: unknown }) {
		super('Subject token failed OIDC verification', { cause: options.cause });
		this.name = 'OidcTokenVerificationError';
	}
}

// The issuer's keys could not be retrieved (a JWKS fetch timeout, a bad JWKS
// response, or a network failure). This is distinct from the token itself
// failing verification, so the caller can treat it as transient and retry.
export class OidcKeysUnreachableError extends Error {
	constructor(options: { readonly cause: unknown }) {
		super("Could not retrieve the issuer's signing keys", {
			cause: options.cause
		});
		this.name = 'OidcKeysUnreachableError';
	}
}

export class OidcDiscoveryError extends Error {
	constructor(
		public readonly issuer: OidcIssuer,
		options: { readonly cause: unknown }
	) {
		super(`Could not resolve OIDC metadata for issuer ${issuer}`, {
			cause: options.cause
		});
		this.name = 'OidcDiscoveryError';
	}
}

/**
 * Reads the unverified claims of an inbound token so it can be routed to a trust
 * rule. Decoding reveals only what the token asserts; the signature is checked
 * separately by {@link verifyInboundOidcToken}.
 */
export function decodeInboundClaims(token: string): OidcClaims {
	try {
		return decodeJwt(token);
	} catch (error) {
		throw new OidcTokenDecodeError({ cause: error });
	}
}

export interface InboundVerifyOptions {
	readonly issuer: OidcIssuer;
	readonly audience: OidcAudience;
	readonly algorithms: readonly string[];
}

/**
 * Verifies an inbound OIDC token against a resolved key set, pinning the issuer,
 * audience and the supplied algorithm set. The key resolver and algorithms are
 * supplied by the caller (the Durable Object from the issuer's discovered
 * metadata, or a test from a local key set), so verification needs no network
 * of its own.
 */
// `jwtVerify` fails either because the token is bad or because the issuer's keys
// could not be fetched. These are the token-level failures; anything else (a
// JWKS timeout, a malformed JWKS response, a raw network error) means the keys
// were unreachable and the caller should treat the failure as transient and retry.
const tokenVerificationErrors = [
	joseErrors.JWSSignatureVerificationFailed,
	joseErrors.JWTExpired,
	joseErrors.JWTClaimValidationFailed,
	joseErrors.JWTInvalid,
	joseErrors.JWSInvalid,
	joseErrors.JOSEAlgNotAllowed,
	joseErrors.JWKSNoMatchingKey,
	joseErrors.JWKSMultipleMatchingKeys
];

function isTokenVerificationFailure(error: unknown): boolean {
	return tokenVerificationErrors.some(
		(errorClass) => error instanceof errorClass
	);
}

export async function verifyInboundOidcToken(
	resolveKey: JWTVerifyGetKey,
	token: string,
	options: InboundVerifyOptions,
	now: Date
): Promise<JWTPayload> {
	try {
		const verified = await jwtVerify(token, resolveKey, {
			// The rule's issuer is normalised without a trailing slash; accept the
			// token's `iss` with or without one, since some issuers (e.g. Auth0)
			// stamp the slash. `exp` is required so a token with no expiry cannot be
			// replayed indefinitely.
			issuer: [options.issuer, `${options.issuer}/`],
			audience: options.audience,
			algorithms: [...options.algorithms],
			requiredClaims: ['exp'],
			clockTolerance: inboundClockToleranceSeconds,
			currentDate: now
		});

		return verified.payload;
	} catch (error) {
		if (isTokenVerificationFailure(error)) {
			throw new OidcTokenVerificationError({ cause: error });
		}

		throw new OidcKeysUnreachableError({ cause: error });
	}
}

export interface OidcDiscovery {
	readonly jwksUri: string;
	readonly signingAlgValues?: readonly string[];
}

const oidcDiscoverySchema = z.object({
	issuer: z.url(),
	jwks_uri: z.url().refine(isAllowedIssuerUrl),
	id_token_signing_alg_values_supported: z.array(z.string()).optional()
});

// Bounds the discovery fetch so a stalled issuer endpoint cannot hang the token
// exchange. `fetch` honours an `AbortSignal`, so this is a real cancellation.
const discoveryTimeoutMs = 15_000;

/**
 * Fetches an issuer's OpenID Connect metadata to learn where its keys live and
 * which algorithms it signs with. The issuer URL alone configures a trust rule;
 * everything else is discovered here. The fetched metadata's own `issuer` must
 * match the one requested (OpenID Connect Discovery §4.3), so a misconfigured or
 * hostile document cannot redirect verification to another identity provider.
 */
export async function fetchOidcDiscovery(
	issuer: OidcIssuer,
	fetcher: typeof fetch = fetch
): Promise<OidcDiscovery> {
	const issuerUrl = IssuerUrl.parse(issuer);

	if (issuerUrl === undefined) {
		throw new OidcDiscoveryError(issuer, {
			cause: new Error(
				'issuer must use HTTPS, except that a loopback issuer may use HTTP'
			)
		});
	}

	let payload: unknown;

	try {
		// Do not follow redirects: a redirect from the issuer's metadata endpoint
		// to another host would let a compromised or hijacked endpoint serve a
		// substitute document. A 3xx fails the `ok` check below. (The JWKS fetch,
		// run by jose, is likewise pinned to `redirect: 'manual'`.)
		const response = await fetcher(issuerUrl.discoveryUrl, {
			redirect: 'manual',
			signal: AbortSignal.timeout(discoveryTimeoutMs)
		});

		if (!response.ok) {
			await response.text();
			throw new Error(
				`discovery responded with HTTP ${String(response.status)}`
			);
		}

		payload = await response.json();
	} catch (error) {
		throw new OidcDiscoveryError(issuer, { cause: error });
	}

	const metadata = oidcDiscoverySchema.safeParse(payload);

	if (!metadata.success) {
		throw new OidcDiscoveryError(issuer, { cause: metadata.error });
	}

	if (!issuerUrl.matches(metadata.data.issuer)) {
		throw new OidcDiscoveryError(issuer, {
			cause: new Error(
				`metadata issuer ${metadata.data.issuer} does not match ${issuer}`
			)
		});
	}

	return {
		jwksUri: metadata.data.jwks_uri,
		signingAlgValues: metadata.data.id_token_signing_alg_values_supported
	};
}

// OpenID Connect requires every provider to support RS256, so it is the safe
// assumption when an issuer's metadata advertises no signing algorithms.
const defaultInboundAlgorithm = 'RS256';

/**
 * The accepted algorithms for an issuer: the issuer's advertised set narrowed to
 * cupboard's asymmetric allowlist. An issuer that advertises nothing falls back
 * to RS256, the algorithm OpenID Connect mandates; one that advertises only
 * algorithms outside the allowlist can federate no token (the intersection is
 * empty, so verification rejects all).
 */
export function intersectAlgorithms(
	advertised: readonly string[] | undefined,
	allowlist: readonly string[]
): string[] {
	if (advertised === undefined) {
		return allowlist.filter(
			(algorithm) => algorithm === defaultInboundAlgorithm
		);
	}

	return allowlist.filter((algorithm) => advertised.includes(algorithm));
}

export interface ResolvedIssuer {
	readonly resolver: JWTVerifyGetKey;
	readonly algorithms: readonly string[];
}

interface CachedIssuer {
	readonly resolved: Promise<ResolvedIssuer>;
	readonly fetchedAtMs: number;
}

export interface OidcDiscoveryStoreOptions {
	readonly now?: () => number;
	readonly fetcher?: typeof fetch;
}

/**
 * A per-issuer cache of resolved OIDC metadata: the issuer's JWKS resolver and
 * its accepted algorithm set. Discovery is re-run once a cached entry is older
 * than {@link jwksCacheMaxAgeMs}, so an issuer that rotates its metadata (a new
 * `jwks_uri` or signing algorithms) is picked up without restarting the Worker.
 * The in-flight promise is cached so concurrent first requests share one
 * discovery fetch; a failed fetch is evicted so the next request retries.
 */
export class OidcDiscoveryStore {
	private readonly issuers = new Map<OidcIssuer, CachedIssuer>();

	private readonly now: () => number;

	private readonly fetcher: typeof fetch;

	constructor(options: OidcDiscoveryStoreOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
	}

	private async forgetIfFailed(
		issuer: OidcIssuer,
		entry: CachedIssuer
	): Promise<void> {
		try {
			await entry.resolved;
		} catch {
			// Evict only if this exact entry is still cached, so a newer
			// in-flight attempt is never dropped.
			if (this.issuers.get(issuer) === entry) {
				this.issuers.delete(issuer);
			}
		}
	}

	private async discover(issuer: OidcIssuer): Promise<ResolvedIssuer> {
		const discovery = await fetchOidcDiscovery(issuer, this.fetcher);

		return {
			resolver: createRemoteJWKSet(new URL(discovery.jwksUri), {
				cacheMaxAge: jwksCacheMaxAgeMs,
				cooldownDuration: jwksCooldownMs,
				[customFetchKey]: this.fetcher,
				timeoutDuration: jwksTimeoutMs
			}),
			algorithms: intersectAlgorithms(
				discovery.signingAlgValues,
				inboundAlgorithmAllowlist
			)
		};
	}

	// An `OidcIssuer` is normalised where it is minted, so two spellings of one
	// issuer (a trailing slash, say) arrive here as the same value and share a
	// single cache entry and a single discovery fetch.
	resolve(issuer: OidcIssuer): Promise<ResolvedIssuer> {
		const nowMs = this.now();
		const cached = this.issuers.get(issuer);

		if (
			cached !== undefined &&
			nowMs - cached.fetchedAtMs < jwksCacheMaxAgeMs
		) {
			return cached.resolved;
		}

		const entry: CachedIssuer = {
			resolved: this.discover(issuer),
			fetchedAtMs: nowMs
		};
		this.issuers.set(issuer, entry);
		void this.forgetIfFailed(issuer, entry);

		return entry.resolved;
	}
}
