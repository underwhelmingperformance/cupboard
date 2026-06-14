import {
	refreshTokenGrantType,
	subjectTokenTypeIdToken,
	subjectTokenTypeJwt,
	tokenExchangeGrantType,
	type TokenResponse,
	tokenResponseSchema
} from '@cupboard/protocol/oidc';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
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
import { OidcDiscoveryStore } from '../oidc/oidc.ts';
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
	problem: z.string().optional()
});

function oauthErrorShape(value: unknown): z.infer<typeof oauthErrorSchema> {
	return oauthErrorSchema.parse(value);
}

const jwksResponseSchema = z.strictObject({
	keys: z.tuple([
		z.strictObject({
			kty: z.string(),
			crv: z.string(),
			alg: z.string(),
			use: z.string(),
			kid: z.string(),
			x: z.string(),
			ext: z.boolean(),
			key_ops: z.tuple([z.string()])
		})
	])
});

const authorizationServerMetadataSchema = z.strictObject({
	issuer: z.string(),
	token_endpoint: z.string(),
	jwks_uri: z.string(),
	grant_types_supported: z.array(z.string()),
	scopes_supported: z.array(z.string()),
	token_endpoint_auth_methods_supported: z.array(z.string())
});

function postToken(form: Record<string, string>): Promise<Response> {
	return fetchPath('/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(form).toString()
	});
}

// A real, well-formed inbound token whose issuer matches no trust rule, so
// matching fails before any JWKS fetch — the verification network is never
// touched in these tests.
async function untrustedToken(): Promise<string> {
	const { privateKey } = await generateKeyPair('RS256', { extractable: true });

	return new SignJWT({})
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

		return service
			.handleToken(
				new Request(new URL('/token', currentOrigin()), {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams(body).toString()
				})
			)
			.catch((error: unknown) => error);
	});
}

describe('POST /token', () => {
	beforeEach(resetTestServer);

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
		const subjectToken = await new SignJWT({ sub: 'ci' })
			.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
			.setIssuer('https://idp.test')
			.setAudience('cupboard-aud')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(idp.privateKey);

		await runInDurableObject(currentServer(), async (instance, state) => {
			await migrateThrough(state, latestMigrationIndex);
			drizzle(state.storage, { schema: { oidcTrust } })
				.insert(oidcTrust)
				.values({
					id: 'ci-rule',
					issuer: 'https://idp.test',
					audience: 'cupboard-aud',
					scope: 'write',
					claimsJson: JSON.stringify({ sub: 'ci' }),
					allowedRootsJson: '[]',
					createdAt: '2026-01-01T00:00:00.000Z'
				})
				.run();
			instance.discovery = new OidcDiscoveryStore({
				fetcher: () => Promise.reject(new Error('issuer is down'))
			});
		});

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});

		expect({
			status: response.status
		}).toStrictEqual({
			status: StatusCodes.SERVICE_UNAVAILABLE
		});
	});
});

// Installs a trust rule for a stub issuer whose discovery and JWKS documents
// are served from memory, and returns a subject token it signed: a full,
// successful exchange without any network.
async function installTrustedIdp(scope: 'admin' | 'write'): Promise<string> {
	const idp = await generateKeyPair('RS256', { extractable: true });
	const jwk = await exportJWK(idp.publicKey);
	const subjectToken = await new SignJWT({})
		.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
		.setIssuer('https://idp.test')
		.setAudience('cupboard-aud')
		.setSubject('alice')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(idp.privateKey);

	await runInDurableObject(currentServer(), async (instance, state) => {
		await migrateThrough(state, latestMigrationIndex);
		drizzle(state.storage, { schema: { oidcTrust } })
			.insert(oidcTrust)
			.values({
				id: `${scope}-rule`,
				issuer: 'https://idp.test',
				audience: 'cupboard-aud',
				scope,
				claimsJson: JSON.stringify({ sub: 'alice' }),
				allowedRootsJson: '[]',
				createdAt: '2026-01-01T00:00:00.000Z'
			})
			.run();
		instance.discovery = new OidcDiscoveryStore({
			fetcher: (input) => {
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
			}
		});
	});

	return subjectToken;
}

type SuccessfulTokenExchange = TokenResponse & { readonly status: number };

async function exchange(
	subjectToken: string
): Promise<SuccessfulTokenExchange> {
	const response = await postToken({
		grant_type: tokenExchangeGrantType,
		subject_token: subjectToken,
		subject_token_type: subjectTokenTypeIdToken
	});
	const body = tokenResponseSchema.parse(await response.json());

	return { ...body, status: response.status };
}

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
			refreshedScope: refreshedBody.scope,
			refreshedExpiresIn: refreshedBody.expires_in,
			refreshedHasRefreshToken: typeof refreshedBody.refresh_token,
			rotated: refreshedBody.refresh_token !== exchanged.refresh_token,
			subject: claims.sub,
			scopeClaim: claims.scope,
			replayedStatus: replayed.status,
			replayedError: replayedBody.error,
			replayedProblem: replayedBody.problem
		}).toStrictEqual({
			exchangeStatus: StatusCodes.OK,
			exchangedHasRefreshToken: 'string',
			refreshedStatus: StatusCodes.OK,
			refreshedCacheControl: 'no-store',
			refreshedScope: 'admin',
			refreshedExpiresIn: 600,
			refreshedHasRefreshToken: 'string',
			rotated: true,
			subject: 'alice',
			scopeClaim: 'admin',
			replayedStatus: StatusCodes.BAD_REQUEST,
			replayedError: 'invalid_grant',
			replayedProblem: 'stale-refresh-token'
		});
	});

	it('grants once when the same refresh token is presented concurrently', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		const refreshToken = exchanged.refresh_token ?? '';
		const present = (): Request =>
			new Request(new URL('/token', currentOrigin()), {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: refreshTokenGrantType,
					refresh_token: refreshToken
				}).toString()
			});

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
		const exchanged = await exchange(subjectToken);

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
				.where(eq(oidcTrust.id, 'admin-rule'))
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
					scope: z.string(),
					claimsJson: z.string(),
					allowedRootsJson: z.string(),
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
					scope: 'admin',
					claimsJson: JSON.stringify({ sub: 'owner-subject' }),
					allowedRootsJson: '[]',
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
					tenant: 'v1',
					issuer: 'cupboard',
					audience: 'cupboard',
					ownerIssuer: '',
					ownerSubject: '',
					ownerAudience: '',
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
						tenant: 'v1',
						issuer: 'cupboard',
						audience: 'cupboard',
						ownerIssuer: 'not-a-url',
						ownerSubject: 'owner',
						ownerAudience: 'aud',
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
				scopes_supported: ['write', 'admin'],
				token_endpoint_auth_methods_supported: ['none']
			}
		});
	});
});
