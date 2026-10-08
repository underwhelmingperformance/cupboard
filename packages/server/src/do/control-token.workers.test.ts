import { rootLogger } from '@cupboard/logger';
import { type CapturedLog, startCapture } from '@cupboard/logger/testing';
import { bytesToBase64Url } from '@cupboard/nix-store/encoding';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { type PermittedGrant } from '@cupboard/protocol/grants';
import {
	issuedAccessTokenType,
	oidcIssuerSchema,
	oidcSubjectSchema,
	refreshTokenGrantType,
	subjectTokenTypeIdToken,
	tokenExchangeGrantType,
	type TokenResponse,
	tokenResponseSchema,
	type TrustRuleId
} from '@cupboard/protocol/oidc';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { subjectBindingNonce } from '@cupboard/protocol/subject-binding';
import { env } from 'cloudflare:workers';
import { asc } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	consumedSubjectNonceRetentionSeconds,
	maxRefreshTokenFamilyMembers
} from '../auth/auth.ts';
import {
	RefreshCredential,
	type RefreshKeyContext,
	refreshPolicyIdentity
} from '../auth/refresh-credential.ts';
import { pushIdSigningKeySchema } from '../blob/push-id.ts';
import {
	controlOidcTrustRemove,
	controlTokenExchange
} from '../control/control-plane.ts';
import {
	controlRefreshPrunePageSize,
	pruneControlRefreshSessions
} from '../control/control-refresh-sessions.ts';
import { sha256Hex } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	ControlSubjectTokenUntrustedError,
	StoredControlTrustInvalidError,
	SubjectTokenNotJwtError,
	SubjectTokenVerificationFailedError,
	UnsupportedGrantTypeError,
	UnsupportedSubjectTokenTypeError
} from '../errors.ts';
import {
	controlFetch,
	currentOrigin,
	issueControlAdminToken,
	resetTestServer,
	seedControlTrust,
	testControlEnv
} from '../test-support.ts';

const oauthErrorSchema = z.strictObject({
	error: z.string(),
	error_description: z.string().min(1),
	problem: z.string().optional()
});

function oauthErrorShape(value: unknown): z.infer<typeof oauthErrorSchema> {
	return oauthErrorSchema.parse(value);
}

const jwkSchema = z.strictObject({
	kty: z.string(),
	crv: z.string(),
	kid: z.string().min(1),
	alg: z.string(),
	use: z.string(),
	x: z.string(),
	ext: z.boolean(),
	key_ops: z.tuple([z.string()])
});

const jwksResponseSchema = z.strictObject({
	keys: z.tuple([jwkSchema])
});

const authorizationServerMetadataSchema = z.strictObject({
	issuer: z.string(),
	token_endpoint: z.string(),
	jwks_uri: z.string(),
	response_types_supported: z.array(z.string()),
	grant_types_supported: z.array(z.string()),
	authorization_details_types_supported: z.array(z.string()),
	token_endpoint_auth_methods_supported: z.array(z.string()),
	revocation_endpoint: z.string(),
	revocation_endpoint_auth_methods_supported: z.array(z.string())
});

function postToken(
	form: Record<string, string>,
	envOverride: Readonly<Record<string, string>> = {}
): Promise<Response> {
	const body = new URLSearchParams(form);
	return controlFetch(
		'/token',
		{
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: body.toString()
		},
		envOverride
	);
}

function postRawToken(body: string): Promise<Response> {
	return controlFetch('/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body
	});
}

function tokenExchangeRequest(form: Record<string, string>): Request {
	const body = new URLSearchParams(form);
	return new Request(new URL('/token', currentOrigin()), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
}

async function tokenExchangeError(
	form: Record<string, string>
): Promise<unknown> {
	try {
		return await controlTokenExchange(
			tokenExchangeRequest(form),
			Object.assign({}, env, testControlEnv),
			rootLogger()
		);
	} catch (error: unknown) {
		return error;
	}
}

async function signedToken(options: {
	issuer: string;
	audience: string;
	subject?: string;
}): Promise<string> {
	const { privateKey } = await generateKeyPair('RS256', { extractable: true });

	const jwt = new SignJWT({});
	return jwt
		.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
		.setIssuer(options.issuer)
		.setAudience(options.audience)
		.setSubject(options.subject ?? 'someone')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(privateKey);
}

interface TrustedControlIdentity {
	readonly token: string;
	readonly rule: TrustRuleId;
	readonly issuer: string;
	readonly audience: string;
}

async function trustedControlIdentity(
	protectedType: string,
	permittedGrants?: readonly PermittedGrant[],
	additionalAudiences: readonly string[] = [],
	audience = 'cupboard-control',
	token: {
		readonly claims?: Readonly<Record<string, unknown>>;
		readonly issuedAt?: number;
	} = {}
): Promise<TrustedControlIdentity> {
	const issuer = `https://idp-${crypto.randomUUID()}.example.test`;
	const { publicKey, privateKey } = await generateKeyPair('RS256', {
		extractable: true
	});
	const publicJwk = await exportJWK(publicKey);

	const rule = await seedControlTrust({
		issuer,
		audience,
		claims: { sub: 'global-admin' },
		permittedGrants
	});
	vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input);

		if (url === `${issuer}/.well-known/openid-configuration`) {
			return Promise.resolve(
				Response.json({
					issuer,
					jwks_uri: `${issuer}/jwks`,
					id_token_signing_alg_values_supported: ['RS256']
				})
			);
		}

		if (url === `${issuer}/jwks`) {
			return Promise.resolve(
				Response.json({
					keys: [{ ...publicJwk, kid: 'idp', alg: 'RS256', use: 'sig' }]
				})
			);
		}

		return Promise.resolve(
			new Response(undefined, { status: StatusCodes.NOT_FOUND })
		);
	});

	const signed = await new SignJWT({
		...token.claims,
		...(additionalAudiences.length > 0 && { azp: audience })
	})
		.setProtectedHeader({ alg: 'RS256', kid: 'idp', typ: protectedType })
		.setIssuer(issuer)
		.setAudience(
			additionalAudiences.length === 0
				? audience
				: [audience, ...additionalAudiences]
		)
		.setSubject('global-admin')
		.setIssuedAt(token.issuedAt)
		.setExpirationTime('5m')
		.sign(privateKey);

	return { token: signed, rule, issuer, audience };
}

const controlRefreshKeys: RefreshKeyContext = {
	kind: 'control',
	wrappingSecret: testControlEnv.CONTROL_KEY_WRAP_SECRET
};

const staleRefresh = {
	status: StatusCodes.BAD_REQUEST,
	error: 'invalid_grant',
	problem: 'stale-refresh-token'
};

const emptyRevocation = {
	status: StatusCodes.OK,
	cacheControl: 'no-store',
	body: ''
};

function controlDatabase() {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

async function controlRefreshRows() {
	const database = controlDatabase();

	return {
		families: await database
			.select()
			.from(d1Schema.controlRefreshSessionFamily)
			.orderBy(asc(d1Schema.controlRefreshSessionFamily.id))
			.all(),
		members: await database
			.select()
			.from(d1Schema.controlRefreshSessionMember)
			.orderBy(asc(d1Schema.controlRefreshSessionMember.generation))
			.all()
	};
}

async function exchangeControlIdentity(
	identity: TrustedControlIdentity
): Promise<TokenResponse> {
	const response = await postToken({
		grant_type: tokenExchangeGrantType,
		subject_token: identity.token,
		subject_token_type: subjectTokenTypeIdToken
	});

	return tokenResponseSchema.parse(await response.json());
}

function refreshControl(refreshToken: string): Promise<Response> {
	return postToken({
		grant_type: refreshTokenGrantType,
		refresh_token: refreshToken
	});
}

async function refreshedControl(refreshToken: string): Promise<TokenResponse> {
	const response = await refreshControl(refreshToken);

	return tokenResponseSchema.parse(await response.json());
}

async function refusalOf(
	response: Response
): Promise<{ status: number; error: string; problem: string | undefined }> {
	const body = oauthErrorShape(await response.json());

	return { status: response.status, error: body.error, problem: body.problem };
}

function postRevoke(form: Record<string, string>): Promise<Response> {
	return controlFetch('/revoke', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(form).toString()
	});
}

async function revocationOutcome(
	form: Record<string, string>
): Promise<{ status: number; cacheControl: string | null; body: string }> {
	const response = await postRevoke(form);

	return {
		status: response.status,
		cacheControl: response.headers.get('cache-control'),
		body: await response.text()
	};
}

function memberIdOf(refreshToken: string | undefined): string {
	const [memberId] = z
		.tuple([z.uuid(), z.string(), z.string(), z.string()])
		.parse((refreshToken ?? '').split('.'));

	return memberId;
}

describe('control plane POST /token', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('rejects an unsupported subject token type', async () => {
		const error = await tokenExchangeError({
			grant_type: tokenExchangeGrantType,
			subject_token: 'x',
			subject_token_type: 'urn:ietf:params:oauth:token-type:jwt'
		});

		expect(error).toBeInstanceOf(UnsupportedSubjectTokenTypeError);
	});

	it.each([
		{
			name: 'an unsupported grant type',
			form: () =>
				Promise.resolve({
					grant_type: 'authorization_code',
					subject_token: 'x',
					subject_token_type: subjectTokenTypeIdToken
				}),
			error: UnsupportedGrantTypeError
		},
		{
			name: 'a subject token that is not a JWT',
			form: () =>
				Promise.resolve({
					grant_type: tokenExchangeGrantType,
					subject_token: 'not-a-jwt',
					subject_token_type: subjectTokenTypeIdToken
				}),
			error: SubjectTokenNotJwtError
		},
		{
			name: 'a subject token that matches no control trust rule',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await signedToken({
					issuer: 'https://idp.example.test',
					audience: 'cupboard-control'
				}),
				subject_token_type: subjectTokenTypeIdToken
			}),
			error: ControlSubjectTokenUntrustedError
		}
	])('rejects $name', async ({ form, error }) => {
		expect(await tokenExchangeError(await form())).toBeInstanceOf(error);
	});

	it('dispatches a minimal unsupported grant before exchange validation', async () => {
		expect(
			await tokenExchangeError({ grant_type: 'authorization_code' })
		).toBeInstanceOf(UnsupportedGrantTypeError);
	});

	it('ignores an unknown extension parameter', async () => {
		const presented = await issueControlAdminToken('global-admin');
		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: presented,
			subject_token_type: issuedAccessTokenType,
			'urn:example:extension': 'value'
		});

		expect(response.status).toBe(StatusCodes.OK);
	});

	it.each([
		{
			name: 'an external subject token without its type',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await signedToken({
					issuer: 'https://idp.example.test',
					audience: 'cupboard-control'
				})
			}),
			problem: 'schema-mismatch'
		},
		{
			name: 'a self-issued subject token without its type',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await issueControlAdminToken('global-admin')
			}),
			problem: 'schema-mismatch'
		},
		{
			name: 'a self-issued subject token with an unsupported type',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await issueControlAdminToken('global-admin'),
				subject_token_type: 'unsupported'
			}),
			problem: 'unsupported-subject-token-type'
		},
		{
			name: 'a self-issued access token declared as an ID token',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await issueControlAdminToken('global-admin'),
				subject_token_type: subjectTokenTypeIdToken
			}),
			problem: 'unsupported-subject-token-type'
		},
		{
			name: 'a self-issued access token declared as a generic JWT',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await issueControlAdminToken('global-admin'),
				subject_token_type: 'urn:ietf:params:oauth:token-type:jwt'
			}),
			problem: 'unsupported-subject-token-type'
		},
		{
			name: 'an external exchange with a refresh token',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await signedToken({
					issuer: 'https://idp.example.test',
					audience: 'cupboard-control'
				}),
				subject_token_type: subjectTokenTypeIdToken,
				refresh_token: 'refresh-token'
			}),
			problem: 'schema-mismatch'
		},
		{
			name: 'a self-issued exchange with a refresh token',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await issueControlAdminToken('global-admin'),
				subject_token_type: issuedAccessTokenType,
				refresh_token: 'refresh-token'
			}),
			problem: 'schema-mismatch'
		}
	])('rejects $name', async ({ form, problem }) => {
		const response = await postToken(await form());
		const body = oauthErrorShape(await response.json());

		expect({
			status: response.status,
			error: body.error,
			problem: body.problem
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_request',
			problem
		});
	});

	it.each([
		{
			name: 'grant_type',
			body: 'grant_type=first&grant_type=second'
		},
		{
			name: 'an unknown extension',
			body: 'grant_type=authorization_code&extension=first&extension=second'
		}
	])('rejects a repeated $name parameter', async ({ body }) => {
		const response = await postRawToken(body);
		const error = oauthErrorShape(await response.json());

		expect({ status: response.status, error: error.error }).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_request'
		});
	});

	it.each([
		'grant_type=authorization_code&subject_token=',
		'grant_type=authorization_code&resource=https%3A%2F%2Fresource.example'
	])(
		'dispatches an unsupported grant before validating its fields: %s',
		async (requestBody) => {
			const response = await postRawToken(requestBody);
			const body = oauthErrorShape(await response.json());

			expect({ status: response.status, error: body.error }).toStrictEqual({
				status: StatusCodes.BAD_REQUEST,
				error: 'unsupported_grant_type'
			});
		}
	);

	it.each([
		'resource',
		'audience',
		'scope',
		'requested_token_type',
		'actor_token',
		'actor_token_type'
	])('rejects the known unsupported %s parameter', async (parameter) => {
		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: 'x',
			subject_token_type: subjectTokenTypeIdToken,
			[parameter]: 'unsupported'
		});
		const body = oauthErrorShape(await response.json());

		expect({ status: response.status, error: body.error }).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_request'
		});
	});

	it('renders an OAuth error as a no-store envelope', async () => {
		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: 'x',
			subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
		});
		const body = oauthErrorShape(await response.json());

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			pragma: response.headers.get('pragma'),
			error: body.error,
			problem: body.problem
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			cacheControl: 'no-store',
			pragma: 'no-cache',
			error: 'invalid_request',
			problem: 'unsupported-subject-token-type'
		});
	});

	it.each([
		{
			name: 'an ID token exchange',
			respond: async () => {
				const { token } = await trustedControlIdentity('JWT');

				return postToken({
					grant_type: tokenExchangeGrantType,
					subject_token: token,
					subject_token_type: subjectTokenTypeIdToken
				});
			}
		},
		{
			name: 'an exchange of an issued token',
			respond: async () =>
				postToken({
					grant_type: tokenExchangeGrantType,
					subject_token: await issueControlAdminToken('global-admin'),
					subject_token_type: issuedAccessTokenType
				})
		}
	])('renders $name with the OAuth cache directives', async ({ respond }) => {
		const response = await respond();
		await response.text();

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			pragma: response.headers.get('pragma')
		}).toStrictEqual({
			status: StatusCodes.OK,
			cacheControl: 'no-store',
			pragma: 'no-cache'
		});
	});

	it('narrows a self-issued control token to a requested subset', async () => {
		const presented = await issueControlAdminToken('global-admin');
		const subset = [
			{ type: 'cupboard_tenant', actions: ['tenant:suspend'], tenant: 'acme' }
		];

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: presented,
			subject_token_type: issuedAccessTokenType,
			authorization_details: JSON.stringify(subset)
		});
		const body = tokenResponseSchema.parse(await response.json());

		expect({
			status: response.status,
			granted: body.authorization_details,
			refresh: body.refresh_token
		}).toStrictEqual({
			status: StatusCodes.OK,
			granted: subset,
			refresh: undefined
		});
	});

	it('does not extend a self-issued control token lifetime', async () => {
		vi.useFakeTimers();

		try {
			const issuedAt = new Date('2026-01-01T00:00:00.000Z');
			vi.setSystemTime(issuedAt);
			const presented = await issueControlAdminToken('global-admin');
			const parent = decodeJwt(presented);

			vi.setSystemTime(new Date(issuedAt.getTime() + 9 * 60 * 1000));
			const response = await postToken({
				grant_type: tokenExchangeGrantType,
				subject_token: presented,
				subject_token_type: issuedAccessTokenType
			});
			const body = tokenResponseSchema.parse(await response.json());
			const child = decodeJwt(body.access_token);

			expect({
				status: response.status,
				expiresIn: body.expires_in,
				parentExpiresAt: parent.exp,
				childExpiresAt: child.exp
			}).toStrictEqual({
				status: StatusCodes.OK,
				expiresIn: 60,
				parentExpiresAt: parent.exp,
				childExpiresAt: parent.exp
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not relabel an external access JWT as an ID token', async () => {
		const { token: subjectToken } = await trustedControlIdentity('at+jwt');
		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});
		const body = oauthErrorShape(await response.json());

		expect({
			status: response.status,
			error: body.error,
			problem: body.problem
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_request',
			problem: 'subject-token-invalid'
		});
	});

	it('uses requested authority to distinguish tied control rules', async () => {
		const acmeGrant: PermittedGrant = {
			type: 'cupboard_tenant',
			actions: ['tenant:suspend'],
			resources: { tenant: { exact: 'acme', validate: 'tenant' } }
		};
		const betaGrant: PermittedGrant = {
			type: 'cupboard_tenant',
			actions: ['tenant:suspend'],
			resources: { tenant: { exact: 'beta', validate: 'tenant' } }
		};
		const identity = await trustedControlIdentity('JWT', [acmeGrant]);
		await seedControlTrust({
			issuer: identity.issuer,
			audience: identity.audience,
			claims: { sub: 'global-admin' },
			permittedGrants: [betaGrant]
		});
		const requested = [
			{ type: 'cupboard_tenant', actions: ['tenant:suspend'], tenant: 'beta' }
		];

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: identity.token,
			subject_token_type: subjectTokenTypeIdToken,
			authorization_details: JSON.stringify(requested)
		});
		const body = tokenResponseSchema.parse(await response.json());
		const claims = decodeJwt(body.access_token);

		expect({
			status: response.status,
			granted: body.authorization_details,
			tokenGrants: claims.authorization_details
		}).toStrictEqual({
			status: StatusCodes.OK,
			granted: requested,
			tokenGrants: requested
		});
	});

	it('composes control actions and resources without implicit authority expansion', async () => {
		const identity = await trustedControlIdentity('JWT', [
			{
				type: 'cupboard_tenant',
				actions: ['tenant:suspend'],
				resources: { tenant: { exact: 'acme', validate: 'tenant' } }
			}
		]);
		await seedControlTrust({
			issuer: identity.issuer,
			audience: identity.audience,
			claims: { sub: 'global-admin' },
			permittedGrants: [
				{
					type: 'cupboard_tenant',
					actions: ['tenant:resume'],
					resources: { tenant: { exact: 'acme', validate: 'tenant' } }
				},
				{
					type: 'cupboard_tenant',
					actions: ['tenant:suspend'],
					resources: { tenant: { exact: 'beta', validate: 'tenant' } }
				}
			]
		});
		const requested = [
			{
				type: 'cupboard_tenant',
				actions: ['tenant:suspend', 'tenant:resume'],
				tenant: 'acme'
			},
			{ type: 'cupboard_tenant', actions: ['tenant:suspend'], tenant: 'beta' }
		];
		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: identity.token,
			subject_token_type: subjectTokenTypeIdToken,
			authorization_details: JSON.stringify(requested)
		});
		expect(response.status).toBe(StatusCodes.OK);
		const result = tokenResponseSchema.parse(await response.json());
		const claims = decodeJwt(result.access_token);
		const rows = await controlRefreshRows();
		expect({
			grants: result.authorization_details,
			tokenGrants: claims.authorization_details,
			refresh: typeof result.refresh_token,
			rule: claims.cb_rule,
			rules: claims.cb_rules,
			families: rows.families.map((family) => ({
				subject: family.subject,
				rule: family.rule ?? undefined
			}))
		}).toStrictEqual({
			grants: requested,
			tokenGrants: requested,
			refresh: 'string',
			rule: undefined,
			rules: undefined,
			families: [{ subject: 'global-admin', rule: undefined }]
		});
	});

	it.each([
		{
			name: "accepts an extra audience configured for the token's issuer",
			otherIssuer: false,
			accepted: true
		},
		{
			name: 'refuses an extra audience configured for another issuer',
			otherIssuer: true,
			accepted: false
		}
	])('$name', async ({ otherIssuer, accepted }) => {
		const identity = await trustedControlIdentity('JWT', undefined, [
			'cupboard-control-2'
		]);
		await seedControlTrust({
			issuer: otherIssuer
				? `https://idp-${crypto.randomUUID()}.example.test`
				: identity.issuer,
			audience: 'cupboard-control-2',
			claims: { sub: 'someone-else' }
		});

		const outcome = await tokenExchangeError({
			grant_type: tokenExchangeGrantType,
			subject_token: identity.token,
			subject_token_type: subjectTokenTypeIdToken
		});

		expect({
			exchanged: outcome instanceof Response && outcome.ok,
			refused: outcome instanceof SubjectTokenVerificationFailedError
		}).toStrictEqual({ exchanged: accepted, refused: !accepted });
	});

	it('retries one issuer fetch failure and completes the exchange', async () => {
		const { token: subjectToken } = await trustedControlIdentity('JWT');
		const served = fetch;
		let remainingFailures = 1;
		vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
			if (remainingFailures > 0) {
				remainingFailures -= 1;

				return Promise.reject(new Error('issuer fetch blip'));
			}

			return served(input, init);
		});

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});
		await response.text();

		expect(response.status).toBe(StatusCodes.OK);
	});

	it('reports 503, not invalid_grant, when the matched issuer is unavailable', async () => {
		const issuer = currentOrigin();

		await seedControlTrust({
			issuer,
			audience: 'cupboard-control',
			claims: { sub: 'global-admin' }
		});
		const subjectToken = await signedToken({
			issuer,
			audience: 'cupboard-control',
			subject: 'global-admin'
		});
		vi.stubGlobal('fetch', () =>
			Promise.reject(new Error('issuer is unavailable'))
		);

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});
		await response.text();

		expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
	});

	it.each(['first', 'second'] as const)(
		'refuses composed control authority after %s rule removal',
		async (removed) => {
			const identity = await trustedControlIdentity('JWT', [
				{
					type: 'cupboard_tenant',
					actions: ['tenant:suspend'],
					resources: { tenant: { exact: 'acme', validate: 'tenant' } }
				}
			]);
			const additional = await seedControlTrust({
				issuer: identity.issuer,
				audience: identity.audience,
				claims: { sub: 'global-admin' },
				permittedGrants: [
					{
						type: 'cupboard_tenant',
						actions: ['tenant:suspend'],
						resources: { tenant: { exact: 'beta', validate: 'tenant' } }
					}
				]
			});
			const served = fetch;
			const started = Promise.withResolvers<undefined>();
			const release = Promise.withResolvers<undefined>();
			vi.stubGlobal(
				'fetch',
				async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = input instanceof Request ? input.url : String(input);
					if (url === `${identity.issuer}/.well-known/openid-configuration`) {
						started.resolve(undefined);
						await release.promise;
					}
					return served(input, init);
				}
			);
			const exchange = tokenExchangeError({
				grant_type: tokenExchangeGrantType,
				subject_token: identity.token,
				subject_token_type: subjectTokenTypeIdToken,
				authorization_details: JSON.stringify([
					{
						type: 'cupboard_tenant',
						actions: ['tenant:suspend'],
						tenant: 'acme'
					},
					{
						type: 'cupboard_tenant',
						actions: ['tenant:suspend'],
						tenant: 'beta'
					}
				])
			});
			await started.promise;
			try {
				await controlOidcTrustRemove(
					Object.assign({}, env, testControlEnv),
					removed === 'first' ? identity.rule : additional
				);
			} finally {
				release.resolve(undefined);
			}
			expect(await exchange).toBeInstanceOf(ControlSubjectTokenUntrustedError);
		}
	);

	it('refuses an exchange when its control trust rule is removed during verification', async () => {
		const issuer = `https://idp-${crypto.randomUUID()}.example.test`;
		const audience = 'cupboard-control';
		const { publicKey, privateKey } = await generateKeyPair('RS256', {
			extractable: true
		});
		const publicJwk = await exportJWK(publicKey);
		const ruleId = await seedControlTrust({
			issuer,
			audience,
			claims: { sub: 'global-admin' }
		});
		const { promise: discoveryHeld, resolve: releaseDiscovery } =
			Promise.withResolvers<undefined>();
		const { promise: discoveryRequested, resolve: discoveryStarted } =
			Promise.withResolvers<undefined>();

		vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : String(input);

			if (url === `${issuer}/.well-known/openid-configuration`) {
				discoveryStarted(undefined);
				await discoveryHeld;

				return Response.json({
					issuer,
					jwks_uri: `${issuer}/jwks`,
					id_token_signing_alg_values_supported: ['RS256']
				});
			}

			if (url === `${issuer}/jwks`) {
				return Response.json({
					keys: [{ ...publicJwk, kid: 'idp', alg: 'RS256', use: 'sig' }]
				});
			}

			return new Response(undefined, { status: StatusCodes.NOT_FOUND });
		});

		const subjectToken = await new SignJWT({})
			.setProtectedHeader({ alg: 'RS256', kid: 'idp', typ: 'JWT' })
			.setIssuer(issuer)
			.setAudience(audience)
			.setSubject('global-admin')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(privateKey);
		const exchange = tokenExchangeError({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});

		await discoveryRequested;
		await controlOidcTrustRemove(
			Object.assign({}, env, testControlEnv),
			ruleId
		);
		releaseDiscovery(undefined);
		const refused = await exchange;

		expect({
			isUntrusted: refused instanceof ControlSubjectTokenUntrustedError,
			rows: await controlRefreshRows()
		}).toStrictEqual({
			isUntrusted: true,
			rows: { families: [], members: [] }
		});
	});

	it('refuses an existing loopback HTTP control trust row in production', async () => {
		await seedControlTrust({
			issuer: 'http://127.0.0.1:8788',
			audience: 'cupboard-control',
			claims: { sub: 'global-admin' }
		});
		const subjectToken = await signedToken({
			issuer: 'http://127.0.0.1:8788',
			audience: 'cupboard-control',
			subject: 'global-admin'
		});

		const error = await tokenExchangeError({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});

		expect(error).toBeInstanceOf(StoredControlTrustInvalidError);
	});

	it.each<{ name: string; override: Readonly<Record<string, string>> }>([
		{ name: 'the wrapping secret', override: { CONTROL_KEY_WRAP_SECRET: '' } },
		{ name: 'the audience', override: { CUPBOARD_CONTROL_AUDIENCE: '' } }
	])('reports 500 when $name is not configured', async ({ override }) => {
		const response = await postToken(
			{
				grant_type: tokenExchangeGrantType,
				subject_token: 'x',
				subject_token_type: subjectTokenTypeIdToken
			},
			override
		);
		await response.text();

		expect(response.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
	});

	it('refuses token exchange when a control trust rule does not pin a subject', async () => {
		await seedControlTrust({
			issuer: 'https://idp.example.test',
			audience: 'cupboard-control'
		});
		const subjectToken = await signedToken({
			issuer: 'https://idp.example.test',
			audience: 'cupboard-control'
		});

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});
		await response.text();

		expect(response.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
	});

	it('reports 500 for authorization-server metadata when the control audience is unset', async () => {
		const response = await controlFetch(
			'/.well-known/oauth-authorization-server',
			undefined,
			{ CUPBOARD_CONTROL_AUDIENCE: '' }
		);
		await response.text();

		expect(response.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
	});

	it('publishes the control JWKS with no-cache', async () => {
		const response = await controlFetch('/.well-known/jwks.json');
		const body = jwksResponseSchema.parse(await response.json());
		const [key] = body.keys;

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			keys: [
				{
					kty: key.kty,
					crv: key.crv,
					alg: key.alg,
					use: key.use,
					kid: key.kid,
					x: key.x,
					ext: key.ext,
					key_ops: key.key_ops
				}
			]
		}).toStrictEqual({
			status: StatusCodes.OK,
			cacheControl: 'no-cache',
			keys: [
				{
					kty: 'OKP',
					crv: 'Ed25519',
					alg: 'EdDSA',
					use: 'sig',
					kid: key.kid,
					x: key.x,
					ext: true,
					key_ops: ['verify']
				}
			]
		});
	});

	it('serves control authorization-server metadata at the bare host', async () => {
		const response = await controlFetch(
			'/.well-known/oauth-authorization-server'
		);
		const origin = currentOrigin();
		const body = authorizationServerMetadataSchema.parse(await response.json());

		expect({ status: response.status, body }).toStrictEqual({
			status: StatusCodes.OK,
			body: {
				issuer: origin,
				token_endpoint: `${origin}/token`,
				jwks_uri: `${origin}/.well-known/jwks.json`,
				response_types_supported: [],
				grant_types_supported: [tokenExchangeGrantType, refreshTokenGrantType],
				authorization_details_types_supported: [
					'cupboard_tenant',
					'cupboard_control',
					'cupboard_wildcard'
				],
				token_endpoint_auth_methods_supported: ['none'],
				revocation_endpoint: `${origin}/revoke`,
				revocation_endpoint_auth_methods_supported: ['none']
			}
		});
	});
});

describe('control plane refresh sessions', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('issues a session with an ID token exchange and rotates it', async () => {
		const identity = await trustedControlIdentity('JWT');
		const exchanged = await exchangeControlIdentity(identity);
		const issued = await controlRefreshRows();
		const response = await refreshControl(exchanged.refresh_token ?? '');
		const refreshed = tokenResponseSchema.parse(await response.json());
		const claims = decodeJwt(refreshed.access_token);
		const rotated = await controlRefreshRows();
		const [family] = issued.families;

		if (family === undefined) {
			throw new Error('Expected a control refresh family');
		}

		expect({
			issued: issued.families,
			lifetimeDays:
				(Date.parse(family.expiresAt) - Date.parse(family.createdAt)) /
				(24 * 60 * 60 * 1000),
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			expiresIn: refreshed.expires_in,
			grants: refreshed.authorization_details,
			claims: {
				iss: claims.iss,
				aud: claims.aud,
				sub: claims.sub,
				rule: claims.cb_rule
			},
			families: rotated.families,
			memberGenerations: rotated.members.map((member) => member.generation)
		}).toStrictEqual({
			issued: [
				{
					id: family.id,
					activeMemberId: memberIdOf(exchanged.refresh_token),
					generation: 0,
					createdAt: family.createdAt,
					expiresAt: family.expiresAt,
					issuer: identity.issuer,
					subject: 'global-admin',
					rule: identity.rule
				}
			],
			lifetimeDays: 30,
			status: StatusCodes.OK,
			cacheControl: 'no-store',
			expiresIn: 600,
			grants: [{ type: 'cupboard_wildcard' }],
			claims: {
				iss: currentOrigin(),
				aud: testControlEnv.CUPBOARD_CONTROL_AUDIENCE,
				sub: 'global-admin',
				rule: identity.rule
			},
			families: [
				{
					...family,
					activeMemberId: memberIdOf(refreshed.refresh_token),
					generation: 1
				}
			],
			memberGenerations: [0, 1]
		});
	});

	it.each([
		{ name: 'the deployment URL', audience: () => currentOrigin() },
		{
			name: 'the deployment URL with a trailing slash',
			audience: () => `${currentOrigin()}/`
		}
	])(
		'starts no session for a token whose audience is $name',
		async ({ audience }) => {
			const exchanged = await exchangeControlIdentity(
				await trustedControlIdentity('JWT', undefined, [], audience())
			);

			expect({
				refreshToken: exchanged.refresh_token,
				rows: await controlRefreshRows()
			}).toStrictEqual({
				refreshToken: undefined,
				rows: { families: [], members: [] }
			});
		}
	);

	it('returns the same successor to a retry within the grace period', async () => {
		const exchanged = await exchangeControlIdentity(
			await trustedControlIdentity('JWT')
		);
		const original = exchanged.refresh_token ?? '';
		const first = await refreshedControl(original);
		const retry = await refreshedControl(original);
		const rows = await controlRefreshRows();

		expect({
			sameSuccessor: retry.refresh_token === first.refresh_token,
			generations: rows.families.map((family) => family.generation),
			memberGenerations: rows.members.map((member) => member.generation)
		}).toStrictEqual({
			sameSuccessor: true,
			generations: [1],
			memberGenerations: [0, 1]
		});
	});

	it('returns one successor to concurrent presentations of a refresh token', async () => {
		const exchanged = await exchangeControlIdentity(
			await trustedControlIdentity('JWT')
		);
		const original = exchanged.refresh_token ?? '';
		const responses = await Promise.all([
			refreshControl(original),
			refreshControl(original)
		]);
		const [first, second] = await Promise.all(
			responses.map(async (response) =>
				tokenResponseSchema.parse(await response.json())
			)
		);
		const rows = await controlRefreshRows();

		expect({
			statuses: responses.map((response) => response.status),
			sameSuccessor: first?.refresh_token === second?.refresh_token,
			families: rows.families.map((family) => ({
				activeMemberId: family.activeMemberId,
				generation: family.generation
			})),
			memberGenerations: rows.members.map((member) => member.generation)
		}).toStrictEqual({
			statuses: [StatusCodes.OK, StatusCodes.OK],
			sameSuccessor: true,
			families: [
				{ activeMemberId: memberIdOf(first?.refresh_token), generation: 1 }
			],
			memberGenerations: [0, 1]
		});
	});

	it('revokes the session when an earlier generation is replayed', async () => {
		const exchanged = await exchangeControlIdentity(
			await trustedControlIdentity('JWT')
		);
		const original = exchanged.refresh_token ?? '';
		const second = await refreshedControl(original);
		const third = await refreshedControl(second.refresh_token ?? '');
		const replay = await refusalOf(await refreshControl(original));
		const current = await refusalOf(
			await refreshControl(third.refresh_token ?? '')
		);

		expect({
			replay,
			current,
			rows: await controlRefreshRows()
		}).toStrictEqual({
			replay: staleRefresh,
			current: staleRefresh,
			rows: { families: [], members: [] }
		});
	});

	it('revokes the session when its control trust rule is removed', async () => {
		const identity = await trustedControlIdentity('JWT');
		const exchanged = await exchangeControlIdentity(identity);
		await controlOidcTrustRemove(
			Object.assign({}, env, testControlEnv),
			identity.rule
		);

		expect({
			refusal: await refusalOf(
				await refreshControl(exchanged.refresh_token ?? '')
			),
			rows: await controlRefreshRows()
		}).toStrictEqual({
			refusal: staleRefresh,
			rows: { families: [], members: [] }
		});
	});

	it('ends a session at its expiry', async () => {
		const exchanged = await exchangeControlIdentity(
			await trustedControlIdentity('JWT')
		);
		const expired = isoTimestamp(new Date(Date.now() - 1000));
		await env.CUPBOARD_DB.prepare(
			'UPDATE control_refresh_session_family SET expires_at = ?'
		)
			.bind(expired)
			.run();

		expect({
			refusal: await refusalOf(
				await refreshControl(exchanged.refresh_token ?? '')
			),
			rows: await controlRefreshRows()
		}).toStrictEqual({
			refusal: staleRefresh,
			rows: { families: [], members: [] }
		});
	});

	it('ends a session when its refresh-token family reaches the member limit', async () => {
		const exchanged = await exchangeControlIdentity(
			await trustedControlIdentity('JWT')
		);
		const original = exchanged.refresh_token ?? '';
		const issued = await controlRefreshRows();
		const [member] = issued.members;
		const credential = RefreshCredential.parse(original);
		const authority =
			member === undefined
				? undefined
				: await credential?.authenticate(
						member.credentialHash,
						controlRefreshKeys
					);

		if (member === undefined || authority === undefined) {
			throw new Error('Expected an authenticated control refresh member');
		}

		const activeGeneration = maxRefreshTokenFamilyMembers - 2;
		const nearBound = await RefreshCredential.issue(
			{
				...authority,
				identity: refreshPolicyIdentity(authority.identity),
				generation: activeGeneration
			},
			controlRefreshKeys
		);
		await env.CUPBOARD_DB.batch([
			env.CUPBOARD_DB.prepare(
				'UPDATE control_refresh_session_family SET generation = ?'
			).bind(activeGeneration),
			env.CUPBOARD_DB.prepare(
				'UPDATE control_refresh_session_member SET generation = ?, credential_hash = ?'
			).bind(activeGeneration, await sha256Hex(nearBound.value))
		]);
		const lastAllowed = await refreshControl(nearBound.value);
		const lastAllowedBody = tokenResponseSchema.parse(await lastAllowed.json());
		const atBound = await controlRefreshRows();
		const beyondBound = await refusalOf(
			await refreshControl(lastAllowedBody.refresh_token ?? '')
		);

		expect({
			lastAllowed: lastAllowed.status,
			atBound: atBound.families.map((family) => family.generation),
			beyondBound,
			rows: await controlRefreshRows()
		}).toStrictEqual({
			lastAllowed: StatusCodes.OK,
			atBound: [maxRefreshTokenFamilyMembers - 1],
			beyondBound: staleRefresh,
			rows: { families: [], members: [] }
		});
	});

	// The stored member matches the credential's hash in both cases, so only
	// the credential's binding decides the outcome.
	it.each([
		{
			name: 'refuses a tenant credential',
			keys: {
				kind: 'tenant',
				signingKey: pushIdSigningKeySchema.parse(
					testControlEnv.CONTROL_KEY_WRAP_SECRET
				),
				tenant: tenantIdSchema.parse('acme')
			} satisfies RefreshKeyContext,
			status: StatusCodes.BAD_REQUEST
		},
		{
			name: 'accepts a control credential',
			keys: controlRefreshKeys,
			status: StatusCodes.OK
		}
	])(
		'$name presented against a stored control member',
		async ({ keys, status }) => {
			const identity = await trustedControlIdentity('JWT');
			const familyId = crypto.randomUUID();
			const memberId = crypto.randomUUID();
			const createdAt = isoTimestamp(new Date());
			const expiresAt = isoTimestamp(new Date(Date.now() + 60 * 60 * 1000));
			const credential = await RefreshCredential.issue(
				{
					familyId,
					memberId,
					generation: 0,
					expiresAt,
					identity: {
						iss: identity.issuer,
						sub: 'global-admin',
						aud: identity.audience
					},
					grants: [{ type: 'cupboard_wildcard' }]
				},
				keys
			);
			const database = controlDatabase();
			await database.batch([
				database.insert(d1Schema.controlRefreshSessionFamily).values({
					id: familyId,
					activeMemberId: memberId,
					generation: 0,
					createdAt,
					expiresAt,
					issuer: oidcIssuerSchema.parse(identity.issuer),
					subject: oidcSubjectSchema.parse('global-admin')
				}),
				database.insert(d1Schema.controlRefreshSessionMember).values({
					id: memberId,
					familyId,
					generation: 0,
					credentialHash: await sha256Hex(credential.value),
					createdAt
				})
			]);
			const response = await refreshControl(credential.value);
			await response.text();

			expect(response.status).toBe(status);
		}
	);
});

describe('control plane token revocation', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('revokes the session of a refresh token', async () => {
		const exchanged = await exchangeControlIdentity(
			await trustedControlIdentity('JWT')
		);
		const refreshToken = exchanged.refresh_token ?? '';
		const outcome = await revocationOutcome({
			token: refreshToken,
			token_type_hint: 'refresh_token'
		});

		expect({
			outcome,
			renewal: await refusalOf(await refreshControl(refreshToken)),
			rows: await controlRefreshRows()
		}).toStrictEqual({
			outcome: emptyRevocation,
			renewal: staleRefresh,
			rows: { families: [], members: [] }
		});
	});

	it.each([
		{
			name: 'an unknown refresh credential',
			token: () => `${crypto.randomUUID()}.${'a'.repeat(64)}.e30.e30`
		},
		{
			name: 'a refresh credential with a forged secret',
			token: (live: string) =>
				live.replace(/\.[\da-f]{64}\./u, () => `.${'0'.repeat(64)}.`)
		},
		{ name: 'an opaque string', token: () => 'not-a-token' }
	])(
		'returns the same empty response for $name and keeps the session',
		async ({ token }) => {
			const exchanged = await exchangeControlIdentity(
				await trustedControlIdentity('JWT')
			);
			const before = await controlRefreshRows();
			const outcome = await revocationOutcome({
				token: token(exchanged.refresh_token ?? '')
			});

			expect({ outcome, rows: await controlRefreshRows() }).toStrictEqual({
				outcome: emptyRevocation,
				rows: before
			});
		}
	);

	it('refuses to revoke a control access token', async () => {
		const exchanged = await exchangeControlIdentity(
			await trustedControlIdentity('JWT')
		);
		const before = await controlRefreshRows();
		const response = await postRevoke({ token: exchanged.access_token });
		const cacheControl = response.headers.get('cache-control');

		expect({
			refusal: await refusalOf(response),
			cacheControl,
			rows: await controlRefreshRows()
		}).toStrictEqual({
			refusal: {
				status: StatusCodes.BAD_REQUEST,
				error: 'unsupported_token_type',
				problem: undefined
			},
			cacheControl: 'no-store',
			rows: before
		});
	});
});

// Inserts a family with `members` members. With `successorExpiresAt`, every
// member also has a successor envelope that expires then.
async function insertControlRefreshFamily(
	id: string,
	expiresAt: Date,
	members: number,
	successorExpiresAt?: Date
): Promise<void> {
	const createdAt = isoTimestamp(new Date(expiresAt.getTime() - 1000));
	const memberRows = `WITH RECURSIVE generations(value) AS (
	   SELECT 0 UNION ALL SELECT value + 1 FROM generations WHERE value + 1 < ?
	 )
	 INSERT INTO control_refresh_session_member (id, family_id, generation, credential_hash, created_at)
	 SELECT ? || '-' || value, ?, value, 'hash', ? FROM generations`;

	await env.CUPBOARD_DB.batch([
		env.CUPBOARD_DB.prepare(
			"INSERT INTO control_refresh_session_family (id, active_member_id, generation, created_at, expires_at, issuer, subject) VALUES (?, ? || '-0', ?, ?, ?, 'https://idp.example.test', 'global-admin')"
		).bind(id, id, members - 1, createdAt, isoTimestamp(expiresAt)),
		env.CUPBOARD_DB.prepare(memberRows).bind(members, id, id, createdAt)
	]);

	if (successorExpiresAt !== undefined) {
		await env.CUPBOARD_DB.prepare(
			"UPDATE control_refresh_session_member SET successor_envelope = 'envelope', successor_expires_at = ? WHERE family_id = ?"
		)
			.bind(isoTimestamp(successorExpiresAt), id)
			.run();
	}
}

describe('control refresh session pruning', () => {
	beforeEach(resetTestServer);

	it('deletes expired sessions a page at a time and clears expired successor envelopes', async () => {
		const now = new Date();
		await insertControlRefreshFamily(
			'expired',
			new Date(now.getTime() - 1000),
			controlRefreshPrunePageSize + 1
		);
		await insertControlRefreshFamily(
			'live',
			new Date(now.getTime() + 60 * 60 * 1000),
			1,
			new Date(now.getTime() - 1000)
		);
		const first = await pruneControlRefreshSessions(
			controlDatabase(),
			isoTimestamp(now)
		);
		const afterFirst = await controlRefreshRows();
		const second = await pruneControlRefreshSessions(
			controlDatabase(),
			isoTimestamp(now)
		);
		const afterSecond = await controlRefreshRows();

		expect({
			first,
			afterFirst: {
				families: afterFirst.families.map((family) => family.id),
				members: afterFirst.members.length
			},
			second,
			afterSecond: {
				families: afterSecond.families.map((family) => family.id),
				members: afterSecond.members.map((member) => ({
					id: member.id,
					successorEnvelope: member.successorEnvelope ?? undefined,
					successorExpiresAt: member.successorExpiresAt ?? undefined
				}))
			}
		}).toStrictEqual({
			first: {
				membersDeleted: controlRefreshPrunePageSize,
				familiesDeleted: 0
			},
			afterFirst: { families: ['expired', 'live'], members: 2 },
			second: { membersDeleted: 1, familiesDeleted: 1 },
			afterSecond: {
				families: ['live'],
				members: [
					{
						id: 'live-0',
						successorEnvelope: undefined,
						successorExpiresAt: undefined
					}
				]
			}
		});
	});
});

interface BoundControlIdentity {
	readonly identity: TrustedControlIdentity;
	readonly nonce: string;
	readonly binding: Readonly<Record<string, string>>;
}

async function boundControlIdentity(
	targets: readonly string[],
	options: {
		readonly hasNonce?: boolean;
		readonly issuedAt?: number;
		readonly audience?: string;
	} = {}
): Promise<BoundControlIdentity> {
	const seed = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	const nonce = await subjectBindingNonce(targets, seed);
	const identity = await trustedControlIdentity(
		'JWT',
		undefined,
		[],
		options.audience,
		{
			...(options.hasNonce !== false && { claims: { nonce } }),
			...(options.issuedAt !== undefined && { issuedAt: options.issuedAt })
		}
	);

	return {
		identity,
		nonce,
		binding: {
			cupboard_binding_seed: seed,
			cupboard_binding_targets: JSON.stringify(targets)
		}
	};
}

function boundControlExchange(bound: BoundControlIdentity): Promise<Response> {
	return postToken({
		grant_type: tokenExchangeGrantType,
		subject_token: bound.identity.token,
		subject_token_type: subjectTokenTypeIdToken,
		...bound.binding
	});
}

async function consumedControlNonces(): Promise<
	{ nonce: string; familyId: string | undefined; expiresAt: string }[]
> {
	const rows = await controlDatabase()
		.select()
		.from(d1Schema.controlConsumedSubjectNonce)
		.orderBy(asc(d1Schema.controlConsumedSubjectNonce.nonce))
		.all();

	return rows.map((row) => ({ ...row, familyId: row.familyId ?? undefined }));
}

const nonceConsumedAt = new Date('2026-01-01T00:00:00.000Z');
const nonceRetainedUntil = new Date(
	nonceConsumedAt.getTime() + consumedSubjectNonceRetentionSeconds * 1000
).toISOString();

function unboundExchangeWarnings(
	logs: readonly CapturedLog[]
): { level: string; rule: unknown }[] {
	return logs
		.filter((entry) => entry.message === 'unbound subject token accepted')
		.map((entry) => ({ level: entry.level, rule: entry.properties.rule }));
}

describe('control plane target-bound subject tokens', () => {
	beforeEach(async () => {
		vi.useFakeTimers({ now: nonceConsumedAt, toFake: ['Date'] });
		await resetTestServer();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('exchanges a nonce-bound token and records its nonce with the session', async () => {
		const bound = await boundControlIdentity([
			currentOrigin(),
			`${currentOrigin()}/t/acme`
		]);
		const response = await boundControlExchange(bound);
		const body = tokenResponseSchema.parse(await response.json());
		const { families } = await controlRefreshRows();

		expect({
			status: response.status,
			refreshToken: typeof body.refresh_token,
			consumed: await consumedControlNonces()
		}).toStrictEqual({
			status: StatusCodes.OK,
			refreshToken: 'string',
			consumed: [
				{
					nonce: bound.nonce,
					familyId: families[0]?.id,
					expiresAt: nonceRetainedUntil
				}
			]
		});
	});

	it('records the nonce of an audience-bound exchange that starts no session', async () => {
		const bound = await boundControlIdentity([currentOrigin()], {
			audience: currentOrigin()
		});
		const response = await boundControlExchange(bound);
		const body = tokenResponseSchema.parse(await response.json());

		expect({
			status: response.status,
			refreshToken: body.refresh_token,
			consumed: await consumedControlNonces()
		}).toStrictEqual({
			status: StatusCodes.OK,
			refreshToken: undefined,
			consumed: [
				{
					nonce: bound.nonce,
					familyId: undefined,
					expiresAt: nonceRetainedUntil
				}
			]
		});
	});

	it('refuses a second exchange of the same nonce-bound token', async () => {
		const bound = await boundControlIdentity([currentOrigin()]);
		const first = await boundControlExchange(bound);
		const issued = await controlRefreshRows();
		const replay = await boundControlExchange(bound);
		const consumed = await consumedControlNonces();

		expect({
			first: first.status,
			replay: await refusalOf(replay),
			rows: await controlRefreshRows(),
			consumed: consumed.map(({ nonce }) => nonce)
		}).toStrictEqual({
			first: StatusCodes.OK,
			replay: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'subject-token-replayed'
			},
			rows: issued,
			consumed: [bound.nonce]
		});
	});

	it.each([
		{
			name: "a token bound to another deployment's URL",
			targets: () => ['https://elsewhere.example.test'],
			hasNonce: true
		},
		{
			name: 'a target that is not in canonical form',
			targets: () => [`${currentOrigin()}/`],
			hasNonce: true
		},
		{
			name: 'a token without a nonce claim',
			targets: () => [currentOrigin()],
			hasNonce: false
		}
	])('refuses $name', async ({ targets, hasNonce }) => {
		const bound = await boundControlIdentity(targets(), { hasNonce });
		const response = await boundControlExchange(bound);

		expect({
			refusal: await refusalOf(response),
			rows: await controlRefreshRows(),
			consumed: await consumedControlNonces()
		}).toStrictEqual({
			refusal: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'subject-token-unbound'
			},
			rows: { families: [], members: [] },
			consumed: []
		});
	});

	it('refuses a nonce-bound token issued more than five minutes ago', async () => {
		const bound = await boundControlIdentity([currentOrigin()], {
			issuedAt: Math.floor(Date.now() / 1000) - 6 * 60
		});
		const response = await boundControlExchange(bound);

		expect({
			refusal: await refusalOf(response),
			consumed: await consumedControlNonces()
		}).toStrictEqual({
			refusal: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'subject-token-too-old'
			},
			consumed: []
		});
	});

	it.each([
		{ name: 'an unbound exchange and logs its rule', isAudienceBound: false },
		{
			name: 'an audience-bound exchange without a warning',
			isAudienceBound: true
		}
	])('accepts $name', async ({ isAudienceBound }) => {
		const identity = await trustedControlIdentity(
			'JWT',
			undefined,
			[],
			isAudienceBound ? currentOrigin() : undefined
		);
		const capture = startCapture();
		let response: Response;

		try {
			response = await postToken({
				grant_type: tokenExchangeGrantType,
				subject_token: identity.token,
				subject_token_type: subjectTokenTypeIdToken
			});
		} finally {
			capture.stop();
		}

		expect({
			status: response.status,
			warnings: unboundExchangeWarnings(capture.logs),
			consumed: await consumedControlNonces()
		}).toStrictEqual({
			status: StatusCodes.OK,
			warnings: isAudienceBound
				? []
				: [{ level: 'warning', rule: identity.rule }],
			consumed: []
		});
	});
});
