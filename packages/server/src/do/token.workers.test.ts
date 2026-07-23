import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	issuedAccessTokenType,
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema,
	refreshTokenGrantType,
	subjectTokenTypeIdToken,
	subjectTokenTypeJwt,
	tokenExchangeGrantType,
	type TokenResponse,
	tokenResponseSchema,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { oidcTrust, refreshTokens } from '../db/schema.ts';
import {
	OwnerConfigurationInvalidError,
	RefreshTokenRequiredError,
	StaleRefreshTokenError,
	SubjectTokenNotJwtError,
	SubjectTokenRequiredError,
	TenantSubjectTokenUntrustedError,
	UnsupportedGrantTypeError,
	UnsupportedSubjectTokenTypeError
} from '../errors.ts';
import {
	currentOrigin,
	currentServer,
	fetchPath,
	latestMigrationIndex,
	migrateThrough,
	readFetch,
	resetTestServer
} from '../test-support.ts';

import { AuthKeysService } from './auth-keys-service.ts';
import { OidcTrustService } from './oidc-trust-service.ts';
import { TenantIdentityService } from './tenant-identity-service.ts';
import { TokenExchangeService } from './token-exchange-service.ts';

const oauthErrorSchema = z.strictObject({
	error: z.string(),
	error_description: z.string().min(1),
	problem: z.string().optional(),
	detail: z.record(z.string(), z.string()).optional()
});

function oauthErrorShape(value: unknown): z.infer<typeof oauthErrorSchema> {
	return oauthErrorSchema.parse(value);
}

const jwksKeySchema = z.strictObject({
	kty: z.string(),
	crv: z.string(),
	alg: z.string(),
	use: z.string(),
	kid: z.string(),
	x: z.string(),
	ext: z.boolean(),
	key_ops: z.tuple([z.string()])
});

const jwksResponseSchema = z.strictObject({
	keys: z.tuple([jwksKeySchema])
});

const authorizationServerMetadataSchema = z.strictObject({
	issuer: z.string(),
	token_endpoint: z.string(),
	jwks_uri: z.string(),
	grant_types_supported: z.array(z.string()),
	authorization_details_types_supported: z.array(z.string()),
	token_endpoint_auth_methods_supported: z.array(z.string())
});

function postToken(form: Record<string, string>): Promise<Response> {
	const body = new URLSearchParams(form);

	return fetchPath('/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
}

// A real, well-formed inbound token whose issuer matches no trust rule, so
// matching fails before any JWKS fetch; the verification network is never
// touched in these tests.
async function untrustedToken(): Promise<string> {
	const { privateKey } = await generateKeyPair('RS256', { extractable: true });
	const signer = new SignJWT({});

	return signer
		.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
		.setIssuer('https://evil.example.com')
		.setAudience('cupboard')
		.setSubject('mallory')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(privateKey);
}

function tokenExchangeError(body: Record<string, string>): Promise<unknown> {
	return runInDurableObject(currentServer(), async (instance) => {
		const tenantIdentity = new TenantIdentityService(instance.context);
		const service = new TokenExchangeService(
			instance.context,
			new AuthKeysService(instance.context, tenantIdentity),
			new OidcTrustService(instance.context, tenantIdentity)
		);

		const url = new URL('/token', currentOrigin());
		const parameters = new URLSearchParams(body);
		const request = new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: parameters.toString()
		});

		try {
			return await service.handleToken(request);
		} catch (error: unknown) {
			return error;
		}
	});
}

describe('POST /token', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.unstubAllGlobals();
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
			error: body.error,
			problem: body.problem
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			cacheControl: 'no-store',
			error: 'invalid_request',
			problem: 'unsupported-subject-token-type'
		});
	});

	it('rejects a token exchange with no subject token', async () => {
		const error = await tokenExchangeError({
			grant_type: tokenExchangeGrantType,
			subject_token_type: subjectTokenTypeJwt
		});

		expect(error).toBeInstanceOf(SubjectTokenRequiredError);
	});

	it.each([
		{
			name: 'an unsupported grant type',
			body: () => ({
				grant_type: 'authorization_code',
				subject_token: 'x',
				subject_token_type: subjectTokenTypeIdToken
			}),
			error: UnsupportedGrantTypeError
		},
		{
			name: 'an unsupported subject token type',
			body: () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: 'x',
				subject_token_type: 'unsupported'
			}),
			error: UnsupportedSubjectTokenTypeError
		},
		{
			name: 'a missing refresh token',
			body: () => ({ grant_type: refreshTokenGrantType }),
			error: RefreshTokenRequiredError
		},
		{
			name: 'a subject token that is not a JWT',
			body: () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: 'not-a-jwt',
				subject_token_type: subjectTokenTypeIdToken
			}),
			error: SubjectTokenNotJwtError
		},
		{
			name: 'a subject token matching no trust rule',
			body: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await untrustedToken(),
				subject_token_type: subjectTokenTypeJwt
			}),
			error: TenantSubjectTokenUntrustedError
		},
		{
			name: 'a malformed refresh token',
			body: () => ({
				grant_type: refreshTokenGrantType,
				refresh_token: 'nonsense'
			}),
			error: StaleRefreshTokenError
		}
	])('rejects $name', async ({ body, error }) => {
		expect(await tokenExchangeError(await body())).toBeInstanceOf(error);
	});

	it('reports 503, not invalid_grant, when the issuer cannot be reached', async () => {
		const idp = await generateKeyPair('RS256', { extractable: true });
		const signer = new SignJWT({ sub: 'ci' });
		const subjectToken = await signer
			.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
			.setIssuer('https://idp.test')
			.setAudience('cupboard-aud')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(idp.privateKey);

		await runInDurableObject(currentServer(), async (_instance, state) => {
			await migrateThrough(state, latestMigrationIndex);
			drizzle(state.storage, { schema: { oidcTrust } })
				.insert(oidcTrust)
				.values({
					id: trustRuleIdSchema.parse('ci-rule'),
					issuer: 'https://idp.test',
					audience: 'cupboard-aud',
					claimsJson: JSON.stringify({ sub: 'ci' }),
					permittedGrantsJson: JSON.stringify(trustClassGrants.write),
					createdAt: '2026-01-01T00:00:00.000Z'
				})
				.run();
		});

		vi.stubGlobal('fetch', () => Promise.reject(new Error('issuer is down')));

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});

		expect({
			status: response.status,
			retryAfter: response.headers.get('retry-after')
		}).toStrictEqual({
			status: StatusCodes.SERVICE_UNAVAILABLE,
			retryAfter: '5'
		});
	});

	it('retries an issuer fetch blip before refusing the exchange', async () => {
		const subjectToken = await installTrustedIdp('admin', {
			failFirstFetches: 1
		});

		const exchanged = await exchange(subjectToken);

		expect(exchanged.status).toBe(StatusCodes.OK);
	});
});

// Installs a trust rule for a stub issuer whose discovery and JWKS documents
// are served from memory, and returns a subject token it signed: a full,
// successful exchange without any network.
// An interactive (owner) rule permits a wildcard and may exchange without
// naming grants; a CI rule permits one cache and must request what it wants.
const trustClassGrants = {
	admin: [{ type: 'cupboard_wildcard' }],
	write: [
		{
			type: 'cupboard_cache',
			actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
			resources: { cache: { exact: 'ci', validate: 'cacheName' } }
		}
	]
} as const;

async function installTrustedIdp(
	scope: 'admin' | 'write',
	options: { failFirstFetches?: number } = {}
): Promise<string> {
	const idp = await generateKeyPair('RS256', { extractable: true });
	const jwk = await exportJWK(idp.publicKey);
	const signer = new SignJWT({});
	const subjectToken = await signer
		.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
		.setIssuer('https://idp.test')
		.setAudience('cupboard-aud')
		.setSubject('alice')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(idp.privateKey);

	let remainingFailures = options.failFirstFetches ?? 0;

	await runInDurableObject(currentServer(), async (_instance, state) => {
		await migrateThrough(state, latestMigrationIndex);
		drizzle(state.storage, { schema: { oidcTrust } })
			.insert(oidcTrust)
			.values({
				id: trustRuleIdSchema.parse(`${scope}-rule`),
				issuer: 'https://idp.test',
				audience: 'cupboard-aud',
				claimsJson: JSON.stringify({ sub: 'alice' }),
				permittedGrantsJson: JSON.stringify(trustClassGrants[scope]),
				createdAt: '2026-01-01T00:00:00.000Z'
			})
			.run();
	});

	vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
		if (remainingFailures > 0) {
			remainingFailures -= 1;

			return Promise.reject(new Error('issuer fetch blip'));
		}
		const url = input instanceof Request ? input.url : String(input);

		if (url === 'https://idp.test/.well-known/openid-configuration') {
			return Promise.resolve(
				Response.json({
					issuer: 'https://idp.test',
					jwks_uri: 'https://idp.test/jwks'
				})
			);
		}

		if (url === 'https://idp.test/jwks') {
			return Promise.resolve(
				Response.json({ keys: [{ ...jwk, kid: 'idp', alg: 'RS256' }] })
			);
		}

		return Promise.resolve(new Response('not found', { status: 404 }));
	});

	return subjectToken;
}

type SuccessfulTokenExchange = TokenResponse & { readonly status: number };

async function exchange(
	subjectToken: string,
	authorizationDetails?: unknown
): Promise<SuccessfulTokenExchange> {
	const response = await postToken({
		grant_type: tokenExchangeGrantType,
		subject_token: subjectToken,
		subject_token_type: subjectTokenTypeIdToken,
		...(authorizationDetails !== undefined && {
			authorization_details: JSON.stringify(authorizationDetails)
		})
	});
	const body = tokenResponseSchema.parse(await response.json());

	return { ...body, status: response.status };
}

// The grant a CI rule permits, as a concrete request its exchange can name.
const ciRequest = [
	{ type: 'cupboard_cache', actions: ['upload:commit'], cache: 'ci' }
];

function refreshTokenRows(): Promise<{ id: string; expiresAt: string }[]> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		drizzle(state.storage, { schema: { refreshTokens } })
			.select({ id: refreshTokens.id, expiresAt: refreshTokens.expiresAt })
			.from(refreshTokens)
			.all()
	);
}

describe('refresh grant', () => {
	beforeEach(resetTestServer);

	it('grants a rotating refresh token alongside an admin exchange', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);

		const refreshed = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: exchanged.refresh_token ?? ''
		});
		const refreshedBody = tokenResponseSchema.parse(await refreshed.json());
		const claims = decodeJwt(refreshedBody.access_token);

		const replayed = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: exchanged.refresh_token ?? ''
		});
		const replayedBody = oauthErrorShape(await replayed.json());

		expect({
			exchangeStatus: exchanged.status,
			exchangedHasRefreshToken: typeof exchanged.refresh_token,
			refreshedStatus: refreshed.status,
			refreshedCacheControl: refreshed.headers.get('cache-control'),
			refreshedGrants: refreshedBody.authorization_details,
			refreshedExpiresIn: refreshedBody.expires_in,
			refreshedHasRefreshToken: typeof refreshedBody.refresh_token,
			rotated: refreshedBody.refresh_token !== exchanged.refresh_token,
			subject: claims.sub,
			grantsClaim: claims.authorization_details,
			replayedStatus: replayed.status,
			replayedError: replayedBody.error,
			replayedProblem: replayedBody.problem
		}).toStrictEqual({
			exchangeStatus: StatusCodes.OK,
			exchangedHasRefreshToken: 'string',
			refreshedStatus: StatusCodes.OK,
			refreshedCacheControl: 'no-store',
			refreshedGrants: [{ type: 'cupboard_wildcard' }],
			refreshedExpiresIn: 600,
			refreshedHasRefreshToken: 'string',
			rotated: true,
			subject: 'alice',
			grantsClaim: [{ type: 'cupboard_wildcard' }],
			replayedStatus: StatusCodes.BAD_REQUEST,
			replayedError: 'invalid_grant',
			replayedProblem: 'stale-refresh-token'
		});
	});

	it('grants once when the same refresh token is presented concurrently', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		const refreshToken = exchanged.refresh_token ?? '';
		const present = (): Request => {
			const url = new URL('/token', currentOrigin());
			const parameters = new URLSearchParams({
				grant_type: refreshTokenGrantType,
				refresh_token: refreshToken
			});

			return new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: parameters.toString()
			});
		};

		const outcomes = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const responses = await Promise.all([
					instance.fetch(present()),
					instance.fetch(present())
				]);

				return Promise.all(
					responses.map(async (response) => {
						if (response.status === 200) {
							const body = tokenResponseSchema.parse(await response.json());
							const [refreshTokenId] = z
								.tuple([z.uuid(), z.string()])
								.parse((body.refresh_token ?? '').split('.'));

							return {
								status: response.status,
								refreshTokenId
							};
						}

						const body = oauthErrorShape(await response.json());

						return {
							status: response.status,
							error: body.error,
							problem: body.problem
						};
					})
				);
			}
		);
		const rows = await refreshTokenRows();
		const [granted, refused] = z
			.tuple([
				z.strictObject({
					status: z.literal(StatusCodes.OK),
					refreshTokenId: z.uuid()
				}),
				z.strictObject({
					status: z.literal(StatusCodes.BAD_REQUEST),
					error: z.literal('invalid_grant'),
					problem: z.literal('stale-refresh-token')
				})
			])
			.parse(outcomes.toSorted((left, right) => left.status - right.status));

		expect({
			exchangeStatus: exchanged.status,
			grantedStatus: granted.status,
			refused,
			rows: rows.map((row) => row.id)
		}).toStrictEqual({
			exchangeStatus: StatusCodes.OK,
			grantedStatus: StatusCodes.OK,
			refused: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			rows: [granted.refreshTokenId]
		});
	});

	it('issues no refresh token for a write exchange', async () => {
		const subjectToken = await installTrustedIdp('write');
		const exchanged = await exchange(subjectToken, ciRequest);

		expect({
			exchangeStatus: exchanged.status,
			refreshToken: exchanged.refresh_token,
			rows: await refreshTokenRows()
		}).toStrictEqual({
			exchangeStatus: StatusCodes.OK,
			refreshToken: undefined,
			rows: []
		});
	});

	it('rejects an expired refresh token and reclaims its row', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);

		await runInDurableObject(currentServer(), (_instance, state) => {
			drizzle(state.storage, { schema: { refreshTokens } })
				.update(refreshTokens)
				.set({ expiresAt: '2020-01-01T00:00:00.000Z' })
				.run();
		});

		const refreshed = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: exchanged.refresh_token ?? ''
		});
		const body = oauthErrorShape(await refreshed.json());

		expect({
			exchangeStatus: exchanged.status,
			status: refreshed.status,
			error: body.error,
			problem: body.problem,
			rows: await refreshTokenRows()
		}).toStrictEqual({
			exchangeStatus: StatusCodes.OK,
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_grant',
			problem: 'stale-refresh-token',
			rows: []
		});
	});

	it('ends the session when its trust rule is gone', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);

		await runInDurableObject(currentServer(), (_instance, state) => {
			drizzle(state.storage, { schema: { oidcTrust } })
				.delete(oidcTrust)
				.where(eq(oidcTrust.id, trustRuleIdSchema.parse('admin-rule')))
				.run();
		});

		const refreshed = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: exchanged.refresh_token ?? ''
		});
		const body = oauthErrorShape(await refreshed.json());

		expect({
			exchangeStatus: exchanged.status,
			status: refreshed.status,
			error: body.error,
			problem: body.problem
		}).toStrictEqual({
			exchangeStatus: StatusCodes.OK,
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_grant',
			problem: 'stale-refresh-token'
		});
	});

	it.each([
		{ name: 'a malformed refresh token', refresh_token: 'nonsense' },
		{
			name: 'a refresh token with an unknown id',
			refresh_token: `${crypto.randomUUID()}.deadbeef`
		}
	])('rejects $name as invalid_grant', async ({ refresh_token }) => {
		await installTrustedIdp('admin');

		const refreshed = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token
		});
		const body = oauthErrorShape(await refreshed.json());

		expect({
			status: refreshed.status,
			error: body.error,
			problem: body.problem
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_grant',
			problem: 'stale-refresh-token'
		});
	});

	it('rejects a refresh request missing the token as invalid_request', async () => {
		const response = await postToken({ grant_type: refreshTokenGrantType });
		const body = oauthErrorShape(await response.json());

		expect({
			status: response.status,
			error: body.error,
			problem: body.problem
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_request',
			problem: 'refresh-token-required'
		});
	});

	it('reaps expired refresh tokens in the garbage-collection sweep', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const firstExchange = await exchange(subjectToken);
		const secondExchange = await exchange(subjectToken);

		const [live] = z
			.tuple([z.object({ id: z.string(), expiresAt: z.string() })])
			.rest(z.object({ id: z.string(), expiresAt: z.string() }))
			.parse(await refreshTokenRows());

		await runInDurableObject(currentServer(), (_instance, state) => {
			const database = drizzle(state.storage, { schema: { refreshTokens } });
			const rows = database.select().from(refreshTokens).all();
			const staleRows = rows.filter((row) => row.id !== live.id);
			const [stale] = z
				.tuple([z.looseObject({ id: z.string() })])
				.parse(staleRows);

			database
				.update(refreshTokens)
				.set({ expiresAt: '2020-01-01T00:00:00.000Z' })
				.where(eq(refreshTokens.id, stale.id))
				.run();
		});

		await currentServer().runGarbageCollection();

		const survivors = await refreshTokenRows();

		expect({
			exchangeStatuses: [firstExchange.status, secondExchange.status],
			survivors: survivors.map((row) => row.id)
		}).toStrictEqual({
			exchangeStatuses: [StatusCodes.OK, StatusCodes.OK],
			survivors: [live.id]
		});
	});
});

async function exchangeWith(
	details: string
): Promise<{ status: number; body: unknown }> {
	const subjectToken = await installTrustedIdp('write');
	const response = await postToken({
		grant_type: tokenExchangeGrantType,
		subject_token: subjectToken,
		subject_token_type: subjectTokenTypeIdToken,
		authorization_details: details
	});

	return { status: response.status, body: await response.json() };
}

describe('request and verify', () => {
	beforeEach(resetTestServer);

	it('issues a token confined to the requested grant', async () => {
		const subjectToken = await installTrustedIdp('write');
		const exchanged = await exchange(subjectToken, ciRequest);
		const claims = decodeJwt(exchanged.access_token);

		expect({
			status: exchanged.status,
			granted: exchanged.authorization_details,
			tokenGrants: claims.authorization_details,
			hasRefresh: exchanged.refresh_token
		}).toStrictEqual({
			status: StatusCodes.OK,
			granted: ciRequest,
			tokenGrants: ciRequest,
			hasRefresh: undefined
		});
	});

	// Commit authority is confined to upload-specific state, while confirmation
	// can refresh any committed path in a cache.
	it('refuses upload:confirm when the rule only names upload:commit', async () => {
		const confirmRequest = [
			{ type: 'cupboard_cache', actions: ['upload:confirm'], cache: 'ci' }
		];
		const { status, body } = await exchangeWith(JSON.stringify(confirmRequest));

		expect({ status, shape: oauthErrorShape(body) }).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			shape: {
				error: 'invalid_authorization_details',
				error_description:
					'the requested authorization_details are not permitted',
				problem: 'not-permitted'
			}
		});
	});

	it('rejects a CI exchange that names no grants as invalid_request', async () => {
		const subjectToken = await installTrustedIdp('write');
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
			problem: 'authorization-details-required'
		});
	});

	it.each([
		{
			name: 'a non-JSON authorization_details field',
			details: 'not-json',
			problem: 'malformed'
		},
		{
			name: 'a malformed grant array',
			details: JSON.stringify([{ type: 'cupboard_unknown' }]),
			problem: 'malformed'
		},
		{
			name: 'an empty authorization_details array',
			details: JSON.stringify([]),
			problem: 'empty'
		},
		{
			name: 'a grant for a cache the rule does not permit',
			details: JSON.stringify([
				{ type: 'cupboard_cache', actions: ['upload:commit'], cache: 'other' }
			]),
			problem: 'not-permitted'
		},
		{
			name: 'an operation the rule does not permit',
			details: JSON.stringify([
				{ type: 'cupboard_cache', actions: ['gc:run'], cache: 'ci' }
			]),
			problem: 'not-permitted'
		}
	])(
		'rejects $name as invalid_authorization_details',
		async ({ details, problem }) => {
			const { status, body } = await exchangeWith(details);

			expect({ status, shape: oauthErrorShape(body) }).toStrictEqual({
				status: StatusCodes.BAD_REQUEST,
				shape: {
					error: 'invalid_authorization_details',
					error_description:
						'the requested authorization_details are not permitted',
					problem
				}
			});
		}
	);
});

function attenuate(token: string, details: unknown): Promise<Response> {
	return postToken({
		grant_type: tokenExchangeGrantType,
		subject_token: token,
		subject_token_type: issuedAccessTokenType,
		authorization_details: JSON.stringify(details)
	});
}

// A wildcard owner token, obtained the real way so it verifies against the
// tenant's own keys.
async function ownerToken(): Promise<string> {
	const subjectToken = await installTrustedIdp('admin');
	const exchanged = await exchange(subjectToken);

	return exchanged.access_token;
}

describe('attenuation', () => {
	beforeEach(resetTestServer);

	it('narrows a self-issued token to a requested subset, with no refresh', async () => {
		const owner = await ownerToken();
		const subset = [
			{ type: 'cupboard_cache', actions: ['upload:commit'], cache: 'pr-1' }
		];

		const response = await attenuate(owner, subset);
		const body = tokenResponseSchema.parse(await response.json());

		expect({
			status: response.status,
			granted: body.authorization_details,
			hasRefresh: body.refresh_token
		}).toStrictEqual({
			status: StatusCodes.OK,
			granted: subset,
			hasRefresh: undefined
		});
	});

	it('refuses a request that exceeds the presented token', async () => {
		const owner = await ownerToken();
		const narrowResponse = await attenuate(owner, [
			{ type: 'cupboard_cache', actions: ['upload:commit'], cache: 'pr-1' }
		]);
		const narrowed = tokenResponseSchema.parse(await narrowResponse.json());

		// The narrowed token holds only `upload:commit` on `pr-1`; a request for
		// another cache, or another operation, is not a subset.
		const otherCache = await attenuate(narrowed.access_token, [
			{ type: 'cupboard_cache', actions: ['upload:commit'], cache: 'pr-2' }
		]);
		const otherOp = await attenuate(narrowed.access_token, [
			{ type: 'cupboard_cache', actions: ['gc:run'], cache: 'pr-1' }
		]);

		expect({
			otherCache: oauthErrorShape(await otherCache.json()).error,
			otherCacheStatus: otherCache.status,
			otherOp: oauthErrorShape(await otherOp.json()).error
		}).toStrictEqual({
			otherCache: 'invalid_authorization_details',
			otherCacheStatus: StatusCodes.BAD_REQUEST,
			otherOp: 'invalid_authorization_details'
		});
	});

	// upload:commit is trusted with upload-specific state; upload:confirm
	// refreshes any already-committed path in the cache. A commit-only token
	// must not attenuate into confirm authority it was never issued.
	it('refuses to narrow a commit-only token into confirm authority', async () => {
		const owner = await ownerToken();
		const narrowResponse = await attenuate(owner, [
			{ type: 'cupboard_cache', actions: ['upload:commit'], cache: 'pr-1' }
		]);
		const narrowed = tokenResponseSchema.parse(await narrowResponse.json());

		const confirmAttempt = await attenuate(narrowed.access_token, [
			{ type: 'cupboard_cache', actions: ['upload:confirm'], cache: 'pr-1' }
		]);

		expect({
			status: confirmAttempt.status,
			error: oauthErrorShape(await confirmAttempt.json()).error
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_authorization_details'
		});
	});

	it('does not attenuate a token signed by a foreign key', async () => {
		// A token carrying the tenant's issuer but signed by another key fails the
		// self-verification, so it routes to the trust path and is refused rather
		// than narrowed.
		const foreign = await generateKeyPair('RS256', { extractable: true });
		const signer = new SignJWT({
			authorization_details: [{ type: 'cupboard_wildcard' }]
		});
		const forged = await signer
			.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
			.setIssuer('https://idp.test')
			.setAudience('cupboard-aud')
			.setSubject('mallory')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(foreign.privateKey);

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: forged,
			subject_token_type: subjectTokenTypeJwt,
			authorization_details: JSON.stringify([{ type: 'cupboard_wildcard' }])
		});

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
	});

	it('lets a refresh narrow the reissued session', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		const subset = [
			{ type: 'cupboard_cache', actions: ['upload:commit'], cache: 'pr-1' }
		];

		const refreshed = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: exchanged.refresh_token ?? '',
			authorization_details: JSON.stringify(subset)
		});
		const body = tokenResponseSchema.parse(await refreshed.json());

		expect({
			status: refreshed.status,
			granted: body.authorization_details
		}).toStrictEqual({
			status: StatusCodes.OK,
			granted: subset
		});
	});
});

describe('owner rule seeding', () => {
	beforeEach(resetTestServer);

	it('seeds the owner admin rule from deploy config on init', async () => {
		// Any DO request runs initialisation, which seeds the rule.
		await fetchPath('/.well-known/jwks.json');

		const rules = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				drizzle(state.storage, { schema: { oidcTrust } })
					.select()
					.from(oidcTrust)
					.all()
		);
		const [rule] = z
			.tuple([
				z.object({
					id: z.string(),
					issuer: z.string(),
					audience: z.string(),
					claimsJson: z.string(),
					permittedGrantsJson: z.string(),
					displayJson: z.null(),
					createdAt: z.string(),
					disabledAt: z.null()
				})
			])
			.parse(rules);

		expect({ rules }).toStrictEqual({
			rules: [
				{
					id: 'owner',
					issuer: 'https://accounts.google.com',
					audience: 'client-id.apps.googleusercontent.com',
					claimsJson: JSON.stringify({ sub: 'owner-subject' }),
					permittedGrantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }]),
					displayJson: rule.displayJson,
					createdAt: rule.createdAt,
					disabledAt: rule.disabledAt
				}
			]
		});
	});

	it('removes the owner rule when reconfigured with no owner', async () => {
		await fetchPath('/.well-known/jwks.json');

		const remaining = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.configure({
					tenant: tenantIdSchema.parse('v1'),
					issuer: oidcIssuerSchema.parse('cupboard'),
					audience: oidcAudienceSchema.parse('cupboard'),
					ownerIssuer: oidcIssuerSchema.parse(''),
					ownerSubject: oidcSubjectSchema.parse(''),
					ownerAudience: oidcAudienceSchema.parse(''),
					configVersion: 2
				});

				return drizzle(state.storage, { schema: { oidcTrust } })
					.select()
					.from(oidcTrust)
					.all();
			}
		);

		expect(remaining).toStrictEqual([]);
	});

	it('refuses to configure with a malformed owner issuer', async () => {
		await fetchPath('/.well-known/jwks.json');

		const rejection = await runInDurableObject(
			currentServer(),
			async (instance): Promise<unknown> => {
				try {
					await instance.configure({
						tenant: tenantIdSchema.parse('v1'),
						issuer: oidcIssuerSchema.parse('cupboard'),
						audience: oidcAudienceSchema.parse('cupboard'),
						ownerIssuer: oidcIssuerSchema.parse('not-a-url'),
						ownerSubject: oidcSubjectSchema.parse('owner'),
						ownerAudience: oidcAudienceSchema.parse('aud'),
						configVersion: 2
					});
				} catch (error_) {
					return error_;
				}
			}
		);
		expect(rejection).toBeInstanceOf(OwnerConfigurationInvalidError);
		if (!(rejection instanceof OwnerConfigurationInvalidError)) {
			throw rejection;
		}

		expect({
			error: {
				name: rejection.name,
				status: rejection.status,
				issuer: rejection.issuer
			}
		}).toStrictEqual({
			error: {
				name: OwnerConfigurationInvalidError.name,
				status: StatusCodes.INTERNAL_SERVER_ERROR,
				issuer: 'not-a-url'
			}
		});
	});
});

describe('auth discovery endpoints', () => {
	beforeEach(resetTestServer);

	it('serves the auth public key as a JWKS from the Durable Object', async () => {
		const response = await fetchPath('/.well-known/jwks.json');
		const body = jwksResponseSchema.parse(await response.json());
		const [key] = body.keys;

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			keys: body.keys
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

	it('serves OAuth authorization-server metadata at the edge', async () => {
		const response = await readFetch('/.well-known/oauth-authorization-server');
		const origin = currentOrigin();

		expect({
			status: response.status,
			body: authorizationServerMetadataSchema.parse(await response.json())
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: {
				// The tenant's issuer is its own path-based URL, the same value
				// provisioning stamps into the Durable Object's identity.
				issuer: `${origin}/t/v1`,
				// The endpoints carry this tenant's `/t/<tenant>/` prefix.
				token_endpoint: `${origin}/t/v1/token`,
				jwks_uri: `${origin}/t/v1/.well-known/jwks.json`,
				grant_types_supported: [tokenExchangeGrantType, refreshTokenGrantType],
				authorization_details_types_supported: [
					'cupboard_cache',
					'cupboard_domain',
					'cupboard_wildcard'
				],
				token_endpoint_auth_methods_supported: ['none']
			}
		});
	});
});

// A GitHub-shaped branch rule pinning both repository ids, with an in-memory
// issuer, so refusal diagnostics can be exercised without any network. `sign`
// issues genuine tokens; `forge` signs the same claims with a key the issuer
// never published.
const githubIssuer = 'https://gh.test';
const githubAudience = 'cupboard-aud';
const branchRuleClaims = {
	repository_id: '1234',
	repository_owner_id: '5678',
	ref: 'refs/heads/main',
	job_workflow_ref:
		'owner/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/heads/main'
};

async function installGithubBranchRule(): Promise<{
	sign: (claims: Record<string, string>) => Promise<string>;
	forge: (claims: Record<string, string>) => Promise<string>;
}> {
	const idp = await generateKeyPair('RS256', { extractable: true });
	const forger = await generateKeyPair('RS256', { extractable: true });
	const jwk = await exportJWK(idp.publicKey);

	await runInDurableObject(currentServer(), async (_instance, state) => {
		await migrateThrough(state, latestMigrationIndex);
		drizzle(state.storage, { schema: { oidcTrust } })
			.insert(oidcTrust)
			.values({
				id: trustRuleIdSchema.parse('github-main'),
				issuer: githubIssuer,
				audience: githubAudience,
				claimsJson: JSON.stringify(branchRuleClaims),
				permittedGrantsJson: JSON.stringify(trustClassGrants.write),
				createdAt: '2026-01-01T00:00:00.000Z'
			})
			.run();
	});

	vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input);

		if (url === `${githubIssuer}/.well-known/openid-configuration`) {
			return Promise.resolve(
				Response.json({
					issuer: githubIssuer,
					jwks_uri: `${githubIssuer}/jwks`
				})
			);
		}

		if (url === `${githubIssuer}/jwks`) {
			return Promise.resolve(
				Response.json({ keys: [{ ...jwk, kid: 'idp', alg: 'RS256' }] })
			);
		}

		return Promise.resolve(new Response('not found', { status: 404 }));
	});

	const signWith =
		(key: CryptoKey) =>
		(claims: Record<string, string>): Promise<string> =>
			new SignJWT(claims)
				.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
				.setIssuer(githubIssuer)
				.setAudience(githubAudience)
				.setSubject('repo:acme/app')
				.setIssuedAt()
				.setExpirationTime('5m')
				.sign(key);

	return { sign: signWith(idp.privateKey), forge: signWith(forger.privateKey) };
}

async function refusedExchange(
	subjectToken: string
): Promise<{ status: number; body: z.infer<typeof oauthErrorSchema> }> {
	const response = await postToken({
		grant_type: tokenExchangeGrantType,
		subject_token: subjectToken,
		subject_token_type: subjectTokenTypeIdToken
	});

	return {
		status: response.status,
		body: oauthErrorShape(await response.json())
	};
}

describe('untrusted exchange diagnostics', () => {
	beforeEach(resetTestServer);

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('names the first failing claim for a verified token from the pinned repository', async () => {
		const { sign } = await installGithubBranchRule();
		const subjectToken = await sign({
			...branchRuleClaims,
			job_workflow_ref:
				'acme/app/.github/workflows/cupboard-flake-publish.yml@refs/heads/main'
		});

		const refused = await refusedExchange(subjectToken);

		expect(refused).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			body: {
				error: 'invalid_grant',
				error_description:
					"Trust rule github-main does not match the subject token's job_workflow_ref claim",
				problem: 'subject-token-claim-mismatch',
				detail: {
					rule: 'github-main',
					claim: 'job_workflow_ref',
					expected: branchRuleClaims.job_workflow_ref,
					presented:
						'acme/app/.github/workflows/cupboard-flake-publish.yml@refs/heads/main'
				}
			}
		});
	});

	it('stays flat for a token whose claimed repository matches no rule', async () => {
		const { sign } = await installGithubBranchRule();
		const subjectToken = await sign({
			...branchRuleClaims,
			repository_id: '9999',
			ref: 'refs/heads/other'
		});

		const refused = await refusedExchange(subjectToken);

		expect(refused.status).toBe(StatusCodes.BAD_REQUEST);
		expect(refused.body.problem).toBe('subject-token-untrusted');
		expect(refused.body.detail).toBeUndefined();
	});

	it('stays flat for a forged token claiming the pinned repository', async () => {
		const { forge } = await installGithubBranchRule();
		const subjectToken = await forge({
			...branchRuleClaims,
			ref: 'refs/heads/other'
		});

		const refused = await refusedExchange(subjectToken);

		expect(refused.status).toBe(StatusCodes.BAD_REQUEST);
		expect(refused.body.problem).toBe('subject-token-untrusted');
		expect(refused.body.detail).toBeUndefined();
	});
});
