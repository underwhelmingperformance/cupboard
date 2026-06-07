import {
	createLocalJWKSet,
	errors as joseErrors,
	exportJWK,
	generateKeyPair,
	type JSONWebKeySet,
	type JWK,
	SignJWT
} from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	decodeInboundClaims,
	fetchOidcDiscovery,
	inboundAlgorithmAllowlist,
	intersectAlgorithms,
	OidcDiscoveryError,
	OidcDiscoveryStore,
	OidcKeysUnreachableError,
	OidcTokenDecodeError,
	OidcTokenVerificationError,
	verifyInboundOidcToken
} from './oidc.ts';

const issuer = 'https://accounts.example.com';
const audience = 'client-id.apps.example.com';
const now = new Date('2026-01-01T00:00:00.000Z');
const kid = 'idp-key-1';

interface SignOptions {
	readonly at?: Date;
	readonly tokenIssuer?: string;
	readonly withExpiry?: boolean;
}

interface InboundIssuer {
	readonly jwks: JSONWebKeySet;
	sign(claims: Record<string, unknown>, at?: Date): Promise<string>;
	signWithoutExpiry(claims: Record<string, unknown>): Promise<string>;
	signWithIssuer(
		tokenIssuer: string,
		claims: Record<string, unknown>
	): Promise<string>;
}

async function inboundIssuer(algorithm = 'RS256'): Promise<InboundIssuer> {
	const { publicKey, privateKey } = await generateKeyPair(algorithm, {
		extractable: true
	});
	const publicJwk: JWK = {
		...(await exportJWK(publicKey)),
		kid,
		alg: algorithm,
		use: 'sig'
	};

	const build = (
		claims: Record<string, unknown>,
		{ at = now, tokenIssuer = issuer, withExpiry = true }: SignOptions = {}
	): Promise<string> => {
		const issuedAt = Math.floor(at.getTime() / 1000);
		const jwt = new SignJWT(claims)
			.setProtectedHeader({ alg: algorithm, kid })
			.setIssuer(tokenIssuer)
			.setAudience(audience)
			.setIssuedAt(issuedAt);

		if (withExpiry) {
			jwt.setExpirationTime(issuedAt + 600);
		}

		return jwt.sign(privateKey);
	};

	return {
		jwks: { keys: [publicJwk] },
		sign: (claims, at = now) => build(claims, { at }),
		signWithoutExpiry: (claims) => build(claims, { withExpiry: false }),
		signWithIssuer: (tokenIssuer, claims) => build(claims, { tokenIssuer })
	};
}

function verifyOptions(
	overrides: Partial<{ issuer: string; audience: string }> = {}
) {
	return {
		issuer,
		audience,
		algorithms: inboundAlgorithmAllowlist,
		...overrides
	};
}

describe('decodeInboundClaims', () => {
	it('returns the unverified claims of a well-formed token', async () => {
		const idp = await inboundIssuer();
		const token = await idp.sign({ sub: 'owner', repository_id: '1234' });

		const claims = decodeInboundClaims(token);

		expect({
			iss: claims.iss,
			aud: claims.aud,
			sub: claims.sub,
			repository_id: claims.repository_id
		}).toStrictEqual({
			iss: issuer,
			aud: audience,
			sub: 'owner',
			repository_id: '1234'
		});
	});

	it('rejects a token that is not a JWT', () => {
		expect(() => decodeInboundClaims('not-a-jwt')).toThrow(
			OidcTokenDecodeError
		);
	});
});

describe('verifyInboundOidcToken', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each(['RS256', 'ES256', 'EdDSA'])(
		'verifies a %s token against the issuer JWKS',
		async (algorithm) => {
			const idp = await inboundIssuer(algorithm);
			const token = await idp.sign({ sub: 'owner' });

			const payload = await verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				verifyOptions(),
				now
			);

			expect({
				iss: payload.iss,
				aud: payload.aud,
				sub: payload.sub
			}).toStrictEqual({ iss: issuer, aud: audience, sub: 'owner' });
		}
	);

	it.each([
		{
			name: 'a mismatched audience',
			options: verifyOptions({ audience: 'someone-else' }),
			at: now
		},
		{
			name: 'a mismatched issuer',
			options: verifyOptions({ issuer: 'https://evil.example.com' }),
			at: now
		},
		{
			name: 'an expired token',
			options: verifyOptions(),
			at: new Date(now.getTime() + 3600 * 1000)
		},
		{
			name: 'an algorithm outside the accepted set',
			options: { issuer, audience, algorithms: ['ES256'] },
			at: now
		}
	])('rejects $name', async ({ options, at }) => {
		const idp = await inboundIssuer();
		const token = await idp.sign({ sub: 'owner' });

		await expect(
			verifyInboundOidcToken(createLocalJWKSet(idp.jwks), token, options, at)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});

	it('rejects a symmetric algorithm outside the asymmetric allowlist', async () => {
		const secret = new TextEncoder().encode(
			'symmetric-secret-key-of-sufficient-length'
		);
		const issuedAt = Math.floor(now.getTime() / 1000);
		const token = await new SignJWT({ sub: 'owner' })
			.setProtectedHeader({ alg: 'HS256', kid })
			.setIssuer(issuer)
			.setAudience(audience)
			.setIssuedAt(issuedAt)
			.setExpirationTime(issuedAt + 600)
			.sign(secret);
		const jwks: JSONWebKeySet = {
			keys: [{ kty: 'oct', kid, alg: 'HS256', k: 'unused' }]
		};

		await expect(
			verifyInboundOidcToken(
				createLocalJWKSet(jwks),
				token,
				verifyOptions(),
				now
			)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});

	it('rejects an inbound token that carries no expiry', async () => {
		const idp = await inboundIssuer();
		const token = await idp.signWithoutExpiry({ sub: 'owner' });

		await expect(
			verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				verifyOptions(),
				now
			)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});

	it('accepts a token whose issuer carries a trailing slash', async () => {
		const idp = await inboundIssuer();
		const token = await idp.signWithIssuer(`${issuer}/`, { sub: 'owner' });

		const payload = await verifyInboundOidcToken(
			createLocalJWKSet(idp.jwks),
			token,
			verifyOptions(),
			now
		);

		expect(payload.iss).toBe(`${issuer}/`);
	});

	it('rejects every token when the accepted algorithm set is empty', async () => {
		const idp = await inboundIssuer();
		const token = await idp.sign({ sub: 'owner' });

		await expect(
			verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				{ issuer, audience, algorithms: [] },
				now
			)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});

	it('surfaces a JWKS retrieval failure as unreachable, not a bad token', async () => {
		const idp = await inboundIssuer();
		const token = await idp.sign({ sub: 'owner' });

		await expect(
			verifyInboundOidcToken(
				() => Promise.reject(new joseErrors.JWKSTimeout()),
				token,
				verifyOptions(),
				now
			)
		).rejects.toBeInstanceOf(OidcKeysUnreachableError);
	});
});

describe('intersectAlgorithms', () => {
	it.each([
		{
			name: 'falls back to RS256 when the issuer advertises none',
			advertised: undefined,
			expected: ['RS256']
		},
		{
			name: 'narrows to the advertised asymmetric algorithms',
			advertised: ['RS256'],
			expected: ['RS256']
		},
		{
			name: 'drops advertised algorithms outside the allowlist',
			advertised: ['RS256', 'HS256'],
			expected: ['RS256']
		},
		{
			name: 'yields nothing when the issuer advertises only excluded algorithms',
			advertised: ['HS256'],
			expected: []
		}
	])('$name', ({ advertised, expected }) => {
		expect(
			intersectAlgorithms(advertised, inboundAlgorithmAllowlist)
		).toStrictEqual(expected);
	});
});

describe('fetchOidcDiscovery', () => {
	const metadataUrl =
		'https://accounts.example.com/.well-known/openid-configuration';

	it('reads the jwks_uri and signing algorithms, ignoring a trailing slash', async () => {
		const requested: string[] = [];
		const fetcher: typeof fetch = (input) => {
			if (!(input instanceof URL) && typeof input !== 'string') {
				throw new TypeError('expected a URL');
			}

			requested.push(String(input));

			return Promise.resolve(
				Response.json({
					issuer,
					jwks_uri: 'https://accounts.example.com/jwks',
					id_token_signing_alg_values_supported: ['RS256', 'ES256'],
					authorization_endpoint: 'https://accounts.example.com/authorize'
				})
			);
		};

		const discovery = await fetchOidcDiscovery(`${issuer}/`, fetcher);

		expect({ requested, discovery }).toStrictEqual({
			requested: [metadataUrl],
			discovery: {
				jwksUri: 'https://accounts.example.com/jwks',
				signingAlgValues: ['RS256', 'ES256']
			}
		});
	});

	it('omits the algorithms when the issuer does not advertise them', async () => {
		const discovery = await fetchOidcDiscovery(issuer, () =>
			Promise.resolve(
				Response.json({
					issuer,
					jwks_uri: 'https://accounts.example.com/jwks'
				})
			)
		);

		expect(discovery).toStrictEqual({
			jwksUri: 'https://accounts.example.com/jwks',
			signingAlgValues: undefined
		});
	});

	it.each([
		{
			name: 'a non-OK response',
			fetcher: (): Promise<Response> =>
				Promise.resolve(new Response('nope', { status: 404 }))
		},
		{
			name: 'metadata without a jwks_uri',
			fetcher: (): Promise<Response> =>
				Promise.resolve(Response.json({ issuer }))
		},
		{
			name: 'metadata whose issuer does not match the requested one',
			fetcher: (): Promise<Response> =>
				Promise.resolve(
					Response.json({
						issuer: 'https://accounts.evil.com',
						jwks_uri: 'https://accounts.example.com/jwks'
					})
				)
		},
		{
			name: 'a jwks_uri served over plain http',
			fetcher: (): Promise<Response> =>
				Promise.resolve(
					Response.json({
						issuer,
						jwks_uri: 'http://accounts.example.com/jwks'
					})
				)
		},
		{
			name: 'a redirect away from the metadata endpoint',
			fetcher: (): Promise<Response> =>
				Promise.resolve(
					new Response(undefined, {
						status: 302,
						headers: { location: 'https://accounts.evil.com/.well-known' }
					})
				)
		}
	])('throws OidcDiscoveryError on $name', async ({ fetcher }) => {
		await expect(fetchOidcDiscovery(issuer, fetcher)).rejects.toBeInstanceOf(
			OidcDiscoveryError
		);
	});

	it('rejects an issuer that is not an allowed URL without fetching', async () => {
		let fetched = false;
		const fetcher: typeof fetch = () => {
			fetched = true;

			return Promise.resolve(Response.json({}));
		};

		await expect(
			fetchOidcDiscovery('http://accounts.example.com', fetcher)
		).rejects.toBeInstanceOf(OidcDiscoveryError);
		expect(fetched).toBe(false);
	});
});

describe('OidcDiscoveryStore', () => {
	it('re-runs discovery once a cached entry is older than the cache age', async () => {
		const requested: string[] = [];
		const fetcher: typeof fetch = (input) => {
			if (!(input instanceof URL) && typeof input !== 'string') {
				throw new TypeError('expected a URL');
			}

			requested.push(String(input));

			return Promise.resolve(
				Response.json({
					issuer,
					jwks_uri: 'https://accounts.example.com/jwks',
					id_token_signing_alg_values_supported: ['RS256']
				})
			);
		};
		let nowMs = 0;
		const store = new OidcDiscoveryStore({ now: () => nowMs, fetcher });

		await store.resolve(issuer);
		nowMs += 5 * 60 * 1000;
		await store.resolve(issuer);
		nowMs += 6 * 60 * 1000;
		await store.resolve(issuer);

		expect(requested).toStrictEqual([
			'https://accounts.example.com/.well-known/openid-configuration',
			'https://accounts.example.com/.well-known/openid-configuration'
		]);
	});

	it('dedupes concurrent first loads into a single discovery fetch', async () => {
		let fetches = 0;
		const fetcher: typeof fetch = (input) => {
			if (!(input instanceof URL) && typeof input !== 'string') {
				throw new TypeError('expected a URL');
			}

			fetches += 1;

			return Promise.resolve(
				Response.json({
					issuer,
					jwks_uri: 'https://accounts.example.com/jwks',
					id_token_signing_alg_values_supported: ['RS256']
				})
			);
		};
		const store = new OidcDiscoveryStore({ now: () => 0, fetcher });

		await Promise.all([store.resolve(issuer), store.resolve(issuer)]);

		expect(fetches).toBe(1);
	});

	it('evicts failed discovery so the next resolve retries', async () => {
		let fetches = 0;
		const fetcher: typeof fetch = () => {
			fetches += 1;

			if (fetches === 1) {
				return Promise.reject(new Error('issuer is unavailable'));
			}

			return Promise.resolve(
				Response.json({
					issuer,
					jwks_uri: 'https://accounts.example.com/jwks',
					id_token_signing_alg_values_supported: ['RS256']
				})
			);
		};
		const store = new OidcDiscoveryStore({ now: () => 0, fetcher });

		await expect(store.resolve(issuer)).rejects.toBeInstanceOf(
			OidcDiscoveryError
		);
		await store.resolve(issuer);

		expect(fetches).toBe(2);
	});
});
