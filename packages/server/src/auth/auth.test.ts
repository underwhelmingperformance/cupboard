import { authKeyIdSchema, ttlSecondsSchema } from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import { decodeProtectedHeader, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	AccessTokenVerificationError,
	type AuthPublicKey,
	bearerToken,
	generateAuthKeyPair,
	InvalidGrantsError,
	issueAccessJwt,
	MissingGrantsError,
	MissingSubjectError,
	verifyAccessJwt
} from './auth.ts';

const issuer = oidcIssuerSchema.parse('cupboard');
const audience = oidcAudienceSchema.parse('cupboard');
const subject = oidcSubjectSchema.parse('ci');
const otherIssuer = oidcIssuerSchema.parse('someone-else');
const otherAudience = oidcAudienceSchema.parse('someone-else');
const now = new Date('2026-01-01T00:00:00.000Z');
const ttlSeconds = ttlSecondsSchema.parse(600);
const kid = authKeyIdSchema.parse('k-test');

const wildcardGrants: AuthorizationDetails = [{ type: 'cupboard_wildcard' }];

describe('bearerToken', () => {
	it.each(['Bearer token', 'Bearer token=', 'bearer token', 'BeArEr   token'])(
		'parses %s with shared HTTP authentication grammar',
		(header) => {
			const credentials = header.slice(header.lastIndexOf(' ') + 1);

			expect(
				bearerToken(
					new Request('https://example.test', {
						headers: { authorization: header }
					})
				)
			).toBe(credentials);
		}
	);

	it.each([
		'Basic token',
		'Bearer',
		'Bearer   ',
		'Bearer to\tken',
		'Bearer token,other',
		'Bearer token=other'
	])('rejects %s', (header) => {
		expect(
			bearerToken(
				new Request('https://example.test', {
					headers: { authorization: header }
				})
			)
		).toBeUndefined();
	});
});

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
	])(
		'verifies $name with its subject, grants, and expiry intact',
		async ({ grants }) => {
			const keyPair = await generateAuthKeyPair();
			const token = await issueAccessJwt(
				keyPair.privateJwk,
				{ issuer, audience, subject, grants, kid, ttlSeconds },
				now
			);

			const claims = await verifyAccessJwt(
				keySet(keyPair.publicJwk),
				token,
				{ issuer, audience },
				now
			);

			expect(claims).toStrictEqual({
				subject,
				grants,
				expiresAt: new Date(now.getTime() + ttlSeconds * 1000)
			});
		}
	);

	it('accepts additional audit claims without changing the returned access claims', async () => {
		const keyPair = await generateAuthKeyPair();
		const token = await issueAccessJwt(
			keyPair.privateJwk,
			{
				issuer,
				audience,
				subject,
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
			subject,
			grants: wildcardGrants,
			expiresAt: new Date(now.getTime() + ttlSeconds * 1000)
		});
	});

	it('preserves the verified principal independently of token authority', async () => {
		const keyPair = await generateAuthKeyPair();
		const principal = { issuer, audience, subject };
		const token = await issueAccessJwt(
			keyPair.privateJwk,
			{
				issuer,
				audience,
				subject,
				grants: wildcardGrants,
				principal,
				kid,
				ttlSeconds
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
			subject,
			grants: wildcardGrants,
			principal,
			expiresAt: new Date(now.getTime() + ttlSeconds * 1000)
		});
	});

	it('marks issued tokens with the private Cupboard access-token type', async () => {
		const keyPair = await generateAuthKeyPair();
		const token = await issueAccessJwt(
			keyPair.privateJwk,
			{ issuer, audience, subject, grants: wildcardGrants, kid, ttlSeconds },
			now
		);

		expect(decodeProtectedHeader(token)).toStrictEqual({
			alg: 'EdDSA',
			typ: 'cupboard-access+jwt',
			kid
		});
	});

	it('verifies a token when its signing key is one of several live keys', async () => {
		const retired = await generateAuthKeyPair();
		const active = await generateAuthKeyPair();
		const token = await issueAccessJwt(
			active.privateJwk,
			{
				issuer,
				audience,
				subject,
				grants: wildcardGrants,
				kid: authKeyIdSchema.parse('k-new'),
				ttlSeconds
			},
			now
		);

		const claims = await verifyAccessJwt(
			[
				{ kid, publicJwk: retired.publicJwk },
				{ kid: authKeyIdSchema.parse('k-new'), publicJwk: active.publicJwk }
			],
			token,
			{ issuer, audience },
			now
		);

		expect(claims).toStrictEqual({
			subject,
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
						subject,
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
						subject,
						grants: wildcardGrants,
						kid: authKeyIdSchema.parse('other-kid'),
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
						issuer: otherIssuer,
						audience,
						subject,
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
						audience: otherAudience,
						subject,
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
						subject,
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
						subject,
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
			name: 'a token without the Cupboard access-token type header',
			expected: { name: 'AccessTokenVerificationError', hasCause: true },
			token: async (privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				void privateJwk;
				const issuedAt = Math.floor(now.getTime() / 1000);

				const jwt = new SignJWT({ authorization_details: wildcardGrants });
				return jwt
					.setProtectedHeader({ alg: 'EdDSA', kid })
					.setIssuer(issuer)
					.setAudience(audience)
					.setSubject(subject)
					.setIssuedAt(issuedAt)
					.setNotBefore(issuedAt)
					.setExpirationTime(issuedAt + ttlSeconds)
					.sign(signingKey);
			},
			verifyOptions: { issuer, audience },
			at: now
		},
		{
			name: 'an RFC 9068 access-token type header',
			expected: { name: 'AccessTokenVerificationError', hasCause: true },
			token: async (privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				void privateJwk;
				const issuedAt = Math.floor(now.getTime() / 1000);

				const jwt = new SignJWT({ authorization_details: wildcardGrants });
				return jwt
					.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
					.setIssuer(issuer)
					.setAudience(audience)
					.setSubject(subject)
					.setJti(crypto.randomUUID())
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
					.setProtectedHeader({ alg: 'EdDSA', typ: 'cupboard-access+jwt', kid })
					.setIssuer(issuer)
					.setAudience(audience)
					.setSubject(subject)
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
					.setProtectedHeader({ alg: 'EdDSA', typ: 'cupboard-access+jwt', kid })
					.setIssuer(issuer)
					.setAudience(audience)
					.setSubject(subject)
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
					.setProtectedHeader({ alg: 'HS256', typ: 'cupboard-access+jwt', kid })
					.setIssuer(issuer)
					.setAudience(audience)
					.setSubject(subject)
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
					.setProtectedHeader({ alg: 'EdDSA', typ: 'cupboard-access+jwt', kid })
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
