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

// Accept only the asymmetric algorithms that Cupboard supports. Excluding HMAC
// prevents a public key from the issuer's JWKS from being treated as a shared
// secret.
export const inboundAlgorithmAllowlist = ['RS256', 'PS256', 'ES256', 'EdDSA'];
const inboundClockToleranceSeconds = 30;

const jwksCacheMaxAgeMs = 10 * 60 * 1000;
const jwksCooldownMs = 30 * 1000;
const jwksTimeoutMs = 5 * 1000;

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
			// Cupboard deliberately treats issuer identifiers with and without one
			// trailing slash as equivalent for provider compatibility. Require `exp`
			// so every accepted token has a finite validity period.
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

const discoveryTimeoutMs = 15_000;

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
		// Keep discovery on the issuer-derived URL. The jose resolver applies the
		// same redirect policy when it fetches the JWKS.
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

// OIDC discovery requires the signing-algorithm field and requires it to include
// RS256. Use RS256 as a compatibility fallback when a provider omits the field.
const defaultInboundAlgorithm = 'RS256';

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

	// Trust-rule ingress removes one trailing slash, so those two configured
	// spellings must share a cache entry.
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
