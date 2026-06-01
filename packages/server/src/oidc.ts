import {
	createRemoteJWKSet,
	decodeJwt,
	type JWTPayload,
	jwtVerify,
	type JWTVerifyGetKey
} from 'jose';

import type { OidcClaims } from './oidc-trust.ts';

// Inbound OIDC tokens are signed by the identity provider with an asymmetric
// algorithm published in its JWKS. Pinning an asymmetric allowlist rejects
// `alg: none` and the public-key-as-HMAC-secret confusion; the JWKS binds the
// key material to the issuer, so the token header's `alg` never chooses the
// family. EdDSA covers issuers that sign with Ed25519.
const inboundAlgorithms = ['RS256', 'PS256', 'ES256', 'EdDSA'];
const inboundClockToleranceSeconds = 30;

const jwksCacheMaxAgeMs = 10 * 60 * 1000;
const jwksCooldownMs = 30 * 1000;
const jwksTimeoutMs = 5 * 1000;

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
	readonly issuer: string;
	readonly audience: string;
}

/**
 * Verifies an inbound OIDC token against a resolved key set, pinning the issuer,
 * audience and the asymmetric algorithm allowlist. The key resolver is supplied
 * by the caller: the Durable Object passes a cached remote JWKS, a test a local
 * one, so verification needs no network of its own.
 */
export async function verifyInboundOidcToken(
	resolveKey: JWTVerifyGetKey,
	token: string,
	options: InboundVerifyOptions,
	now: Date
): Promise<JWTPayload> {
	const verified = await jwtVerify(token, resolveKey, {
		issuer: options.issuer,
		audience: options.audience,
		algorithms: inboundAlgorithms,
		clockTolerance: inboundClockToleranceSeconds,
		currentDate: now
	}).catch((error: unknown) => {
		throw new OidcTokenVerificationError({ cause: error });
	});

	return verified.payload;
}

/**
 * A per-issuer cache of remote JWKS resolvers. `createRemoteJWKSet` keeps its
 * own bounded cache, refetch cooldown and request timeout, so a single resolver
 * per `jwksUrl` is reused across requests rather than refetched each time.
 */
export class RemoteJwksStore {
	private readonly resolvers = new Map<string, JWTVerifyGetKey>();

	resolver(jwksUrl: string): JWTVerifyGetKey {
		const existing = this.resolvers.get(jwksUrl);

		if (existing !== undefined) {
			return existing;
		}

		const resolver = createRemoteJWKSet(new URL(jwksUrl), {
			cacheMaxAge: jwksCacheMaxAgeMs,
			cooldownDuration: jwksCooldownMs,
			timeoutDuration: jwksTimeoutMs
		});
		this.resolvers.set(jwksUrl, resolver);

		return resolver;
	}
}
