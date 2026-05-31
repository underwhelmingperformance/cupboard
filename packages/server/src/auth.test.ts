import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	type AccessScope,
	AccessTokenVerificationError,
	generateAuthKeyPair,
	InvalidScopeError,
	mintAccessJwt,
	MissingScopeError,
	MissingSubjectError,
	verifyAccessJwt
} from './auth.ts';

const issuer = 'cupboard';
const audience = 'cupboard';
const now = new Date('2026-01-01T00:00:00.000Z');
const ttlSeconds = 600;

describe('mintAccessJwt and verifyAccessJwt', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each(['write', 'admin'] satisfies AccessScope[])(
		'round-trips a %s token, preserving scope and subject',
		async (scope) => {
			const keyPair = await generateAuthKeyPair();
			const token = await mintAccessJwt(
				keyPair.privateJwk,
				{ issuer, audience, subject: 'ci', scope, ttlSeconds },
				now
			);

			const claims = await verifyAccessJwt(
				keyPair.publicJwk,
				token,
				{ issuer, audience },
				now
			);

			expect(claims).toStrictEqual({ scope, subject: 'ci' });
		}
	);

	it.each([
		{
			name: 'a foreign signing key',
			error: AccessTokenVerificationError,
			token: async () => {
				const foreign = await generateAuthKeyPair();

				return mintAccessJwt(
					foreign.privateJwk,
					{ issuer, audience, subject: 'ci', scope: 'admin', ttlSeconds },
					now
				);
			},
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'a mismatched issuer',
			error: AccessTokenVerificationError,
			token: async (privateJwk: JsonWebKey) => {
				return mintAccessJwt(
					privateJwk,
					{
						issuer: 'someone-else',
						audience,
						subject: 'ci',
						scope: 'admin',
						ttlSeconds
					},
					now
				);
			},
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'a mismatched audience',
			error: AccessTokenVerificationError,
			token: async (privateJwk: JsonWebKey) => {
				return mintAccessJwt(
					privateJwk,
					{
						issuer,
						audience: 'someone-else',
						subject: 'ci',
						scope: 'admin',
						ttlSeconds
					},
					now
				);
			},
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'an expired token',
			error: AccessTokenVerificationError,
			token: async (privateJwk: JsonWebKey) => {
				return mintAccessJwt(
					privateJwk,
					{ issuer, audience, subject: 'ci', scope: 'admin', ttlSeconds },
					now
				);
			},
			verifyOptions: { issuer, audience },
			at: new Date(now.getTime() + (ttlSeconds + 60) * 1000)
		},
		{
			name: 'a not-yet-valid token',
			error: AccessTokenVerificationError,
			token: async (privateJwk: JsonWebKey) => {
				const future = new Date(now.getTime() + 3600 * 1000);

				return mintAccessJwt(
					privateJwk,
					{ issuer, audience, subject: 'ci', scope: 'admin', ttlSeconds },
					future
				);
			},
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'a token without a scope claim',
			error: MissingScopeError,
			token: async (privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				const issuedAt = Math.floor(now.getTime() / 1000);
				void privateJwk;

				return new SignJWT({})
					.setProtectedHeader({ alg: 'EdDSA' })
					.setIssuer(issuer)
					.setAudience(audience)
					.setSubject('ci')
					.setIssuedAt(issuedAt)
					.setNotBefore(issuedAt)
					.setExpirationTime(issuedAt + ttlSeconds)
					.sign(signingKey);
			},
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'a token whose scope claim is not a known scope',
			error: InvalidScopeError,
			token: async (privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				const issuedAt = Math.floor(now.getTime() / 1000);
				void privateJwk;

				return new SignJWT({ scope: 'root' })
					.setProtectedHeader({ alg: 'EdDSA' })
					.setIssuer(issuer)
					.setAudience(audience)
					.setSubject('ci')
					.setIssuedAt(issuedAt)
					.setNotBefore(issuedAt)
					.setExpirationTime(issuedAt + ttlSeconds)
					.sign(signingKey);
			},
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'a token signed with a different algorithm',
			error: AccessTokenVerificationError,
			token: async () => {
				const issuedAt = Math.floor(now.getTime() / 1000);
				const symmetricKey = new TextEncoder().encode(
					'symmetric-secret-key-of-sufficient-length'
				);

				return new SignJWT({ scope: 'admin' })
					.setProtectedHeader({ alg: 'HS256' })
					.setIssuer(issuer)
					.setAudience(audience)
					.setSubject('ci')
					.setIssuedAt(issuedAt)
					.setNotBefore(issuedAt)
					.setExpirationTime(issuedAt + ttlSeconds)
					.sign(symmetricKey);
			},
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'a token without a subject claim',
			error: MissingSubjectError,
			token: async (privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				const issuedAt = Math.floor(now.getTime() / 1000);
				void privateJwk;

				return new SignJWT({ scope: 'admin' })
					.setProtectedHeader({ alg: 'EdDSA' })
					.setIssuer(issuer)
					.setAudience(audience)
					.setIssuedAt(issuedAt)
					.setNotBefore(issuedAt)
					.setExpirationTime(issuedAt + ttlSeconds)
					.sign(signingKey);
			},
			verifyOptions: { issuer, audience },
			at: now
		}
	])('rejects $name', async ({ token, error, verifyOptions, at }) => {
		const keyPair = await generateAuthKeyPair();
		const signingKey = await importPrivateKey(keyPair.privateJwk);
		const minted = await token(keyPair.privateJwk, signingKey);

		await expect(
			verifyAccessJwt(keyPair.publicJwk, minted, verifyOptions, at)
		).rejects.toBeInstanceOf(error);
	});

	it('rejects a structurally invalid token with a verification error', async () => {
		const keyPair = await generateAuthKeyPair();

		await expect(
			verifyAccessJwt(keyPair.publicJwk, 'not-a-jwt', { issuer, audience }, now)
		).rejects.toBeInstanceOf(AccessTokenVerificationError);
	});
});

async function importPrivateKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'jwk',
		privateJwk,
		{ name: 'Ed25519' },
		false,
		['sign']
	);
}
