import {
	authKeyIdSchema,
	tenantIdSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema,
	type TrustRuleId,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import { type VerifiedOidcClaims } from '@cupboard/protocol/oidc-trust-match';
import {
	type RefreshSessionId,
	refreshSessionIdSchema
} from '@cupboard/protocol/sessions';
import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pushIdSigningKeySchema } from '../blob/push-id.ts';

import {
	type AccessIdentityKeyContext,
	SealedAccessIdentity
} from './access-identity.ts';
import {
	accessTokenType,
	AccessTokenVerificationError,
	type AuthPublicKey,
	bearerToken,
	generateAuthKeyPair,
	InvalidAccessClaimError,
	InvalidGrantsError,
	issueAccessJwt,
	issueTenantAccessJwt,
	MissingGrantsError,
	MissingIdentityError,
	MissingSubjectError,
	verifyAccessJwt,
	verifyTenantAccessJwt
} from './auth.ts';
import { recordedOidcIdentity } from './oidc-identity.ts';

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
		error instanceof MissingSubjectError ||
		error instanceof MissingIdentityError
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
					cache: { kind: 'named', name: 'builds' },
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

	it('marks issued tokens with the private Cupboard access-token type', async () => {
		const keyPair = await generateAuthKeyPair();
		const token = await issueAccessJwt(
			keyPair.privateJwk,
			{ issuer, audience, subject, grants: wildcardGrants, kid, ttlSeconds },
			now
		);

		expect(decodeProtectedHeader(token)).toStrictEqual({
			alg: 'EdDSA',
			typ: accessTokenType,
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
			token: async (_privateJwk: JsonWebKey, signingKey: CryptoKey) => {
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
			token: async (_privateJwk: JsonWebKey, signingKey: CryptoKey) => {
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
			token: async (_privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				const issuedAt = Math.floor(now.getTime() / 1000);

				const jwt = new SignJWT({});
				return jwt
					.setProtectedHeader({ alg: 'EdDSA', typ: accessTokenType, kid })
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
			token: async (_privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				const issuedAt = Math.floor(now.getTime() / 1000);

				const jwt = new SignJWT({
					authorization_details: [{ type: 'unknown_grant' }]
				});
				return jwt
					.setProtectedHeader({ alg: 'EdDSA', typ: accessTokenType, kid })
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
					.setProtectedHeader({ alg: 'HS256', typ: accessTokenType, kid })
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
			token: async (_privateJwk: JsonWebKey, signingKey: CryptoKey) => {
				const issuedAt = Math.floor(now.getTime() / 1000);

				const jwt = new SignJWT({ authorization_details: wildcardGrants });
				return jwt
					.setProtectedHeader({ alg: 'EdDSA', typ: accessTokenType, kid })
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

describe('issueTenantAccessJwt and verifyTenantAccessJwt', () => {
	const identity = recordedOidcIdentity({
		iss: 'https://token.actions.githubusercontent.com',
		sub: 'repo:acme/app:ref:refs/heads/main',
		aud: ['https://cupboard.example.workers.dev/t/acme'],
		repository: 'acme/app'
	});
	const keys: AccessIdentityKeyContext = {
		signingKey: pushIdSigningKeySchema.parse('identity-signing-key'),
		tenant: tenantIdSchema.parse('acme')
	};
	const ruleId = trustRuleIdSchema.parse('acme-ci');
	const sessionId = refreshSessionIdSchema.parse(
		'00000000-0000-4000-8000-000000000001'
	);
	const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

	function requireIdentity(): VerifiedOidcClaims {
		if (identity === undefined) {
			throw new Error('The fixture identity is not a recorded identity');
		}

		return identity;
	}

	async function issue(
		lineage: { ruleId?: TrustRuleId; sessionId?: RefreshSessionId } = {}
	): Promise<{ token: string; publicJwk: JsonWebKey }> {
		const keyPair = await generateAuthKeyPair();
		const token = await issueTenantAccessJwt(
			keyPair.privateJwk,
			{
				issuer,
				audience,
				subject,
				grants: wildcardGrants,
				kid,
				ttlSeconds,
				identity: await SealedAccessIdentity.seal(
					requireIdentity(),
					subject,
					keys
				),
				...lineage
			},
			now
		);

		return { token, publicJwk: keyPair.publicJwk };
	}

	it('keeps the identity unreadable to a holder of the token', async () => {
		const { token } = await issue();
		const payload = decodeJwt(token);

		expect({
			claimType: typeof payload.cb_identity,
			revealsIdentity: JSON.stringify(payload).includes('acme/app')
		}).toStrictEqual({ claimType: 'string', revealsIdentity: false });
	});

	it.each([
		{
			name: 'a rule and a session',
			lineage: { ruleId, sessionId },
			expected: { ruleId, sessionId }
		},
		{ name: 'neither a rule nor a session', lineage: {}, expected: {} }
	])(
		'returns the sealed identity of a token with $name',
		async ({ lineage, expected }) => {
			const { token, publicJwk } = await issue(lineage);

			const { identity: sealed, ...claims } = await verifyTenantAccessJwt(
				keySet(publicJwk),
				token,
				{ issuer, audience },
				now
			);

			expect({ ...claims, identity: await sealed.open(keys) }).toStrictEqual({
				subject,
				grants: wildcardGrants,
				expiresAt,
				identity: requireIdentity(),
				...expected
			});
		}
	);

	it.each([
		{
			name: 'another signing key',
			context: {
				...keys,
				signingKey: pushIdSigningKeySchema.parse('rotated-signing-key')
			},
			subject
		},
		{
			name: 'another tenant',
			context: { ...keys, tenant: tenantIdSchema.parse('other') },
			subject
		},
		{
			name: 'another subject',
			context: keys,
			subject: oidcSubjectSchema.parse('someone-else')
		}
	])(
		'does not open a sealed identity with $name',
		async ({ context, subject: presentedSubject }) => {
			const sealed = await SealedAccessIdentity.seal(
				requireIdentity(),
				subject,
				keys
			);
			const moved = SealedAccessIdentity.parse(sealed.value, presentedSubject);

			expect(await moved?.open(context)).toBeUndefined();
		}
	);

	it.each([
		{
			name: 'no identity claim',
			claims: {},
			expected: { name: 'MissingIdentityError' }
		},
		{
			name: 'a readable identity claim',
			claims: { cb_identity: { iss: 'https://idp.example', sub: 'ci' } },
			expected: { name: 'InvalidAccessClaimError', claim: 'cb_identity' }
		},
		{
			name: 'a malformed session claim',
			claims: { cb_identity: 'sealed', cb_session: 'not-a-uuid' },
			expected: { name: 'InvalidAccessClaimError', claim: 'cb_session' }
		}
	])('rejects a token with $name', async ({ claims, expected }) => {
		const keyPair = await generateAuthKeyPair();
		const sealed = await SealedAccessIdentity.seal(
			requireIdentity(),
			subject,
			keys
		);
		const token = await issueAccessJwt(
			keyPair.privateJwk,
			{
				issuer,
				audience,
				subject,
				grants: wildcardGrants,
				kid,
				ttlSeconds,
				auditClaims:
					claims.cb_identity === 'sealed'
						? { ...claims, cb_identity: sealed.value }
						: claims
			},
			now
		);

		let rejected: unknown;
		try {
			rejected = {
				value: await verifyTenantAccessJwt(
					keySet(keyPair.publicJwk),
					token,
					{ issuer, audience },
					now
				)
			};
		} catch (error: unknown) {
			rejected =
				error instanceof InvalidAccessClaimError
					? { name: error.name, claim: error.claim }
					: accessErrorShape(error);
		}

		expect(rejected).toStrictEqual(expected);
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
