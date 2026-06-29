import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	AccessTokenVerificationError,
	type AuthPublicKey,
	generateAuthKeyPair,
	InvalidGrantsError,
	issueAccessJwt,
	MissingGrantsError,
	MissingSubjectError,
	verifyAccessJwt
} from './auth.ts';

const issuer = 'cupboard';
const audience = 'cupboard';
const now = new Date('2026-01-01T00:00:00.000Z');
const ttlSeconds = 600;
const kid = 'k-test';

const wildcardGrants: AuthorizationDetails = [{ type: 'cupboard_wildcard' }];

function keySet(publicJwk: JsonWebKey): AuthPublicKey[] {
	return [{ kid, publicJwk }];
}

function accessErrorShape(
	error: unknown
):
	| { readonly name: string; readonly hasCause: boolean }
	| { readonly name: string } {
	if (error instanceof AccessTokenVerificationError) {
		return { name: error.name, hasCause: error.cause instanceof Error };
	}

	if (
		error instanceof MissingGrantsError ||
		error instanceof InvalidGrantsError ||
		error instanceof MissingSubjectError
	) {
		return { name: error.name };
	}

	if (error instanceof Error) {
		return { name: error.name };
	}

	return { name: 'NonErrorAccessTokenFailure' };
}

describe('issueAccessJwt and verifyAccessJwt', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		{
			name: 'a wildcard token',
			grants: wildcardGrants
		},
		{
			name: 'a cache-scoped token with a root selector',
			grants: authorizationDetailsSchema.parse([
				{
					type: 'cupboard_cache',
					actions: ['upload:commit', 'root:set'],
					cache: 'builds',
					root: 'github:owner/'
				}
			])
		}
	])('round-trips $name, preserving grants and subject', async ({ grants }) => {
		const keyPair = await generateAuthKeyPair();
		const token = await issueAccessJwt(
			keyPair.privateJwk,
			{ issuer, audience, subject: 'ci', grants, kid, ttlSeconds },
			now
		);

		const claims = await verifyAccessJwt(
			keySet(keyPair.publicJwk),
			token,
			{ issuer, audience },
			now
		);

		expect(claims).toStrictEqual({
			subject: 'ci',
			grants,
			expiresAt: new Date(now.getTime() + ttlSeconds * 1000)
		});
	});

	it('preserves audit claims alongside the grants', async () => {
		const keyPair = await generateAuthKeyPair();
		const token = await issueAccessJwt(
			keyPair.privateJwk,
			{
				issuer,
				audience,
				subject: 'ci',
				grants: wildcardGrants,
				kid,
				ttlSeconds,
				auditClaims: { repository_id: '1234' }
			},
			now
		);

		const claims = await verifyAccessJwt(
			keySet(keyPair.publicJwk),
			token,
			{ issuer, audience },
			now
		);

		expect(claims).toStrictEqual({
			subject: 'ci',
			grants: wildcardGrants,
			expiresAt: new Date(now.getTime() + ttlSeconds * 1000)
		});
	});

	it('selects the verification key by kid from a rotated set', async () => {
		const retired = await generateAuthKeyPair();
		const active = await generateAuthKeyPair();
		const token = await issueAccessJwt(
			active.privateJwk,
			{
				issuer,
				audience,
				subject: 'ci',
				grants: wildcardGrants,
				kid: 'k-new',
				ttlSeconds
			},
			now
		);

		const claims = await verifyAccessJwt(
			[
				{ kid, publicJwk: retired.publicJwk },
				{ kid: 'k-new', publicJwk: active.publicJwk }
			],
			token,
			{ issuer, audience },
			now
		);

		expect(claims).toStrictEqual({
			subject: 'ci',
			grants: wildcardGrants,
			expiresAt: new Date(now.getTime() + ttlSeconds * 1000)
		});
	});

	it.each([
		{
			name: 'a foreign signing key',
			expected: { name: 'AccessTokenVerificationError', hasCause: true },
			token: async () => {
				const foreign = await generateAuthKeyPair();

				return issueAccessJwt(
					foreign.privateJwk,
					{
						issuer,
						audience,
						subject: 'ci',
						grants: wildcardGrants,
						kid,
						ttlSeconds
					},
					now
				);
			},
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'an unknown key id',
			expected: { name: 'AccessTokenVerificationError', hasCause: true },
			token: async (privateJwk: JsonWebKey) =>
				issueAccessJwt(
					privateJwk,
					{
						issuer,
						audience,
						subject: 'ci',
						grants: wildcardGrants,
						kid: 'other-kid',
						ttlSeconds
					},
					now
				),
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'a mismatched issuer',
			expected: { name: 'AccessTokenVerificationError', hasCause: true },
			token: async (privateJwk: JsonWebKey) =>
				issueAccessJwt(
					privateJwk,
					{
						issuer: 'someone-else',
						audience,
						subject: 'ci',
						grants: wildcardGrants,
						kid,
						ttlSeconds
					},
					now
				),
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'a mismatched audience',
			expected: { name: 'AccessTokenVerificationError', hasCause: true },
			token: async (privateJwk: JsonWebKey) =>
				issueAccessJwt(
					privateJwk,
					{
						issuer,
						audience: 'someone-else',
						subject: 'ci',
						grants: wildcardGrants,
						kid,
						ttlSeconds
					},
					now
				),
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'an expired token',
			expected: { name: 'AccessTokenVerificationError', hasCause: true },
			token: async (privateJwk: JsonWebKey) =>
				issueAccessJwt(
					privateJwk,
					{
						issuer,
						audience,
						subject: 'ci',
						grants: wildcardGrants,
						kid,
						ttlSeconds
					},
					now
				),
			verifyOptions: { issuer, audience },
			at: new Date(now.getTime() + (ttlSeconds + 60) * 1000)
		},
		{
			name: 'a not-yet-valid token',
			expected: { name: 'AccessTokenVerificationError', hasCause: true },
			token: async (privateJwk: JsonWebKey) => {
				const future = new Date(now.getTime() + 3600 * 1000);

				return issueAccessJwt(
					privateJwk,
					{
						issuer,
						audience,
						subject: 'ci',
						grants: wildcardGrants,
						kid,
						ttlSeconds
					},
					future
				);
			},
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'a token without the at+jwt type header',
			expected: { name: 'AccessTokenVerificationError', hasCause: true },
			token: async (privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				void privateJwk;
				const issuedAt = Math.floor(now.getTime() / 1000);

				const jwt = new SignJWT({ authorization_details: wildcardGrants });
				return jwt
					.setProtectedHeader({ alg: 'EdDSA', kid })
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
			name: 'a token without an authorization_details claim',
			expected: { name: 'MissingGrantsError' },
			token: async (privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				void privateJwk;
				const issuedAt = Math.floor(now.getTime() / 1000);

				const jwt = new SignJWT({});
				return jwt
					.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
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
			name: 'a token whose authorization_details claim is malformed',
			expected: { name: 'InvalidGrantsError' },
			token: async (privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				void privateJwk;
				const issuedAt = Math.floor(now.getTime() / 1000);

				const jwt = new SignJWT({
					authorization_details: [{ type: 'unknown_grant' }]
				});
				return jwt
					.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
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
			expected: { name: 'AccessTokenVerificationError', hasCause: true },
			token: async () => {
				const issuedAt = Math.floor(now.getTime() / 1000);
				const encoder = new TextEncoder();
				const symmetricKey = encoder.encode(
					'symmetric-secret-key-of-sufficient-length'
				);

				const jwt = new SignJWT({ authorization_details: wildcardGrants });
				return jwt
					.setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid })
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
			expected: { name: 'MissingSubjectError' },
			token: async (privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				void privateJwk;
				const issuedAt = Math.floor(now.getTime() / 1000);

				const jwt = new SignJWT({ authorization_details: wildcardGrants });
				return jwt
					.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
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
	])('rejects $name', async ({ token, expected, verifyOptions, at }) => {
		const keyPair = await generateAuthKeyPair();
		const signingKey = await importPrivateKey(keyPair.privateJwk);
		const issued = await token(keyPair.privateJwk, signingKey);

		let rejected: ReturnType<typeof accessErrorShape> | { value: unknown };
		try {
			rejected = {
				value: await verifyAccessJwt(
					keySet(keyPair.publicJwk),
					issued,
					verifyOptions,
					at
				)
			};
		} catch (error_: unknown) {
			rejected = accessErrorShape(error_);
		}

		expect(rejected).toStrictEqual(expected);
	});

	it('rejects a structurally invalid token with a verification error', async () => {
		const keyPair = await generateAuthKeyPair();

		let error: ReturnType<typeof accessErrorShape> | { value: unknown };
		try {
			error = {
				value: await verifyAccessJwt(
					keySet(keyPair.publicJwk),
					'not-a-jwt',
					{ issuer, audience },
					now
				)
			};
		} catch (error_: unknown) {
			error = accessErrorShape(error_);
		}

		expect(error).toStrictEqual({
			name: 'AccessTokenVerificationError',
			hasCause: true
		});
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
