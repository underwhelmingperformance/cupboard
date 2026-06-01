import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	type JSONWebKeySet,
	type JWK,
	SignJWT
} from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	decodeInboundClaims,
	OidcTokenDecodeError,
	OidcTokenVerificationError,
	RemoteJwksStore,
	verifyInboundOidcToken
} from './oidc.ts';

const issuer = 'https://accounts.example.com';
const audience = 'client-id.apps.example.com';
const now = new Date('2026-01-01T00:00:00.000Z');
const kid = 'idp-key-1';

interface InboundIssuer {
	readonly jwks: JSONWebKeySet;
	sign(claims: Record<string, unknown>, at?: Date): Promise<string>;
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

	return {
		jwks: { keys: [publicJwk] },
		async sign(claims, at = now) {
			const issuedAt = Math.floor(at.getTime() / 1000);

			return new SignJWT(claims)
				.setProtectedHeader({ alg: algorithm, kid })
				.setIssuer(issuer)
				.setAudience(audience)
				.setIssuedAt(issuedAt)
				.setExpirationTime(issuedAt + 600)
				.sign(privateKey);
		}
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
				{ issuer, audience },
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
			options: { issuer, audience: 'someone-else' },
			at: now,
			sign: (idp: InboundIssuer) => idp.sign({ sub: 'owner' })
		},
		{
			name: 'a mismatched issuer',
			options: { issuer: 'https://evil.example.com', audience },
			at: now,
			sign: (idp: InboundIssuer) => idp.sign({ sub: 'owner' })
		},
		{
			name: 'an expired token',
			options: { issuer, audience },
			at: new Date(now.getTime() + 3600 * 1000),
			sign: (idp: InboundIssuer) => idp.sign({ sub: 'owner' })
		}
	])('rejects $name', async ({ options, at, sign }) => {
		const idp = await inboundIssuer();
		const token = await sign(idp);

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
				{ issuer, audience },
				now
			)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});
});

describe('RemoteJwksStore', () => {
	it('reuses one resolver per jwks url and keeps them distinct', () => {
		const store = new RemoteJwksStore();
		const a = store.resolver('https://issuer-a.example.com/jwks');
		const b = store.resolver('https://issuer-b.example.com/jwks');

		expect({
			cachedSameUrl: store.resolver('https://issuer-a.example.com/jwks') === a,
			distinctUrls: a === b
		}).toStrictEqual({ cachedSameUrl: true, distinctUrls: false });
	});
});
