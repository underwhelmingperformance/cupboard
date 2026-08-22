import type { OidcAudience, OidcIssuer } from '@cupboard/protocol/oidc';
import { isAllowedIssuerUrl, IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import type { OidcClaims } from '@cupboard/protocol/oidc-trust-match';
import { readResponseBytes } from '@cupboard/shared/response-body';
import {
	createRemoteJWKSet,
	customFetch,
	decodeJwt,
	errors as joseErrors,
	type FetchImplementation,
	type JWTPayload,
	jwtVerify,
	type JWTVerifyGetKey
} from 'jose';
import { z } from 'zod';

// Accept only the asymmetric algorithms that Cupboard supports. Excluding HMAC
// prevents a public key from the issuer's JWKS from being treated as a shared
// secret.
export const inboundAlgorithmAllowlist = ['RS256', 'PS256', 'ES256', 'EdDSA'];
const inboundClockToleranceSeconds = 30;

const jwksCacheMaxAgeMs = 10 * 60 * 1000;
const jwksCooldownMs = 30 * 1000;
const jwksTimeoutMs = 5 * 1000;

// Both endpoints return JSON metadata rather than bulk content. Discovery gets
// a compact ceiling, while JWKS allows more space for overlapping keys during
// rotation.
const discoveryMaximumBytes = 128 * 1024;
const jwksMaximumBytes = 1024 * 1024;

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
		super('Subject token failed signature or required-claim verification', {
			cause: options.cause
		});
		this.name = 'OidcTokenVerificationError';
	}
}

// Report JWKS loading failures separately from token verification failures.
// Callers map this class to a retryable issuer response.
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
 * Decodes unverified claims so the caller can select a trust rule. The caller
 * must verify the token against that rule before using any claim for
 * authorisation.
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
	readonly requireIdTokenClaims?: boolean;
}

/**
 * Verifies the signature, issuer, audience, expiry and algorithm with the
 * supplied key resolver. A remote resolver can fetch the issuer's JWKS while
 * this function runs.
 */
// Keep token-shape, claim, signature, algorithm and key-selection failures
// separate from failures to load the JWKS. Callers reject the former and return
// a retryable issuer response for the latter.
const tokenVerificationErrors = [
	joseErrors.JWSSignatureVerificationFailed,
	joseErrors.JWTExpired,
	joseErrors.JWTClaimValidationFailed,
	joseErrors.JWTInvalid,
	joseErrors.JWSInvalid,
	joseErrors.JOSEAlgNotAllowed,
	joseErrors.JOSENotSupported,
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
			issuer: options.issuer,
			audience: options.audience,
			algorithms: [...options.algorithms],
			requiredClaims: options.requireIdTokenClaims
				? ['exp', 'sub', 'iat']
				: ['exp'],
			clockTolerance: inboundClockToleranceSeconds,
			currentDate: now
		});

		if (options.requireIdTokenClaims) {
			if (
				typeof verified.payload.sub !== 'string' ||
				verified.payload.sub.length === 0
			) {
				throw new OidcTokenVerificationError({
					cause: new Error('ID token subject must be a non-empty string')
				});
			}

			if (
				typeof verified.payload.iat !== 'number' ||
				!Number.isFinite(verified.payload.iat)
			) {
				throw new OidcTokenVerificationError({
					cause: new Error('ID token issued-at time must be a finite number')
				});
			}
		}

		const tokenAudience = verified.payload.aud;

		if (Array.isArray(tokenAudience)) {
			const distinctAudiences = new Set(tokenAudience);
			const hasAdditionalAudience =
				distinctAudiences.size > 1 &&
				[...distinctAudiences].some(
					(audience) => audience !== options.audience
				);

			if (
				distinctAudiences.size > 1 &&
				(hasAdditionalAudience || verified.payload.azp !== options.audience)
			) {
				throw new OidcTokenVerificationError({
					cause: new Error('Multi-audience token is not exclusively authorised')
				});
			}
		}

		return verified.payload;
	} catch (error) {
		if (error instanceof OidcTokenVerificationError) {
			throw error;
		}

		if (isTokenVerificationFailure(error)) {
			throw new OidcTokenVerificationError({ cause: error });
		}

		throw new OidcKeysUnreachableError({ cause: error });
	}
}

export interface OidcDiscovery {
	readonly jwksUri: string;
	readonly signingAlgValues: readonly string[];
}

const oidcDiscoverySchema = z.object({
	issuer: z.url(),
	jwks_uri: z.url().refine(isAllowedIssuerUrl),
	response_types_supported: z.array(z.string()).min(1),
	subject_types_supported: z.array(z.string()).min(1),
	id_token_signing_alg_values_supported: z.array(z.string()).min(1)
});

const discoveryTimeoutMs = 15_000;

interface BoundedFetchOptions {
	readonly description: string;
	readonly maximumBytes: number;
}

/**
 * Fetches and buffers one response within a byte limit. The returned response
 * contains only the bounded bytes, so a downstream parser cannot bypass the
 * limit by calling `text()` or `json()` itself.
 */
async function fetchBoundedResponse(
	fetcher: typeof fetch,
	input: string | URL | Request,
	init: RequestInit,
	options: BoundedFetchOptions
): Promise<Response> {
	const response = await fetcher(input, init);
	const bytes = await readResponseBytes(response, {
		...options,
		signal: init.signal ?? undefined
	});
	const headers = new Headers(response.headers);
	headers.set('content-length', String(bytes.byteLength));

	return new Response(bytes.byteLength === 0 ? undefined : bytes, {
		headers,
		status: response.status,
		statusText: response.statusText
	});
}

/**
 * Fetches the issuer's metadata and returns the JWKS URL and advertised ID-token
 * algorithms. The metadata issuer must match the configured issuer under
 * Cupboard's trailing-slash normalisation before either value is used.
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
		const response = await fetchBoundedResponse(
			fetcher,
			issuerUrl.discoveryUrl,
			{
				redirect: 'manual',
				signal: AbortSignal.timeout(discoveryTimeoutMs)
			},
			{
				description: 'OIDC discovery response',
				maximumBytes: discoveryMaximumBytes
			}
		);

		if (!response.ok) {
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

/**
 * The accepted algorithms for an issuer: the issuer's advertised set narrowed to
 * Cupboard's asymmetric allowlist. An issuer that advertises only algorithms
 * outside the allowlist produces an empty set, so verification rejects every
 * token from that issuer.
 */
export function intersectAlgorithms(
	advertised: readonly string[],
	allowlist: readonly string[]
): string[] {
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
 * Caches each issuer's discovered algorithm set and JWKS resolver for ten
 * minutes. Concurrent first resolutions share one promise. A failed resolution
 * is removed so the next request retries.
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
		const jwksFetcher: FetchImplementation = (url, options) =>
			fetchBoundedResponse(this.fetcher, url, options, {
				description: 'OIDC JWKS response',
				maximumBytes: jwksMaximumBytes
			});

		return {
			resolver: createRemoteJWKSet(new URL(discovery.jwksUri), {
				cacheMaxAge: jwksCacheMaxAgeMs,
				cooldownDuration: jwksCooldownMs,
				[customFetchKey]: jwksFetcher,
				timeoutDuration: jwksTimeoutMs
			}),
			algorithms: intersectAlgorithms(
				discovery.signingAlgValues,
				inboundAlgorithmAllowlist
			)
		};
	}

	// The exact issuer identifier is the cache key. Values that differ by a
	// trailing slash remain separate trust domains even when their discovery URL
	// happens to be the same.
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
