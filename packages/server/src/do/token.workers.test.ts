import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import { bytesToBase64Url } from '@cupboard/nix-store/encoding';
import {
	cacheNameSchema,
	type CacheScope,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type PermittedGrant,
	storedPermittedGrantsSchema
} from '@cupboard/protocol/grants';
import {
	issuedAccessTokenType,
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema,
	refreshTokenGrantType,
	subjectTokenTypeIdToken,
	tokenExchangeGrantType,
	type TokenResponseInput,
	tokenResponseSchema,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import {
	readAccessGrantType,
	readAccessResponseSchema,
	type ReadResource,
	readResourcesSchema
} from '@cupboard/protocol/read-access';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	maxRefreshTokenFamilyMembers,
	refreshTokenFamilyTtlSeconds
} from '../auth/auth.ts';
import {
	RefreshCredential,
	refreshCredentialMaxBytes,
	type RefreshKeyContext,
	refreshPolicyIdentity
} from '../auth/refresh-credential.ts';
import { pushIdSigningKey } from '../blob/push-credential.ts';
import { sha256Hex } from '../crypto/crypto.ts';
import {
	cacheIdentities,
	oidcTrust,
	refreshTokenFamilies,
	refreshTokenMembers
} from '../db/schema.ts';
import {
	OAuthError,
	OwnerConfigurationInvalidError,
	ReadResourcesNotPermittedError,
	RefreshTokenRequiredError,
	StaleRefreshTokenError,
	StoredOidcTrustInvalidError,
	SubjectTokenNotJwtError,
	SubjectTokenRequiredError,
	SubjectTokenVerificationFailedError,
	TenantSubjectTokenUntrustedError,
	UnsupportedGrantTypeError,
	UnsupportedSubjectTokenTypeError
} from '../errors.ts';
import {
	adminGrants,
	authorisedFetch,
	currentOrigin,
	currentServer,
	fetchPath,
	issueServerSignedToken,
	latestMigrationIndex,
	migrateThrough,
	provisionNamedTenant,
	putTestCache,
	readFetch,
	resetTestServer,
	testPushId,
	underOneUnitOfWork,
	uploadMetadata,
	uploadPathNegotiation
} from '../test-support.ts';

import { AuthKeysService } from './auth-keys-service.ts';
import { ownerRuleId, type ServerContext } from './context.ts';
import { phaseStepSize } from './garbage-collection-service.ts';
import { OidcTrustService } from './oidc-trust-service.ts';
import { gcContinuationKey } from './server.ts';
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
	response_types_supported: z.array(z.string()),
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
			return await service.handleToken(rootLogger(), request);
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
			subject_token_type: 'urn:ietf:params:oauth:token-type:jwt'
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
			respond: async () =>
				postToken({
					grant_type: tokenExchangeGrantType,
					subject_token: await installTrustedIdp('admin'),
					subject_token_type: subjectTokenTypeIdToken
				})
		},
		{
			name: 'a refresh',
			respond: async () => {
				const exchanged = await exchange(await installTrustedIdp('admin'));

				return refresh(exchanged.refresh_token ?? '');
			}
		},
		{
			name: 'an exchange of an issued token',
			respond: async () =>
				attenuate(await ownerToken(), [
					{
						type: 'cupboard_cache',
						actions: ['upload:commit'],
						cache: namedCache('pr-1')
					}
				])
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

	it('rejects a token exchange with no subject token', async () => {
		const error = await tokenExchangeError({
			grant_type: tokenExchangeGrantType,
			subject_token_type: subjectTokenTypeIdToken
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
				subject_token_type: subjectTokenTypeIdToken
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

	it('ignores an unknown extension parameter', async () => {
		const presented = await issueServerSignedToken(adminGrants());
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
				subject_token: await untrustedToken()
			}),
			problem: 'schema-mismatch'
		},
		{
			name: 'a self-issued subject token without its type',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await issueServerSignedToken(adminGrants())
			}),
			problem: 'schema-mismatch'
		},
		{
			name: 'a self-issued subject token with an unsupported type',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await issueServerSignedToken(adminGrants()),
				subject_token_type: 'unsupported'
			}),
			problem: 'unsupported-subject-token-type'
		},
		{
			name: 'a self-issued access token declared as an ID token',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await issueServerSignedToken(adminGrants()),
				subject_token_type: subjectTokenTypeIdToken
			}),
			problem: 'unsupported-subject-token-type'
		},
		{
			name: 'a self-issued access token declared as a generic JWT',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await issueServerSignedToken(adminGrants()),
				subject_token_type: 'urn:ietf:params:oauth:token-type:jwt'
			}),
			problem: 'unsupported-subject-token-type'
		},
		{
			name: 'an external exchange with a refresh token',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await untrustedToken(),
				subject_token_type: subjectTokenTypeIdToken,
				refresh_token: 'refresh-token'
			}),
			problem: 'schema-mismatch'
		},
		{
			name: 'a self-issued exchange with a refresh token',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await issueServerSignedToken(adminGrants()),
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
			body:
				'grant_type=first&grant_type=second&' +
				'subject_token=x&subject_token_type=unsupported'
		},
		{
			name: 'an unknown extension',
			body: 'grant_type=authorization_code&extension=first&extension=second'
		}
	])('rejects a repeated $name parameter', async ({ body: requestBody }) => {
		const response = await fetchPath('/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: requestBody
		});
		const body = oauthErrorShape(await response.json());

		expect({ status: response.status, error: body.error }).toStrictEqual({
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
			const response = await fetchPath('/token', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: requestBody
			});
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

	it('logs token refusals without recording either credential', async () => {
		const subjectMarker = 'subject-token-do-not-log';
		const refreshMarker = 'refresh-token-do-not-log';
		const capture = startCapture();
		let response: Response;

		try {
			response = await fetchPath('/token', {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'cf-ray': 'ray-token-redaction'
				},
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					subject_token: subjectMarker,
					refresh_token: refreshMarker
				}).toString()
			});
		} finally {
			capture.stop();
		}

		const lines = capture.logs.map((entry) => ({
			message: entry.message,
			method: entry.properties.method,
			path: entry.properties.path,
			ray: entry.properties.ray,
			status: entry.properties.status,
			rowsRead: entry.properties.rowsRead,
			rowsWritten: entry.properties.rowsWritten
		}));
		const serialised = JSON.stringify(capture.logs);

		expect({ status: response.status, lines }).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			lines: [
				{
					message: 'request finished',
					method: 'POST',
					path: '/token',
					ray: 'ray-token-redaction',
					status: StatusCodes.BAD_REQUEST,
					rowsRead: 1,
					rowsWritten: 0
				}
			]
		});
		expect(serialised).not.toContain(subjectMarker);
		expect(serialised).not.toContain(refreshMarker);
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
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
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

	it('leaves an existing loopback HTTP trust row out of issuance', async () => {
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await migrateThrough(state, latestMigrationIndex);
				drizzle(state.storage, { schema: { oidcTrust } })
					.insert(oidcTrust)
					.values({
						id: trustRuleIdSchema.parse('legacy-http'),
						issuer: 'http://127.0.0.1:8788',
						audience: 'cupboard-aud',
						claimsJson: JSON.stringify({ sub: 'ci' }),
						permittedGrantsJson: JSON.stringify(trustClassGrants.write),
						createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
					})
					.run();

				const tenantIdentity = new TenantIdentityService(instance.context);
				const service = new OidcTrustService(instance.context, tenantIdentity);
				const capture = startCapture();
				let enabled: readonly { readonly id: string }[];

				try {
					enabled = service
						.enabledOidcTrustRules(rootLogger())
						.map((rule) => ({ id: rule.id }));
				} finally {
					capture.stop();
				}

				let readError: unknown;
				try {
					service.getRule(trustRuleIdSchema.parse('legacy-http'));
				} catch (error_: unknown) {
					readError = error_;
				}

				return {
					enabled,
					skipped: capture.logs
						.filter(
							(entry) => entry.message === 'stored OIDC trust rule skipped'
						)
						.map((entry) => ({
							level: entry.level,
							hasCause: entry.properties.cause instanceof Error
						})),
					readRefused: readError instanceof StoredOidcTrustInvalidError
				};
			}
		);

		expect(outcome).toStrictEqual({
			// The tenant's own owner rule remains; only the unreadable row is left out.
			enabled: [{ id: 'owner' }],
			skipped: [{ level: 'error', hasCause: true }],
			readRefused: true
		});
	});

	it('retries one issuer fetch failure and completes the exchange', async () => {
		const subjectToken = await installTrustedIdp('admin', {
			failFirstFetches: 1
		});

		const exchanged = await exchange(subjectToken);

		expect(exchanged.status).toBe(StatusCodes.OK);
	});

	it('does not relabel an external access JWT as an ID token', async () => {
		const subjectToken = await installTrustedIdp('admin', {
			protectedType: 'at+jwt'
		});
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
});

async function installComposedReadRules(isOverlapping = false): Promise<{
	readonly subject: string;
	readonly resources: readonly ReadResource[];
}> {
	await installTrustedIdp('write');
	const subject = await installTrustedIdp('read');
	const administrator = await issueServerSignedToken(adminGrants());
	for (const name of ['a', 'b']) {
		await putTestCache(
			administrator,
			{ kind: 'named', name: cacheNameSchema.parse(name) },
			'private'
		);
	}
	const view = await authorisedFetch('/reuse-views/sources', administrator, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			access: 'private',
			priority: 80,
			selectors: [{ kind: 'all' }]
		})
	});
	expect(view.status).toBe(200);
	await view.text();
	await runInDurableObject(currentServer(), (_instance, state) => {
		const database = drizzle(state.storage, { schema: { oidcTrust } });
		for (const rule of [
			{ id: 'write-rule', caches: ['a'], view: false },
			{
				id: 'read-rule',
				caches: isOverlapping ? ['a', 'b'] : ['b'],
				view: true
			}
		]) {
			const grants = [
				...rule.caches.map((name) => ({
					type: 'cupboard_cache',
					actions: ['cache:content-read'],
					resources: {
						cache: { kind: 'named', exact: name, validate: 'cacheName' }
					}
				})),
				...(rule.view
					? [
							{
								type: 'cupboard_view',
								actions: ['view:content-read'],
								resources: {
									view: { exact: 'sources', validate: 'reuseViewName' }
								}
							}
						]
					: [])
			];
			database
				.update(oidcTrust)
				.set({ permittedGrantsJson: JSON.stringify(grants) })
				.where(eq(oidcTrust.id, trustRuleIdSchema.parse(rule.id)))
				.run();
		}
	});
	return {
		subject,
		resources: readResourcesSchema.parse([
			{
				type: 'cupboard_cache',
				cache: { kind: 'named', name: 'a' },
				mode: 'content'
			},
			{
				type: 'cupboard_cache',
				cache: { kind: 'named', name: 'b' },
				mode: 'content'
			},
			{ type: 'cupboard_view', view: 'sources' }
		])
	};
}

describe('server-resolved read acquisition', () => {
	beforeEach(resetTestServer);

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		'[]',
		'{',
		JSON.stringify(
			Array.from({ length: 17 }, (_, index) => ({
				type: 'cupboard_cache',
				cache: { kind: 'named', name: `cache-${String(index)}` }
			}))
		),
		JSON.stringify([
			{
				type: 'cupboard_cache',
				cache: { kind: 'named', name: 'ci' },
				actions: ['upload:commit']
			}
		]),
		JSON.stringify([
			{ type: 'cupboard_cache', cache: { kind: 'default' } },
			{ type: 'cupboard_cache', cache: { kind: 'default' } }
		])
	])('rejects malformed or excessive read intent %s', async (intent) => {
		const subject = await installTrustedIdp('write');
		const response = await postToken({
			grant_type: readAccessGrantType,
			subject_token: subject,
			subject_token_type: subjectTokenTypeIdToken,
			read_resources: intent
		});

		expect({
			status: response.status,
			body: await response.json()
		}).toStrictEqual({
			status: 400,
			body: {
				error: 'invalid_request',
				error_description:
					'read_resources must contain one to sixteen distinct cache or view resources, including at most one reuse view.',
				problem: 'invalid-read-resources'
			}
		});
	});

	it.each(['absent', 'private'] as const)(
		'limits missing read authority advice to the requested %s cache',
		async (state) => {
			const subject = await installTrustedIdp('release-write');
			const cache = {
				kind: 'named' as const,
				name: cacheNameSchema.parse('ci')
			};
			if (state === 'private') {
				await putTestCache(
					await issueServerSignedToken(adminGrants()),
					cache,
					'private'
				);
			}
			const response = await postToken({
				grant_type: readAccessGrantType,
				subject_token: subject,
				subject_token_type: subjectTokenTypeIdToken,
				read_resources: JSON.stringify([
					{ type: 'cupboard_cache', cache, mode: 'content' }
				])
			});
			expect({
				status: response.status,
				body: await response.json()
			}).toStrictEqual({
				status: 400,
				body: {
					error: 'invalid_authorization_details',
					error_description:
						"The matching trust rules do not permit the requested read_resources. Add cache:content-read for cache 'ci'.",
					problem: 'read-resources-not-permitted',
					detail: {
						read_resources: JSON.stringify([
							{ type: 'cupboard_cache', actions: ['cache:content-read'], cache }
						])
					}
				}
			});
		}
	);

	it('explains missing view authority without listing unrelated resources', async () => {
		const subject = await installTrustedIdp('release-write');
		const response = await postToken({
			grant_type: readAccessGrantType,
			subject_token: subject,
			subject_token_type: subjectTokenTypeIdToken,
			read_resources: JSON.stringify([{ type: 'cupboard_view', view: 'prior' }])
		});
		expect({
			status: response.status,
			body: await response.json()
		}).toStrictEqual({
			status: 400,
			body: {
				error: 'invalid_authorization_details',
				error_description:
					"The matching trust rules do not permit the requested read_resources. Add view:content-read for reuse view 'prior'.",
				problem: 'read-resources-not-permitted',
				detail: {
					read_resources: JSON.stringify([
						{
							type: 'cupboard_view',
							actions: ['view:content-read'],
							view: 'prior'
						}
					])
				}
			}
		});
	});

	it.each([false, true])(
		'composes private cache reads with view included=%s',
		async (includeView) => {
			const { subject, resources } = await installComposedReadRules();
			const requested = resources.filter(
				(resource) => includeView || resource.type === 'cupboard_cache'
			);
			const response = await postToken({
				grant_type: readAccessGrantType,
				subject_token: subject,
				subject_token_type: subjectTokenTypeIdToken,
				read_resources: JSON.stringify(requested)
			});
			expect(response.status).toBe(200);
			const result = readAccessResponseSchema.parse(await response.json());
			const decoded = decodeJwt(result.access_token);
			const grants = requested.map((resource) =>
				resource.type === 'cupboard_cache'
					? {
							type: resource.type,
							cache: resource.cache,
							actions: ['cache:content-read']
						}
					: {
							type: resource.type,
							view: resource.view,
							actions: ['view:content-read']
						}
			);
			expect({
				expires: result.expires_in,
				refresh: result.refresh_token,
				grants: result.authorization_details,
				jwtGrants: decoded.authorization_details,
				rule: decoded.cb_rule,
				rules: decoded.cb_rules,
				facts: result.read_resources
			}).toStrictEqual({
				expires: 900,
				refresh: undefined,
				grants,
				jwtGrants: grants,
				rule: undefined,
				rules: undefined,
				facts: requested.map((resource) => ({
					...resource,
					state: {
						kind: 'existing',
						access: 'private',
						priority: resource.type === 'cupboard_cache' ? 40 : 80
					}
				}))
			});
		}
	);

	it('selects one identity witness for public-only zero-authority read acquisition', async () => {
		await installTrustedIdp('write');
		const subject = await installTrustedIdp('read');
		const cache: CacheScope = {
			kind: 'named',
			name: cacheNameSchema.parse('public-outside-grants')
		};
		await putTestCache(
			await issueServerSignedToken(adminGrants()),
			cache,
			'public'
		);
		const response = await postToken({
			grant_type: readAccessGrantType,
			subject_token: subject,
			subject_token_type: subjectTokenTypeIdToken,
			read_resources: JSON.stringify([{ type: 'cupboard_cache', cache }])
		});
		expect(response.status).toBe(StatusCodes.OK);
		const result = readAccessResponseSchema.parse(await response.json());
		const claims = decodeJwt(result.access_token);
		expect({
			grants: result.authorization_details,
			tokenGrants: claims.authorization_details,
			refresh: result.refresh_token,
			rule: claims.cb_rule,
			rules: claims.cb_rules
		}).toStrictEqual({
			grants: [],
			tokenGrants: [],
			refresh: undefined,
			rule: 'read-rule',
			rules: undefined
		});
	});

	it('refuses private authority from a lower-precedence matching read rule', async () => {
		const { subject, resources } = await installComposedReadRules();
		await runInDurableObject(currentServer(), (_instance, state) => {
			drizzle(state.storage, { schema: { oidcTrust } })
				.update(oidcTrust)
				.set({ claimsJson: '{}' })
				.where(eq(oidcTrust.id, trustRuleIdSchema.parse('read-rule')))
				.run();
		});
		const response = await postToken({
			grant_type: readAccessGrantType,
			subject_token: subject,
			subject_token_type: subjectTokenTypeIdToken,
			read_resources: JSON.stringify(resources.slice(0, 2))
		});
		expect({
			status: response.status,
			body: await response.json()
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			body: {
				error: 'invalid_authorization_details',
				error_description:
					"The matching trust rules do not permit the requested read_resources. Add cache:content-read for cache 'b'.",
				problem: 'read-resources-not-permitted',
				detail: {
					read_resources: JSON.stringify([
						{
							type: 'cupboard_cache',
							actions: ['cache:content-read'],
							cache: { kind: 'named', name: 'b' }
						}
					])
				}
			}
		});
	});

	it('deduplicates overlapping read grants and preserves single-rule audit compatibility', async () => {
		const { subject, resources } = await installComposedReadRules(true);
		const response = await postToken({
			grant_type: readAccessGrantType,
			subject_token: subject,
			subject_token_type: subjectTokenTypeIdToken,
			read_resources: JSON.stringify(resources)
		});
		expect(response.status).toBe(200);
		const result = readAccessResponseSchema.parse(await response.json());
		const decoded = decodeJwt(result.access_token);
		expect({
			grants: result.authorization_details,
			rule: decoded.cb_rule,
			rules: decoded.cb_rules
		}).toStrictEqual({
			grants: [
				{
					type: 'cupboard_cache',
					cache: { kind: 'named', name: 'a' },
					actions: ['cache:content-read']
				},
				{
					type: 'cupboard_cache',
					cache: { kind: 'named', name: 'b' },
					actions: ['cache:content-read']
				},
				{
					type: 'cupboard_view',
					view: 'sources',
					actions: ['view:content-read']
				}
			],
			rule: 'read-rule',
			rules: undefined
		});
	});

	it.each([
		{
			kind: 'read',
			removed: 'read-rule',
			replace: false,
			restrictive: false,
			priorNarrow: false
		},
		{
			kind: 'read',
			removed: 'write-rule',
			replace: false,
			restrictive: false,
			priorNarrow: false
		},
		{
			kind: 'explicit',
			removed: 'read-rule',
			replace: false,
			restrictive: false,
			priorNarrow: false
		},
		{
			kind: 'explicit',
			removed: 'write-rule',
			replace: false,
			restrictive: false,
			priorNarrow: false
		},
		{
			kind: 'read',
			removed: 'read-rule',
			replace: true,
			restrictive: false,
			priorNarrow: false
		},
		{
			kind: 'explicit',
			removed: 'read-rule',
			replace: true,
			restrictive: false,
			priorNarrow: false
		},
		{
			kind: 'read',
			removed: 'read-rule',
			replace: true,
			restrictive: true,
			priorNarrow: false
		},
		{
			kind: 'explicit',
			removed: 'read-rule',
			replace: true,
			restrictive: true,
			priorNarrow: false
		},
		{
			kind: 'read',
			removed: 'read-rule',
			replace: true,
			restrictive: false,
			priorNarrow: true
		}
	])(
		'rechecks $kind current policy after $removed removal (replacement: $replace, higher tier: $restrictive)',
		async ({ kind, removed, replace, restrictive, priorNarrow }) => {
			const { subject, resources } =
				await installComposedReadRules(priorNarrow);
			const result = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const identity = new TenantIdentityService(instance.context);
					const authKeys = new AuthKeysService(instance.context, identity);
					const trust = new OidcTrustService(instance.context, identity);
					if (priorNarrow) {
						const original = trust.getRule(trustRuleIdSchema.parse(removed));
						instance.context.db
							.update(oidcTrust)
							.set({
								claimsJson: JSON.stringify({
									...original.claims,
									iss: original.issuer
								})
							})
							.where(eq(oidcTrust.id, original.id))
							.run();
					}
					const key = await authKeys.activeAuthKey();
					const signingStarted = Promise.withResolvers<undefined>();
					const releaseSigning = Promise.withResolvers<undefined>();
					vi.spyOn(authKeys, 'activeAuthKey').mockImplementation(async () => {
						signingStarted.resolve(undefined);
						await releaseSigning.promise;
						return key;
					});
					const service = new TokenExchangeService(
						instance.context,
						authKeys,
						trust
					);
					const requested = resources.map((resource) =>
						resource.type === 'cupboard_cache'
							? {
									type: resource.type,
									cache: resource.cache,
									actions: ['cache:content-read']
								}
							: {
									type: resource.type,
									view: resource.view,
									actions: ['view:content-read']
								}
					);
					const request = new Request(new URL('/token', currentOrigin()), {
						method: 'POST',
						headers: { 'content-type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({
							grant_type:
								kind === 'read' ? readAccessGrantType : tokenExchangeGrantType,
							subject_token: subject,
							subject_token_type: subjectTokenTypeIdToken,
							...(kind === 'read'
								? { read_resources: JSON.stringify(resources) }
								: {
										authorization_details: JSON.stringify(requested)
									})
						}).toString()
					});
					const issuing = service.handleToken(rootLogger(), request);
					await signingStarted.promise;
					try {
						const rule = trust.getRule(trustRuleIdSchema.parse(removed));
						trust.removeRule(rule.id);
						if (replace) {
							await trust.addRule({
								issuer: rule.issuer,
								audience: rule.audience,
								claims: restrictive
									? { ...rule.claims, iss: rule.issuer }
									: priorNarrow
										? { sub: 'alice' }
										: rule.claims,
								permittedGrants: restrictive
									? []
									: [
											...rule.permittedGrants,
											{
												type: 'cupboard_cache',
												actions: ['cache:content-read'],
												resources: {
													cache: {
														kind: 'named',
														exact: 'extra',
														validate: 'cacheName'
													}
												}
											}
										]
							});
						}
					} finally {
						releaseSigning.resolve(undefined);
					}
					try {
						const response = await issuing;
						const result = (
							kind === 'read' ? readAccessResponseSchema : tokenResponseSchema
						).parse(await response.json());
						expect({
							grants: result.authorization_details,
							tokenGrants: decodeJwt(result.access_token).authorization_details
						}).toStrictEqual({ grants: requested, tokenGrants: requested });
						return 'issued';
					} catch (error) {
						expect(error).toBeInstanceOf(
							kind === 'read'
								? ReadResourcesNotPermittedError
								: TenantSubjectTokenUntrustedError
						);
						return 'refused';
					}
				}
			);
			expect(result).toBe(replace && !restrictive ? 'issued' : 'refused');
		}
	);

	it.each(['cache becomes private', 'content grant is removed'])(
		'reports requested authority when %s during signing',
		async (change) => {
			const { subject, resources } = await installComposedReadRules();
			const result = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const identity = new TenantIdentityService(instance.context);
					const authKeys = new AuthKeysService(instance.context, identity);
					const trust = new OidcTrustService(instance.context, identity);
					instance.context.db
						.update(cacheIdentities)
						.set({ access: 'public' })
						.run();
					if (change === 'cache becomes private') {
						instance.context.db
							.update(oidcTrust)
							.set({ permittedGrantsJson: '[]' })
							.run();
					}
					const key = await authKeys.activeAuthKey();
					const signingStarted = Promise.withResolvers<undefined>();
					const releaseSigning = Promise.withResolvers<undefined>();
					vi.spyOn(authKeys, 'activeAuthKey').mockImplementation(async () => {
						signingStarted.resolve(undefined);
						await releaseSigning.promise;
						return key;
					});
					const service = new TokenExchangeService(
						instance.context,
						authKeys,
						trust
					);
					const readResources = JSON.stringify(resources.slice(0, 1));
					const request = new Request(new URL('/token', currentOrigin()), {
						method: 'POST',
						headers: { 'content-type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({
							grant_type: readAccessGrantType,
							subject_token: subject,
							subject_token_type: subjectTokenTypeIdToken,
							read_resources: readResources
						})
					});
					const issuing = service.handleToken(rootLogger(), request);
					await signingStarted.promise;
					try {
						if (change === 'cache becomes private') {
							instance.context.db
								.update(cacheIdentities)
								.set({ access: 'private' })
								.run();
						} else if (change === 'content grant is removed') {
							instance.context.db
								.update(oidcTrust)
								.set({ permittedGrantsJson: '[]' })
								.run();
						}
					} finally {
						releaseSigning.resolve(undefined);
					}
					try {
						await issuing;
						return 'issued';
					} catch (error) {
						if (!(error instanceof OAuthError)) {
							throw error;
						}
						return {
							status: error.status,
							body: {
								error: error.error,
								error_description: error.message,
								problem: error.problem,
								detail: error.detail
							}
						};
					}
				}
			);
			expect(result).toStrictEqual({
				status: 400,
				body: {
					error: 'invalid_authorization_details',
					error_description:
						"The matching trust rules do not permit the requested read_resources. Add cache:content-read for cache 'a'.",
					problem: 'read-resources-not-permitted',
					detail: {
						read_resources: JSON.stringify([
							{
								type: 'cupboard_cache',
								actions: ['cache:content-read'],
								cache: { kind: 'named', name: 'a' }
							}
						])
					}
				}
			});
		}
	);

	it('identifies genuinely uncovered grants after composing matching rules', async () => {
		await installTrustedIdp('write');
		const subject = await installTrustedIdp('read');
		const caches = ['a', 'b', 'c'].map((name) => ({
			kind: 'named' as const,
			name: cacheNameSchema.parse(name)
		}));
		const administrator = await issueServerSignedToken(adminGrants());
		for (const cache of caches) {
			await putTestCache(administrator, cache, 'private');
		}
		await runInDurableObject(currentServer(), (_instance, state) => {
			const database = drizzle(state.storage, { schema: { oidcTrust } });
			for (const rule of [
				{ id: 'write-rule', cache: 'a' },
				{ id: 'read-rule', cache: 'b' }
			]) {
				database
					.update(oidcTrust)
					.set({
						permittedGrantsJson: JSON.stringify([
							{
								type: 'cupboard_cache',
								actions: ['cache:content-read'],
								resources: {
									cache: {
										kind: 'named',
										exact: rule.cache,
										validate: 'cacheName'
									}
								}
							}
						])
					})
					.where(eq(oidcTrust.id, trustRuleIdSchema.parse(rule.id)))
					.run();
			}
		});
		const response = await postToken({
			grant_type: readAccessGrantType,
			subject_token: subject,
			subject_token_type: subjectTokenTypeIdToken,
			read_resources: JSON.stringify(
				caches.map((cache) => ({
					type: 'cupboard_cache',
					cache,
					mode: 'content'
				}))
			)
		});
		expect({
			status: response.status,
			body: await response.json()
		}).toStrictEqual({
			status: 400,
			body: {
				error: 'invalid_authorization_details',
				error_description:
					"The matching trust rules do not permit the requested read_resources. Add cache:content-read for cache 'c'.",
				problem: 'read-resources-not-permitted',
				detail: {
					read_resources: JSON.stringify([
						{
							type: 'cupboard_cache',
							actions: ['cache:content-read'],
							cache: { kind: 'named', name: 'c' }
						}
					])
				}
			}
		});
	});

	it('acquires exact content grants for several private caches in one session', async () => {
		const subject = await installTrustedIdp('admin');
		const ciCache = {
			kind: 'named' as const,
			name: cacheNameSchema.parse('ci')
		};
		const falconCache = {
			kind: 'named' as const,
			name: cacheNameSchema.parse('falcon')
		};
		const scopes: CacheScope[] = [{ kind: 'default' }, ciCache, falconCache];
		const administrator = await issueServerSignedToken(adminGrants());
		await putTestCache(administrator, ciCache, 'private');
		await putTestCache(administrator, falconCache, 'private');
		const resources = scopes.map((cache) => ({
			type: 'cupboard_cache' as const,
			cache,
			mode: 'content' as const
		}));
		const response = await postToken({
			grant_type: readAccessGrantType,
			subject_token: subject,
			subject_token_type: subjectTokenTypeIdToken,
			read_resources: JSON.stringify(resources)
		});
		const result = readAccessResponseSchema.parse(await response.json());
		const grants = scopes.map((cache) => ({
			type: 'cupboard_cache',
			cache,
			actions: ['cache:content-read']
		}));
		expect({
			status: response.status,
			expires: result.expires_in,
			refresh: result.refresh_token,
			grants: result.authorization_details,
			facts: result.read_resources,
			jwtGrants: decodeJwt(result.access_token).authorization_details
		}).toStrictEqual({
			status: 200,
			expires: 900,
			refresh: undefined,
			grants,
			facts: resources.map((resource) => ({
				...resource,
				state: {
					kind: 'existing',
					access: resource.cache.kind === 'default' ? 'public' : 'private',
					priority: 40
				}
			})),
			jwtGrants: grants
		});
	});

	it.each([undefined, 'legacy-rule'])(
		'accepts an existing read token with legacy audit rule %s without reacquisition',
		async (auditRule) => {
			const cache: CacheScope = {
				kind: 'named',
				name: cacheNameSchema.parse('legacy-private')
			};
			await putTestCache(
				await issueServerSignedToken(adminGrants()),
				cache,
				'private'
			);
			const token = await issueServerSignedToken(
				[{ type: 'cupboard_cache', cache, actions: ['cache:content-read'] }],
				'legacy-session',
				auditRule === undefined ? undefined : { cb_rule: auditRule }
			);
			const claims = decodeJwt(token);
			const isAuthorised = await currentServer().authoriseCacheContentRead(
				token,
				cache
			);
			expect({
				authorised: isAuthorised,
				rule: claims.cb_rule,
				rules: claims.cb_rules
			}).toStrictEqual({ authorised: true, rule: auditRule, rules: undefined });
		}
	);

	it.each(['content', 'metadata'] as const)(
		'keeps interactive read acquisition short-lived and read-only for %s intent',
		async (mode) => {
			const subject = await installTrustedIdp('admin');
			const response = await postToken({
				grant_type: readAccessGrantType,
				subject_token: subject,
				subject_token_type: subjectTokenTypeIdToken,
				read_resources: JSON.stringify([
					{ type: 'cupboard_cache', cache: { kind: 'default' }, mode }
				])
			});
			const token = readAccessResponseSchema.parse(await response.json());

			expect({
				lifetime: token.expires_in,
				refresh: token.refresh_token,
				grants: token.authorization_details
			}).toStrictEqual({
				lifetime: 900,
				refresh: undefined,
				grants: [
					{
						type: 'cupboard_cache',
						cache: { kind: 'default' },
						actions: [mode === 'content' ? 'cache:content-read' : 'cache:read']
					}
				]
			});
		}
	);

	it('issues metadata authority for an absent publication destination without creating it', async () => {
		const subject = await installTrustedIdp('write');
		const cache = { kind: 'named' as const, name: cacheNameSchema.parse('ci') };
		const response = await postToken({
			grant_type: readAccessGrantType,
			subject_token: subject,
			subject_token_type: subjectTokenTypeIdToken,
			read_resources: JSON.stringify([{ type: 'cupboard_cache', cache }])
		});

		expect(response.status).toBe(StatusCodes.OK);

		const result = readAccessResponseSchema.parse(await response.json());

		expect({
			expires: result.expires_in,
			refresh: result.refresh_token,
			grants: result.authorization_details,
			facts: result.read_resources,
			jwtGrants: decodeJwt(result.access_token).authorization_details
		}).toStrictEqual({
			expires: 900,
			refresh: undefined,
			grants: [{ type: 'cupboard_cache', cache, actions: ['cache:read'] }],
			facts: [
				{
					type: 'cupboard_cache',
					cache,
					mode: 'content',
					state: {
						kind: 'absent',
						firstWrite: { access: 'public', priority: 40 }
					}
				}
			],
			jwtGrants: [{ type: 'cupboard_cache', cache, actions: ['cache:read'] }]
		});

		const headers = {
			authorization: `Basic ${btoa(`cupboard-oidc:cupboard-access+jwt:${result.access_token}`)}`
		};
		const absent = await fetchPath('/cache/ci/nix-cache-info', { headers });

		expect(absent.status).toBe(StatusCodes.NOT_FOUND);

		await putTestCache(
			await issueServerSignedToken(adminGrants()),
			cache,
			'private'
		);

		const privateAcquisition = await postToken({
			grant_type: readAccessGrantType,
			subject_token: subject,
			subject_token_type: subjectTokenTypeIdToken,
			read_resources: JSON.stringify([{ type: 'cupboard_cache', cache }])
		});

		expect(privateAcquisition.status).toBe(StatusCodes.BAD_REQUEST);
	});
});

const trustClassGrants = {
	admin: [{ type: 'cupboard_wildcard' }],
	write: [
		{
			type: 'cupboard_cache',
			actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
			resources: {
				cache: { kind: 'named', exact: 'ci', validate: 'cacheName' }
			}
		}
	],
	'release-write': [
		{
			type: 'cupboard_cache',
			actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
			resources: {
				cache: { kind: 'named', exact: 'release', validate: 'cacheName' }
			}
		}
	],
	read: [
		{
			type: 'cupboard_cache',
			actions: ['cache:content-read'],
			resources: { cache: { kind: 'default' } }
		},
		{
			type: 'cupboard_view',
			actions: ['view:content-read'],
			resources: {
				view: { exact: 'sources', validate: 'reuseViewName' }
			}
		}
	]
} as const;

async function installTrustedIdp(
	scope: 'admin' | 'write' | 'release-write' | 'read',
	options: {
		failFirstFetches?: number;
		protectedType?: string;
		tokenAudience?: string | string[];
		azp?: string;
		issuer?: string;
		claims?: Readonly<Record<string, unknown>>;
	} = {}
): Promise<string> {
	const idp = await generateKeyPair('RS256', { extractable: true });
	const jwk = await exportJWK(idp.publicKey);
	const issuer = options.issuer ?? 'https://idp.test';
	const signer = new SignJWT({
		...options.claims,
		...(options.azp !== undefined && { azp: options.azp })
	});
	const subjectToken = await signer
		.setProtectedHeader({
			alg: 'RS256',
			kid: 'idp',
			...(options.protectedType !== undefined && {
				typ: options.protectedType
			})
		})
		.setIssuer(issuer)
		.setAudience(options.tokenAudience ?? 'cupboard-aud')
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
				issuer,
				audience: 'cupboard-aud',
				claimsJson: JSON.stringify({ sub: 'alice' }),
				permittedGrantsJson: JSON.stringify(trustClassGrants[scope]),
				createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
			})
			.run();
	});

	vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
		if (remainingFailures > 0) {
			remainingFailures -= 1;

			return Promise.reject(new Error('issuer fetch blip'));
		}
		const url = input instanceof Request ? input.url : String(input);

		if (url === `${issuer}/.well-known/openid-configuration`) {
			return Promise.resolve(
				Response.json({
					issuer,
					jwks_uri: `${issuer}/jwks`,
					authorization_endpoint: `${issuer}/authorize`,
					response_types_supported: ['id_token'],
					subject_types_supported: ['public'],
					id_token_signing_alg_values_supported: ['RS256']
				})
			);
		}

		if (url === `${issuer}/jwks`) {
			return Promise.resolve(
				Response.json({ keys: [{ ...jwk, kid: 'idp', alg: 'RS256' }] })
			);
		}

		return Promise.resolve(
			new Response('not found', { status: StatusCodes.NOT_FOUND })
		);
	});

	return subjectToken;
}

async function installAdditionalTrustRule(
	id: string,
	permittedGrants: readonly PermittedGrant[],
	options: {
		issuer?: string;
		audience?: string;
		claims?: Record<string, string>;
	} = {}
): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { oidcTrust } })
			.insert(oidcTrust)
			.values({
				id: trustRuleIdSchema.parse(id),
				issuer: options.issuer ?? 'https://idp.test',
				audience: options.audience ?? 'cupboard-aud',
				claimsJson: JSON.stringify(options.claims ?? { sub: 'alice' }),
				permittedGrantsJson: JSON.stringify(permittedGrants),
				createdAt: isoTimestampSchema.parse('2026-01-01T00:00:01.000Z')
			})
			.run();
	});
}

async function installTrustedOwner(): Promise<string> {
	const subjectToken = await installTrustedIdp('admin');

	await runInDurableObject(currentServer(), (_instance, state) => {
		const database = drizzle(state.storage, { schema: { oidcTrust } });

		database.transaction((transaction) => {
			transaction.delete(oidcTrust).where(eq(oidcTrust.id, ownerRuleId)).run();
			transaction
				.update(oidcTrust)
				.set({ id: ownerRuleId })
				.where(eq(oidcTrust.id, trustRuleIdSchema.parse('admin-rule')))
				.run();
		});
	});

	return subjectToken;
}

type SuccessfulTokenExchange = TokenResponseInput & { readonly status: number };

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

function namedCache(name: string): unknown {
	return { kind: 'named', name };
}

const ciRequest = [
	{
		type: 'cupboard_cache',
		actions: ['upload:commit'],
		cache: namedCache('ci')
	}
];

const releaseRequest = [
	{
		type: 'cupboard_cache',
		actions: ['upload:negotiate'],
		cache: namedCache('release')
	}
];

// Negotiates one upload for a cache with the issued token, so a test can see
// which caches the token actually opens.
function negotiateFor(token: string, cache: string): Promise<Response> {
	const path = uploadPathNegotiation(uploadMetadata({ fileSize: 1234 }));

	return authorisedFetch(`/cache/${cache}/uploads`, token, {
		body: JSON.stringify({ pushId: testPushId, paths: [path] }),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});
}

function refreshKeys(context: ServerContext): RefreshKeyContext {
	return {
		signingKey: pushIdSigningKey(context.env),
		tenant: context.requireTenant()
	};
}

function refreshTokenRows(): Promise<
	{
		id: string;
		activeMemberId: string;
		generation: number;
		expiresAt: string;
	}[]
> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		drizzle(state.storage, { schema: { refreshTokenFamilies } })
			.select({
				id: refreshTokenFamilies.id,
				activeMemberId: refreshTokenFamilies.activeMemberId,
				generation: refreshTokenFamilies.generation,
				expiresAt: refreshTokenFamilies.expiresAt
			})
			.from(refreshTokenFamilies)
			.all()
	);
}

function refreshTokenMemberRows(): Promise<
	{ id: string; familyId: string; generation: number }[]
> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		drizzle(state.storage, { schema: { refreshTokenMembers } })
			.select({
				id: refreshTokenMembers.id,
				familyId: refreshTokenMembers.familyId,
				generation: refreshTokenMembers.generation
			})
			.from(refreshTokenMembers)
			.orderBy(refreshTokenMembers.generation)
			.all()
	);
}

/**
 * Presents a refresh token to a token service in the tenant object. `fault`
 * runs first and can make the rotation fail. Returns the response, or the
 * error that the refresh throws.
 */
function refreshWithFault(
	refreshToken: string,
	fault: (authKeys: AuthKeysService, state: DurableObjectState) => void
): Promise<unknown> {
	return runInDurableObject(currentServer(), async (instance, state) => {
		const tenantIdentity = new TenantIdentityService(instance.context);
		const authKeys = new AuthKeysService(instance.context, tenantIdentity);
		const service = new TokenExchangeService(
			instance.context,
			authKeys,
			new OidcTrustService(instance.context, tenantIdentity)
		);
		const request = new Request(new URL('/token', currentOrigin()), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: refreshTokenGrantType,
				refresh_token: refreshToken
			}).toString()
		});

		fault(authKeys, state);

		try {
			return await service.handleToken(rootLogger(), request);
		} catch (error: unknown) {
			return error;
		}
	});
}

function refresh(refreshToken: string): Promise<Response> {
	return postToken({
		grant_type: refreshTokenGrantType,
		refresh_token: refreshToken
	});
}

async function staleRefreshOutcome(refreshToken: string): Promise<{
	readonly status: number;
	readonly error: string;
	readonly problem: string | undefined;
}> {
	const response = await refresh(refreshToken);
	const body = oauthErrorShape(await response.json());

	return {
		status: response.status,
		error: body.error,
		problem: body.problem
	};
}

describe('refresh grant', () => {
	beforeEach(resetTestServer);

	it('issues sealed client-contained refresh authority with only replay and owner metadata in active storage', async () => {
		const subject = await installTrustedIdp('admin');
		const response = await exchange(subject);
		const parts = response.refresh_token?.split('.') ?? [];
		expect(parts).toEqual([
			expect.any(String),
			expect.any(String),
			expect.any(String),
			expect.any(String)
		]);
		const stored = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const members = instance.context.db
					.select()
					.from(refreshTokenMembers)
					.all();

				return {
					tenant: instance.context.requireTenant(),
					families: instance.context.db
						.select()
						.from(refreshTokenFamilies)
						.all(),
					members,
					payload: await RefreshCredential.parse(
						response.refresh_token ?? ''
					)?.authenticate(
						members[0]?.credentialHash ?? '',
						refreshKeys(instance.context)
					)
				};
			}
		);
		const payload = stored.payload;
		const family = stored.families[0];
		if (family === undefined) {
			throw new Error('Expected a refresh family');
		}
		const identity = Object.fromEntries(
			Object.entries(decodeJwt(subject)).filter(
				([key, value]) => typeof value === 'string' || key === 'aud'
			)
		);
		expect({
			payload,
			familyFields: Object.keys(family).toSorted(byCodeUnit),
			memberFields: Object.keys(stored.members[0] ?? {}).toSorted(byCodeUnit)
		}).toStrictEqual({
			payload: {
				purpose: 'cupboard-refresh',
				version: 2,
				tenant: stored.tenant,
				familyId: family.id,
				memberId: family.activeMemberId,
				generation: 0,
				expiresAt: family.expiresAt,
				identity,
				grants: [{ type: 'cupboard_wildcard' }]
			},
			familyFields: [
				'activeMemberId',
				'createdAt',
				'expiresAt',
				'generation',
				'id',
				'issuer',
				'rule',
				'subject'
			],
			memberFields: [
				'createdAt',
				'credentialHash',
				'familyId',
				'generation',
				'id',
				'successorEnvelope',
				'successorExpiresAt'
			]
		});
	});

	it('records the owner of a family at issue and fills an unknown owner at rotation', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const familyOwners = (): Promise<unknown> =>
			runInDurableObject(currentServer(), (instance) =>
				instance.context.db
					.select()
					.from(refreshTokenFamilies)
					.all()
					.map((family) => ({
						issuer: family.issuer ?? undefined,
						subject: family.subject ?? undefined,
						rule: family.rule ?? undefined
					}))
			);
		const issued = await familyOwners();
		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec(
				'UPDATE refresh_session_family SET issuer = NULL, subject = NULL, rule = NULL'
			);
		});
		const unknown = await familyOwners();
		const rotated = await refresh(exchanged.refresh_token ?? '');
		await rotated.text();
		const owner = {
			issuer: 'https://idp.test',
			subject: 'alice',
			rule: 'admin-rule'
		};

		expect({
			issued,
			unknown,
			status: rotated.status,
			rotated: await familyOwners()
		}).toStrictEqual({
			issued: [owner],
			unknown: [{ issuer: undefined, subject: undefined, rule: undefined }],
			status: StatusCodes.OK,
			rotated: [owner]
		});
	});

	it.each(['rotation', 'retry'] as const)(
		'renews %s under equivalent current policy after the original rule is removed',
		async (mode) => {
			const original = await exchange(await installTrustedIdp('admin'));
			if (mode === 'retry') {
				const first = await refresh(original.refresh_token ?? '');
				expect(first.status).toBe(200);
				await first.text();
			}
			await runInDurableObject(currentServer(), async (instance) => {
				const trust = new OidcTrustService(
					instance.context,
					new TenantIdentityService(instance.context)
				);
				const existing = trust.getRule(trustRuleIdSchema.parse('admin-rule'));
				trust.removeRule(existing.id);
				await trust.addRule({
					issuer: existing.issuer,
					audience: existing.audience,
					claims: existing.claims,
					permittedGrants: existing.permittedGrants
				});
			});
			const renewed = await refresh(original.refresh_token ?? '');
			expect({
				status: renewed.status,
				grants: tokenResponseSchema.safeParse(await renewed.json()).data
					?.authorization_details
			}).toStrictEqual({
				status: 200,
				grants: [{ type: 'cupboard_wildcard' }]
			});
		}
	);

	it.each([
		{ operation: 'cache:close', explicitRead: false, permitted: true },
		{ operation: 'cache:read', explicitRead: false, permitted: false },
		{ operation: 'cache:content-read', explicitRead: false, permitted: false },
		{ operation: 'cache:close', explicitRead: true, permitted: true },
		{ operation: 'cache:read', explicitRead: true, permitted: true },
		{ operation: 'cache:content-read', explicitRead: true, permitted: false }
	])(
		'checks close-only $operation during issuance, attenuation and refresh (explicit metadata read: $explicitRead)',
		async ({ operation, explicitRead, permitted }) => {
			const cache = namedCache('gh-1234-pr-7');
			const actions = explicitRead
				? ['cache:close', 'cache:read']
				: ['cache:close'];
			const ceiling = [{ type: 'cupboard_cache', cache, actions }];
			const requested = [
				{ type: 'cupboard_cache', cache, actions: [operation] }
			];
			const subject = await installTrustedIdp('admin');
			const original = await exchange(subject, ceiling);
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.delete(oidcTrust)
					.where(eq(oidcTrust.id, trustRuleIdSchema.parse('admin-rule')))
					.run();
			});
			await installAdditionalTrustRule(
				'close-pattern',
				storedPermittedGrantsSchema.parse([
					{
						type: 'cupboard_cache',
						actions,
						resources: {
							cache: {
								kind: 'named',
								pattern: '^gh-1234-pr-[0-9]+$',
								validate: 'cacheName'
							}
						}
					}
				])
			);
			const issuance = await postToken({
				grant_type: tokenExchangeGrantType,
				subject_token: subject,
				subject_token_type: subjectTokenTypeIdToken,
				authorization_details: JSON.stringify(requested)
			});
			const attenuation = await attenuate(original.access_token, requested);
			const refreshed = await postToken({
				grant_type: refreshTokenGrantType,
				refresh_token: original.refresh_token ?? '',
				authorization_details: JSON.stringify(requested)
			});
			const outcomes = [];
			for (const response of [issuance, attenuation, refreshed]) {
				outcomes.push({
					status: response.status,
					grants: tokenResponseSchema.safeParse(await response.json()).data
						?.authorization_details
				});
			}
			const expected = {
				status: permitted ? 200 : 400,
				grants: permitted ? requested : undefined
			};
			expect(outcomes).toStrictEqual([expected, expected, expected]);
		}
	);

	it('rechecks named-cache patterns when a refresh session rotates', async () => {
		const requested = [
			{
				type: 'cupboard_cache',
				cache: namedCache('gh-1234-pr-7'),
				actions: ['cache:close']
			}
		];
		const original = await exchange(
			await installTrustedIdp('admin'),
			requested
		);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.delete(oidcTrust)
				.where(eq(oidcTrust.id, trustRuleIdSchema.parse('admin-rule')))
				.run();
		});
		await installAdditionalTrustRule('pattern-close', [
			{
				type: 'cupboard_cache',
				actions: ['cache:close'],
				resources: {
					cache: {
						kind: 'named',
						pattern: '^gh-1234-pr-[0-9]+$',
						validate: 'cacheName'
					}
				}
			}
		]);
		const renewed = await refresh(original.refresh_token ?? '');
		const body = tokenResponseSchema.parse(await renewed.json());
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(oidcTrust)
				.set({
					permittedGrantsJson: JSON.stringify([
						{
							type: 'cupboard_cache',
							actions: ['cache:close'],
							resources: {
								cache: {
									kind: 'named',
									pattern: '^gh-9999-pr-[0-9]+$',
									validate: 'cacheName'
								}
							}
						}
					])
				})
				.where(eq(oidcTrust.id, trustRuleIdSchema.parse('pattern-close')))
				.run();
		});
		expect({
			originalStatus: original.status,
			renewedStatus: renewed.status,
			grants: body.authorization_details,
			revoked: await staleRefreshOutcome(body.refresh_token ?? '')
		}).toStrictEqual({
			originalStatus: 200,
			renewedStatus: 200,
			grants: requested,
			revoked: {
				status: 400,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			}
		});
	});

	it('rotates a version 1 credential into a sealed version 2 credential', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const legacy = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const credential = RefreshCredential.parse(
					exchanged.refresh_token ?? ''
				);
				const member = instance.context.db
					.select()
					.from(refreshTokenMembers)
					.get();
				const authority = await credential?.authenticate(
					member?.credentialHash ?? '',
					refreshKeys(instance.context)
				);
				if (member === undefined || authority === undefined) {
					throw new Error('Expected authenticated authority');
				}
				const json = JSON.stringify({
					...authority,
					version: 1,
					identity: refreshPolicyIdentity(authority.identity)
				});
				const readable = bytesToBase64Url(new TextEncoder().encode(json));
				const value = `${member.id}.${'a'.repeat(64)}.${readable}`;
				instance.context.db
					.update(refreshTokenMembers)
					.set({ credentialHash: await sha256Hex(value) })
					.where(eq(refreshTokenMembers.id, member.id))
					.run();
				return value;
			}
		);
		const response = await refresh(legacy);
		const result = tokenResponseSchema.parse(await response.json());
		const families = await refreshTokenRows();

		expect({
			status: response.status,
			successorSegments: result.refresh_token?.split('.').length,
			generations: families.map((row) => row.generation)
		}).toStrictEqual({
			status: StatusCodes.OK,
			successorSegments: 4,
			generations: [1]
		});
	});

	it('redeems and rotates an issued credential near the request size limit', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const large = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const credential = RefreshCredential.parse(
					exchanged.refresh_token ?? ''
				);
				if (credential === undefined) {
					throw new Error('Expected refresh credential');
				}
				const member = instance.context.db
					.select()
					.from(refreshTokenMembers)
					.where(eq(refreshTokenMembers.id, credential.id))
					.get();
				if (member === undefined) {
					throw new Error('Expected refresh member');
				}
				const authority = await credential.authenticate(
					member.credentialHash,
					refreshKeys(instance.context)
				);
				if (authority === undefined) {
					throw new Error('Expected authenticated authority');
				}
				const large = await RefreshCredential.issue(
					{
						...authority,
						identity: {
							...refreshPolicyIdentity(authority.identity),
							extraClaim: 'x'.repeat(48_000)
						}
					},
					refreshKeys(instance.context)
				);
				instance.context.db
					.update(refreshTokenMembers)
					.set({ credentialHash: await sha256Hex(large.value) })
					.where(eq(refreshTokenMembers.id, member.id))
					.run();
				return large.value;
			}
		);
		const response = await refresh(large);
		const result = tokenResponseSchema.parse(await response.json());
		expect({
			status: response.status,
			nearLimit: large.length > refreshCredentialMaxBytes - 1500,
			withinLimit:
				(result.refresh_token?.length ?? Infinity) <= refreshCredentialMaxBytes,
			successorSegments: result.refresh_token?.split('.').length,
			grants: result.authorization_details
		}).toStrictEqual({
			status: 200,
			nearLimit: true,
			withinLimit: true,
			successorSegments: 4,
			grants: [{ type: 'cupboard_wildcard' }]
		});
	});

	it('rotates an admin refresh token and rejects its replay', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);

		const refreshed = await refresh(exchanged.refresh_token ?? '');
		const refreshedBody = tokenResponseSchema.parse(await refreshed.json());
		const claims = decodeJwt(refreshedBody.access_token);

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
			grantsClaim: claims.authorization_details
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
			grantsClaim: [{ type: 'cupboard_wildcard' }]
		});
	});

	it('refuses a refresh token whose replay state was removed', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		const refreshToken = exchanged.refresh_token ?? '';

		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec('DELETE FROM refresh_session_member');
			state.storage.sql.exec('DELETE FROM refresh_session_family');
		});

		expect(await staleRefreshOutcome(refreshToken)).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_grant',
			problem: 'stale-refresh-token'
		});
	});

	it('returns the issued successor when a consumed token is retried', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		const refreshToken = exchanged.refresh_token ?? '';
		const first = await refresh(refreshToken);
		const firstBody = tokenResponseSchema.parse(await first.json());
		const successor = firstBody.refresh_token ?? '';

		const capture = startCapture();
		let replay;

		try {
			const response = await refresh(refreshToken);
			replay = {
				status: response.status,
				body: tokenResponseSchema.parse(await response.json())
			};
		} finally {
			capture.stop();
		}

		const revocations = capture.logs
			.filter((entry) => entry.message === 'refresh-token family revoked')
			.map((entry) => ({
				level: entry.level,
				properties: entry.properties
			}));
		const rows = await refreshTokenRows();

		expect({
			firstStatus: first.status,
			replay: {
				status: replay.status,
				refreshToken: replay.body.refresh_token,
				grants: replay.body.authorization_details
			},
			revocations,
			rows: rows.map((row) => ({
				activeMemberId: row.activeMemberId,
				generation: row.generation
			}))
		}).toStrictEqual({
			firstStatus: StatusCodes.OK,
			replay: {
				status: StatusCodes.OK,
				refreshToken: successor,
				grants: [{ type: 'cupboard_wildcard' }]
			},
			revocations: [],
			rows: [{ activeMemberId: successor.split('.', 2)[0], generation: 1 }]
		});
	});

	it('accepts a retry at the grace deadline and revokes one millisecond later', async () => {
		vi.useFakeTimers();

		try {
			const startedAt = new Date('2026-01-01T00:00:00.000Z');
			vi.setSystemTime(startedAt);
			const exchanged = await exchange(await installTrustedIdp('admin'));
			const original = exchanged.refresh_token ?? '';
			const firstResponse = await refresh(original);
			const first = tokenResponseSchema.parse(await firstResponse.json());

			vi.setSystemTime(new Date(startedAt.getTime() + 60_000));
			const deadlineResponse = await refresh(original);
			const atDeadline = tokenResponseSchema.parse(
				await deadlineResponse.json()
			);

			vi.setSystemTime(new Date(startedAt.getTime() + 60_001));
			const late = await staleRefreshOutcome(original);
			const successor = await staleRefreshOutcome(first.refresh_token ?? '');

			expect({
				atDeadline: atDeadline.refresh_token,
				late,
				successor,
				families: await refreshTokenRows()
			}).toStrictEqual({
				atDeadline: first.refresh_token,
				late: {
					status: StatusCodes.BAD_REQUEST,
					error: 'invalid_grant',
					problem: 'stale-refresh-token'
				},
				successor: {
					status: StatusCodes.BAD_REQUEST,
					error: 'invalid_grant',
					problem: 'stale-refresh-token'
				},
				families: []
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('refuses a retry that finishes after the grace deadline', async () => {
		vi.useFakeTimers();

		try {
			const startedAt = new Date('2026-01-01T00:00:00.000Z');
			vi.setSystemTime(startedAt);
			const exchanged = await exchange(await installTrustedIdp('admin'));
			const original = exchanged.refresh_token ?? '';
			await refresh(original);

			const result = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const identity = new TenantIdentityService(instance.context);
					const authKeys = new AuthKeysService(instance.context, identity);
					const service = new TokenExchangeService(
						instance.context,
						authKeys,
						new OidcTrustService(instance.context, identity)
					);
					const activeAuthKey = authKeys.activeAuthKey.bind(authKeys);
					const spy = vi
						.spyOn(authKeys, 'activeAuthKey')
						.mockImplementation(() => {
							vi.setSystemTime(new Date(startedAt.getTime() + 60_001));

							return activeAuthKey();
						});
					const request = new Request(new URL('/token', currentOrigin()), {
						method: 'POST',
						headers: { 'content-type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({
							grant_type: refreshTokenGrantType,
							refresh_token: original
						}).toString()
					});

					try {
						return await service.handleToken(rootLogger(), request);
					} catch (error) {
						return error;
					} finally {
						spy.mockRestore();
					}
				}
			);

			expect({
				stale: result instanceof StaleRefreshTokenError,
				families: await refreshTokenRows()
			}).toStrictEqual({
				stale: true,
				families: []
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not recover a random successor issued before the grace policy', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const original = exchanged.refresh_token ?? '';
		const firstResponse = await refresh(original);
		const first = tokenResponseSchema.parse(await firstResponse.json());
		const [originalId] = z
			.tuple([z.uuid(), z.string(), z.string(), z.string()])
			.parse(original.split('.'));

		await runInDurableObject(currentServer(), (_instance, state) => {
			drizzle(state.storage, { schema: { refreshTokenMembers } })
				.update(refreshTokenMembers)
				.set({ successorEnvelope: sql`NULL` })
				.where(eq(refreshTokenMembers.id, originalId))
				.run();
		});

		const replay = await staleRefreshOutcome(original);
		const successorResponse = await refresh(first.refresh_token ?? '');
		const successor = tokenResponseSchema.parse(await successorResponse.json());
		const families = await refreshTokenRows();

		expect({
			replay,
			successorStatus: successorResponse.status,
			successorRotated: successor.refresh_token !== first.refresh_token,
			generations: families.map((row) => row.generation)
		}).toStrictEqual({
			replay: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			successorStatus: StatusCodes.OK,
			successorRotated: true,
			generations: [2]
		});
	});

	it('keeps the successor usable when its recovery envelope is corrupted', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const original = exchanged.refresh_token ?? '';
		const firstResponse = await refresh(original);
		const first = tokenResponseSchema.parse(await firstResponse.json());
		const [originalId] = z
			.tuple([z.uuid(), z.string(), z.string(), z.string()])
			.parse(original.split('.'));

		await runInDurableObject(currentServer(), (_instance, state) => {
			drizzle(state.storage, { schema: { refreshTokenMembers } })
				.update(refreshTokenMembers)
				.set({ successorEnvelope: `${'0'.repeat(24)}.${'0'.repeat(160)}` })
				.where(eq(refreshTokenMembers.id, originalId))
				.run();
		});

		const replay = await staleRefreshOutcome(original);
		const successorResponse = await refresh(first.refresh_token ?? '');
		const successor = tokenResponseSchema.parse(await successorResponse.json());
		const families = await refreshTokenRows();

		expect({
			replay,
			successorStatus: successorResponse.status,
			successorRotated: successor.refresh_token !== first.refresh_token,
			generations: families.map((row) => row.generation)
		}).toStrictEqual({
			replay: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			successorStatus: StatusCodes.OK,
			successorRotated: true,
			generations: [2]
		});
	});

	it.each([
		{ failing: 'authority', successfulDecryptions: 0 },
		{ failing: 'successor envelope', successfulDecryptions: 1 }
	])(
		'keeps the family when $failing decryption fails internally',
		async ({ successfulDecryptions }) => {
			const exchanged = await exchange(await installTrustedIdp('admin'));
			const original = exchanged.refresh_token ?? '';
			const firstResponse = await refresh(original);
			const first = tokenResponseSchema.parse(await firstResponse.json());
			const failure = new TypeError('Web Crypto is unavailable');
			const result = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const identity = new TenantIdentityService(instance.context);
					const service = new TokenExchangeService(
						instance.context,
						new AuthKeysService(instance.context, identity),
						new OidcTrustService(instance.context, identity)
					);
					const request = new Request(new URL('/token', currentOrigin()), {
						method: 'POST',
						headers: { 'content-type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({
							grant_type: refreshTokenGrantType,
							refresh_token: original
						}).toString()
					});
					const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
					const spy = vi.spyOn(crypto.subtle, 'decrypt');

					for (let call = 0; call < successfulDecryptions; call += 1) {
						spy.mockImplementationOnce(decrypt);
					}

					spy.mockRejectedValueOnce(failure);

					try {
						return await service.handleToken(rootLogger(), request);
					} catch (error) {
						return error;
					} finally {
						spy.mockRestore();
					}
				}
			);
			const successorResponse = await refresh(first.refresh_token ?? '');
			const successor = tokenResponseSchema.parse(
				await successorResponse.json()
			);
			const families = await refreshTokenRows();

			expect({
				internalFailure: result instanceof TypeError,
				successorStatus: successorResponse.status,
				successorRotated: successor.refresh_token !== first.refresh_token,
				familyGenerations: families.map((family) => family.generation)
			}).toStrictEqual({
				internalFailure: true,
				successorStatus: StatusCodes.OK,
				successorRotated: true,
				familyGenerations: [2]
			});
		}
	);

	it('ends the refresh session when the deployment key changes', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const original = exchanged.refresh_token ?? '';
		const firstResponse = await refresh(original);
		const first = tokenResponseSchema.parse(await firstResponse.json());
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const identity = new TenantIdentityService(instance.context);
				const service = new TokenExchangeService(
					instance.context,
					new AuthKeysService(instance.context, identity),
					new OidcTrustService(instance.context, identity)
				);
				const originalEnv = instance.context.env;
				instance.context.env = {
					...originalEnv,
					PUSH_ID_SIGNING_KEY: 'replacement-deployment-key'
				};
				const refreshWithChangedKey = (token: string) => {
					const request = new Request(new URL('/token', currentOrigin()), {
						method: 'POST',
						headers: { 'content-type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({
							grant_type: refreshTokenGrantType,
							refresh_token: token
						}).toString()
					});

					return service.handleToken(rootLogger(), request);
				};

				try {
					let recoveryError: unknown;

					try {
						await refreshWithChangedKey(original);
					} catch (error) {
						recoveryError = error;
					}

					let successorError: unknown;

					try {
						await refreshWithChangedKey(first.refresh_token ?? '');
					} catch (error) {
						successorError = error;
					}

					return {
						recoveryRejected: recoveryError instanceof StaleRefreshTokenError,
						successorRejected: successorError instanceof StaleRefreshTokenError
					};
				} finally {
					instance.context.env = originalEnv;
				}
			}
		);

		const families = await refreshTokenRows();

		expect({
			...outcome,
			generations: families.map((row) => row.generation)
		}).toStrictEqual({
			recoveryRejected: true,
			successorRejected: true,
			generations: [1]
		});
	});

	it('refuses grace recovery after the trust rule loses interactive authority', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const original = exchanged.refresh_token ?? '';
		const firstResponse = await refresh(original);
		const first = tokenResponseSchema.parse(await firstResponse.json());

		await runInDurableObject(currentServer(), (_instance, state) => {
			drizzle(state.storage, { schema: { oidcTrust } })
				.update(oidcTrust)
				.set({ permittedGrantsJson: JSON.stringify(trustClassGrants.write) })
				.where(eq(oidcTrust.id, trustRuleIdSchema.parse('admin-rule')))
				.run();
		});

		expect({
			replay: await staleRefreshOutcome(original),
			successor: await staleRefreshOutcome(first.refresh_token ?? ''),
			families: await refreshTokenRows()
		}).toStrictEqual({
			replay: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			successor: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			families: []
		});
	});

	it('does not return a successor for a different grant request', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const original = exchanged.refresh_token ?? '';
		const narrowed = [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: namedCache('pr-1')
			}
		];
		const firstResponse = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: original,
			authorization_details: JSON.stringify(narrowed)
		});
		const first = tokenResponseSchema.parse(await firstResponse.json());
		const mismatched = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: original,
			authorization_details: JSON.stringify(adminGrants())
		});
		const matchedResponse = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: original,
			authorization_details: JSON.stringify(narrowed)
		});
		const matched = tokenResponseSchema.parse(await matchedResponse.json());
		const implicitResponse = await refresh(original);
		const implicitRetry = tokenResponseSchema.parse(
			await implicitResponse.json()
		);
		const families = await refreshTokenRows();

		expect({
			mismatched: {
				status: mismatched.status,
				problem: oauthErrorShape(await mismatched.json()).problem
			},
			implicitRetry: {
				refreshToken: implicitRetry.refresh_token,
				grants: implicitRetry.authorization_details
			},
			matched: {
				refreshToken: matched.refresh_token,
				grants: matched.authorization_details
			},
			families: families.map((family) => ({
				generation: family.generation
			}))
		}).toStrictEqual({
			mismatched: {
				status: StatusCodes.BAD_REQUEST,
				problem: 'stale-refresh-token'
			},
			implicitRetry: { refreshToken: first.refresh_token, grants: narrowed },
			matched: {
				refreshToken: first.refresh_token,
				grants: narrowed
			},
			families: [{ generation: 1 }]
		});
	});

	it('accepts a retry with equivalent grant ordering', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const original = exchanged.refresh_token ?? '';
		const firstGrants = [
			{
				type: 'cupboard_cache',
				actions: ['upload:negotiate', 'upload:commit'],
				cache: namedCache('pr-1')
			}
		];
		const reorderedGrants = [
			{
				...firstGrants[0],
				actions: ['upload:commit', 'upload:negotiate']
			}
		];
		const firstResponse = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: original,
			authorization_details: JSON.stringify(firstGrants)
		});
		const first = tokenResponseSchema.parse(await firstResponse.json());
		const replayResponse = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: original,
			authorization_details: JSON.stringify(reorderedGrants)
		});
		const replay = tokenResponseSchema.parse(await replayResponse.json());

		expect({
			status: replayResponse.status,
			refreshToken: replay.refresh_token,
			grants: replay.authorization_details
		}).toStrictEqual({
			status: StatusCodes.OK,
			refreshToken: first.refresh_token,
			grants: first.authorization_details
		});
	});

	it('revokes the active family member when an earlier generation is replayed', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		const original = exchanged.refresh_token ?? '';
		const firstResponse = await refresh(original);
		const first = tokenResponseSchema.parse(await firstResponse.json());
		const firstSuccessor = first.refresh_token ?? '';
		const secondResponse = await refresh(firstSuccessor);
		const second = tokenResponseSchema.parse(await secondResponse.json());
		const active = second.refresh_token ?? '';
		const [activeMemberId] = z
			.tuple([z.uuid(), z.string(), z.string(), z.string()])
			.parse(active.split('.'));
		const beforeReplay = {
			families: await refreshTokenRows(),
			members: await refreshTokenMemberRows()
		};

		const replay = await staleRefreshOutcome(original);
		const activeAfterReplay = await staleRefreshOutcome(active);

		expect({
			beforeReplay: {
				families: beforeReplay.families.map((family) => ({
					activeMemberId: family.activeMemberId,
					generation: family.generation
				})),
				memberGenerations: beforeReplay.members.map(
					(member) => member.generation
				)
			},
			replay,
			activeAfterReplay,
			families: await refreshTokenRows(),
			members: await refreshTokenMemberRows()
		}).toStrictEqual({
			beforeReplay: {
				families: [{ activeMemberId, generation: 2 }],
				memberGenerations: [0, 1, 2]
			},
			replay: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			activeAfterReplay: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			families: [],
			members: []
		});
	});

	it('removes the previous recovery envelope on the next rotation', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const original = exchanged.refresh_token ?? '';
		const firstResponse = await refresh(original);
		const first = tokenResponseSchema.parse(await firstResponse.json());
		const firstSuccessor = first.refresh_token ?? '';
		await refresh(firstSuccessor);

		const envelopes = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				state.storage.sql
					.exec(
						'SELECT generation, successor_envelope FROM refresh_session_member ORDER BY generation'
					)
					.toArray()
		);

		expect(
			envelopes.map((row) => ({
				generation: row.generation,
				envelopePresent: typeof row.successor_envelope === 'string'
			}))
		).toStrictEqual([
			{ generation: 0, envelopePresent: false },
			{ generation: 1, envelopePresent: true },
			{ generation: 2, envelopePresent: false }
		]);
	});

	it('ends a refresh family at its original deadline', async () => {
		vi.useFakeTimers();

		try {
			const startedAt = new Date('2026-01-01T00:00:00.000Z');
			vi.setSystemTime(startedAt);
			const subjectToken = await installTrustedIdp('admin');
			const exchanged = await exchange(subjectToken);
			const [initialFamily] = z
				.tuple([z.object({ expiresAt: z.string() })])
				.parse(await refreshTokenRows());

			vi.setSystemTime(
				new Date(
					startedAt.getTime() + refreshTokenFamilyTtlSeconds * 1000 - 60_000
				)
			);
			const refreshed = await refresh(exchanged.refresh_token ?? '');
			const refreshedBody = tokenResponseSchema.parse(await refreshed.json());
			const [rotatedFamily] = z
				.tuple([z.object({ expiresAt: z.string() })])
				.parse(await refreshTokenRows());

			vi.setSystemTime(
				new Date(startedAt.getTime() + refreshTokenFamilyTtlSeconds * 1000)
			);
			const afterDeadline = await staleRefreshOutcome(
				refreshedBody.refresh_token ?? ''
			);

			expect({
				initialDeadline: initialFamily.expiresAt,
				rotatedDeadline: rotatedFamily.expiresAt,
				afterDeadline,
				families: await refreshTokenRows(),
				members: await refreshTokenMemberRows()
			}).toStrictEqual({
				initialDeadline: '2026-01-31T00:00:00.000Z',
				rotatedDeadline: '2026-01-31T00:00:00.000Z',
				afterDeadline: {
					status: StatusCodes.BAD_REQUEST,
					error: 'invalid_grant',
					problem: 'stale-refresh-token'
				},
				families: [],
				members: []
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('stores a successor envelope without either bearer secret', async () => {
		vi.useFakeTimers();

		try {
			vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
			const subjectToken = await installTrustedIdp('admin');
			const exchanged = await exchange(subjectToken);
			const original = exchanged.refresh_token ?? '';
			const refreshedResponse = await refresh(original);
			const refreshed = tokenResponseSchema.parse(
				await refreshedResponse.json()
			);
			const successor = refreshed.refresh_token ?? '';
			const [originalId, originalSecret] = z
				.tuple([z.uuid(), z.string().min(1), z.string(), z.string()])
				.parse(original.split('.'));
			const [successorId, successorSecret] = z
				.tuple([z.uuid(), z.string().min(1), z.string(), z.string()])
				.parse(successor.split('.'));
			const hash = async (secret: string): Promise<string> =>
				[
					...new Uint8Array(
						await crypto.subtle.digest(
							'SHA-256',
							new TextEncoder().encode(secret)
						)
					)
				]
					.map((byte) => byte.toString(16).padStart(2, '0'))
					.join('');
			const [originalHash, successorHash] = await Promise.all([
				hash(original),
				hash(successor)
			]);
			const persisted = await runInDurableObject(
				currentServer(),
				(_instance, state) => ({
					families: state.storage.sql
						.exec(
							'SELECT id, active_member_id, generation, created_at, expires_at FROM refresh_session_family'
						)
						.toArray(),
					members: state.storage.sql
						.exec('SELECT * FROM refresh_session_member ORDER BY generation')
						.toArray(),
					legacy: {
						live: state.storage.sql
							.exec('SELECT id FROM refresh_token ORDER BY id')
							.toArray()
					}
				})
			);
			const serialised = JSON.stringify(persisted);
			const envelope = persisted.members[0]?.successor_envelope;
			const persistedView = {
				...persisted,
				members: persisted.members.map((member) => ({
					...member,
					successor_expires_at: member.successor_expires_at ?? undefined,
					successor_envelope: typeof member.successor_envelope
				}))
			};

			expect({
				persisted: persistedView,
				containsOriginalSecret: serialised.includes(originalSecret),
				containsSuccessorSecret: serialised.includes(successorSecret),
				envelopeFormat:
					typeof envelope === 'string' &&
					/^[\da-f]{24}\.(?:[\da-f]{2}){17,}$/u.test(envelope)
			}).toStrictEqual({
				persisted: {
					families: [
						{
							id: persisted.families[0]?.id,
							active_member_id: successorId,
							generation: 1,
							created_at: '2026-01-01T00:00:00.000Z',
							expires_at: '2026-01-31T00:00:00.000Z'
						}
					],
					members: [
						{
							id: originalId,
							family_id: persisted.families[0]?.id,
							generation: 0,
							credential_hash: originalHash,
							successor_envelope: 'string',
							successor_expires_at: '2026-01-01T00:01:00.000Z',
							created_at: '2026-01-01T00:00:00.000Z'
						},
						{
							id: successorId,
							family_id: persisted.families[0]?.id,
							generation: 1,
							credential_hash: successorHash,
							successor_envelope: 'object',
							successor_expires_at: undefined,
							created_at: '2026-01-01T00:00:00.000Z'
						}
					],
					legacy: { live: [] }
				},
				containsOriginalSecret: false,
				containsSuccessorSecret: false,
				envelopeFormat: true
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not accept a token stored only in the retained legacy table', async () => {
		await installTrustedIdp('admin');
		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO refresh_token (id, secret_hash, rule_id, subject, created_at, expires_at) VALUES ('legacy', 'unused-hash', 'admin-rule', 'alice', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')"
			);
		});

		expect(await staleRefreshOutcome('legacy.old-secret')).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_grant',
			problem: 'stale-refresh-token'
		});
	});

	it('fails closed for a family inserted by the preceding worker', async () => {
		await installTrustedIdp('admin');
		const memberId = 'preceding-member';
		const familyId = 'preceding-family';
		const secret = 'preceding-secret';
		const secretHash = await sha256Hex(secret);

		await runInDurableObject(currentServer(), async (_instance, state) => {
			await migrateThrough(state, latestMigrationIndex);
			state.storage.sql.exec(
				"INSERT INTO refresh_token_family (id, active_member_id, generation, rule_id, subject, created_at, expires_at) VALUES (?, ?, 0, 'admin-rule', 'alice', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')",
				familyId,
				memberId
			);
			state.storage.sql.exec(
				"INSERT INTO refresh_token_member (id, family_id, generation, secret_hash, created_at) VALUES (?, ?, 0, ?, '2026-01-01T00:00:00.000Z')",
				memberId,
				familyId,
				secretHash
			);
		});

		expect({
			outcome: await staleRefreshOutcome(`${memberId}.${secret}`),
			families: await refreshTokenRows(),
			members: await refreshTokenMemberRows()
		}).toStrictEqual({
			outcome: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			families: [],
			members: []
		});
	});

	it('revokes a rapidly rotated family at its member bound', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		let original = exchanged.refresh_token ?? '';
		const [originalMemberId] = z
			.tuple([z.uuid(), z.string(), z.string(), z.string()])
			.parse(original.split('.'));

		await runInDurableObject(currentServer(), (_instance, state) => {
			const [family] = z
				.tuple([z.object({ id: z.string(), createdAt: z.string() })])
				.parse(
					drizzle(state.storage, { schema: { refreshTokenFamilies } })
						.select()
						.from(refreshTokenFamilies)
						.all()
				);
			const activeGeneration = maxRefreshTokenFamilyMembers - 2;

			state.storage.sql.exec(
				'UPDATE refresh_session_family SET generation = ? WHERE id = ?',
				activeGeneration,
				family.id
			);
			state.storage.sql.exec(
				'UPDATE refresh_session_member SET generation = ? WHERE id = ?',
				activeGeneration,
				originalMemberId
			);
			state.storage.sql.exec(
				`WITH digits(digit) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)),
				 generations(value) AS (
				   SELECT ones.digit + tens.digit * 10 + hundreds.digit * 100 + thousands.digit * 1000
				   FROM digits AS ones
				   CROSS JOIN digits AS tens
				   CROSS JOIN digits AS hundreds
				   CROSS JOIN digits AS thousands
				 )
				 INSERT INTO refresh_session_member (id, family_id, generation, credential_hash, created_at)
				 SELECT printf('spent-%d', value), ?, value, lower(hex(randomblob(32))), ?
				 FROM generations
				 WHERE value < ?`,
				family.id,
				family.createdAt,
				activeGeneration
			);
		});

		original = await runInDurableObject(currentServer(), async (instance) => {
			const credential = RefreshCredential.parse(original);
			const member = instance.context.db
				.select()
				.from(refreshTokenMembers)
				.where(eq(refreshTokenMembers.id, originalMemberId))
				.get();
			if (credential === undefined || member === undefined) {
				throw new Error('Expected refresh member');
			}
			const authority = await credential.authenticate(
				member.credentialHash,
				refreshKeys(instance.context)
			);
			if (authority === undefined) {
				throw new Error('Expected authenticated refresh authority');
			}
			const updated = await RefreshCredential.issue(
				{
					...authority,
					identity: refreshPolicyIdentity(authority.identity),
					generation: maxRefreshTokenFamilyMembers - 2
				},
				refreshKeys(instance.context)
			);
			instance.context.db
				.update(refreshTokenMembers)
				.set({ credentialHash: await sha256Hex(updated.value) })
				.where(eq(refreshTokenMembers.id, originalMemberId))
				.run();
			return updated.value;
		});
		const lastAllowedResponse = await refresh(original);
		const lastAllowed = tokenResponseSchema.parse(
			await lastAllowedResponse.json()
		);
		const atBound = await refreshTokenMemberRows();
		const capture = startCapture();
		let beyondBound;

		try {
			beyondBound = await staleRefreshOutcome(lastAllowed.refresh_token ?? '');
		} finally {
			capture.stop();
		}

		const revocations = capture.logs
			.filter((entry) => entry.message === 'refresh-token family revoked')
			.map((entry) => ({
				level: entry.level,
				properties: entry.properties
			}));

		expect({
			lastAllowedStatus: lastAllowedResponse.status,
			membersAtBound: atBound.length,
			lastGeneration: atBound.at(-1)?.generation,
			beyondBound,
			revocations,
			families: await refreshTokenRows(),
			members: await refreshTokenMemberRows()
		}).toStrictEqual({
			lastAllowedStatus: StatusCodes.OK,
			membersAtBound: maxRefreshTokenFamilyMembers,
			lastGeneration: maxRefreshTokenFamilyMembers - 1,
			beyondBound: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			revocations: [
				{
					level: 'warning',
					properties: {
						method: 'POST',
						path: '/token',
						reason: 'member-limit'
					}
				}
			],
			families: [],
			members: []
		});
	});

	it('returns one successor to concurrent presentations of a refresh token', async () => {
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
						const body = tokenResponseSchema.parse(await response.json());

						return {
							status: response.status,
							refreshToken: body.refresh_token ?? ''
						};
					})
				);
			}
		);
		const [first, second] = z
			.tuple([
				z.object({ status: z.number(), refreshToken: z.string() }),
				z.object({ status: z.number(), refreshToken: z.string() })
			])
			.parse(outcomes);
		const [firstId] = z
			.tuple([z.uuid(), z.string(), z.string(), z.string()])
			.parse(first.refreshToken.split('.'));
		const families = await refreshTokenRows();
		const members = await refreshTokenMemberRows();

		expect({
			exchangeStatus: exchanged.status,
			statuses: [first.status, second.status],
			sameSuccessor: first.refreshToken === second.refreshToken,
			families: families.map((family) => ({
				activeMemberId: family.activeMemberId,
				generation: family.generation
			})),
			memberGenerations: members.map((member) => member.generation)
		}).toStrictEqual({
			exchangeStatus: StatusCodes.OK,
			statuses: [StatusCodes.OK, StatusCodes.OK],
			sameSuccessor: true,
			families: [{ activeMemberId: firstId, generation: 1 }],
			memberGenerations: [0, 1]
		});
	});

	it('recovers after another refresh wins the rotation comparison', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const original = exchanged.refresh_token ?? '';
		const present = (): Request =>
			new Request(new URL('/token', currentOrigin()), {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: refreshTokenGrantType,
					refresh_token: original
				}).toString()
			});
		const outcomes = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const identity = new TenantIdentityService(instance.context);
				const firstKeys = new AuthKeysService(instance.context, identity);
				const firstService = new TokenExchangeService(
					instance.context,
					firstKeys,
					new OidcTrustService(instance.context, identity)
				);
				const secondService = new TokenExchangeService(
					instance.context,
					new AuthKeysService(instance.context, identity),
					new OidcTrustService(instance.context, identity)
				);
				const entered = Promise.withResolvers<undefined>();
				const release = Promise.withResolvers<undefined>();
				const activeAuthKey = firstKeys.activeAuthKey.bind(firstKeys);
				const spy = vi
					.spyOn(firstKeys, 'activeAuthKey')
					.mockImplementation(async () => {
						entered.resolve(undefined);
						await release.promise;

						return activeAuthKey();
					});

				try {
					const firstPending = firstService.handleToken(
						rootLogger(),
						present()
					);
					await entered.promise;
					const second = await secondService.handleToken(
						rootLogger(),
						present()
					);
					release.resolve(undefined);
					const first = await firstPending;

					return {
						first: tokenResponseSchema.parse(await first.json()),
						second: tokenResponseSchema.parse(await second.json())
					};
				} finally {
					release.resolve(undefined);
					spy.mockRestore();
				}
			}
		);
		const families = await refreshTokenRows();
		const members = await refreshTokenMemberRows();

		expect({
			sameSuccessor:
				outcomes.first.refresh_token === outcomes.second.refresh_token,
			families: families.map((family) => ({
				generation: family.generation
			})),
			memberGenerations: members.map((member) => member.generation)
		}).toStrictEqual({
			sameSuccessor: true,
			families: [{ generation: 1 }],
			memberGenerations: [0, 1]
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
			drizzle(state.storage, { schema: { refreshTokenFamilies } })
				.update(refreshTokenFamilies)
				.set({
					expiresAt: isoTimestampSchema.parse('2020-01-01T00:00:00.000Z')
				})
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

	it('ends an owner session when the owner identity changes', async () => {
		const subjectToken = await installTrustedOwner();
		const exchanged = await exchange(subjectToken);

		await runInDurableObject(currentServer(), async (instance) => {
			await instance.configure({
				tenant: tenantIdSchema.parse('v1'),
				issuer: oidcIssuerSchema.parse('cupboard'),
				audience: oidcAudienceSchema.parse('cupboard'),
				ownerIssuer: oidcIssuerSchema.parse('https://new-idp.test'),
				ownerSubject: oidcSubjectSchema.parse('new-owner'),
				ownerAudience: oidcAudienceSchema.parse('new-audience'),
				configVersion: 2
			});
		});

		const refreshed = await refresh(exchanged.refresh_token ?? '');
		const body = oauthErrorShape(await refreshed.json());

		expect({
			status: refreshed.status,
			error: body.error,
			problem: body.problem,
			families: await refreshTokenRows(),
			members: await refreshTokenMemberRows()
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_grant',
			problem: 'stale-refresh-token',
			families: [],
			members: []
		});
	});

	it.each([
		'removed',
		'equivalent replacement',
		'broader current tier',
		'narrower current tier'
	] as const)(
		'checks current policy when %s during signing',
		async (change) => {
			const subjectToken = await installTrustedIdp('admin', {
				claims: { team: 'engineering' }
			});
			const exchanged = await exchange(subjectToken, ciRequest);
			const ruleId = trustRuleIdSchema.parse('admin-rule');

			const outcome = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const signingStarted = Promise.withResolvers<undefined>();
					const releaseSigning = Promise.withResolvers<undefined>();
					const tenantIdentity = new TenantIdentityService(instance.context);
					const authKeys = new AuthKeysService(
						instance.context,
						tenantIdentity
					);
					const oidcTrustService = new OidcTrustService(
						instance.context,
						tenantIdentity
					);
					const key = await authKeys.activeAuthKey();

					vi.spyOn(authKeys, 'activeAuthKey').mockImplementation(async () => {
						signingStarted.resolve(undefined);
						await releaseSigning.promise;

						return key;
					});

					const service = new TokenExchangeService(
						instance.context,
						authKeys,
						oidcTrustService
					);
					const parameters = new URLSearchParams({
						grant_type: refreshTokenGrantType,
						refresh_token: exchanged.refresh_token ?? ''
					});
					const request = new Request(new URL('/token', currentOrigin()), {
						method: 'POST',
						headers: { 'content-type': 'application/x-www-form-urlencoded' },
						body: parameters.toString()
					});
					const refreshing = service.handleToken(rootLogger(), request);

					await signingStarted.promise;

					try {
						const existing = oidcTrustService.getRule(ruleId);
						oidcTrustService.removeRule(ruleId);
						if (change !== 'removed') {
							await oidcTrustService.addRule({
								issuer: existing.issuer,
								audience: existing.audience,
								claims:
									change === 'broader current tier'
										? {}
										: change === 'narrower current tier'
											? { ...existing.claims, team: 'engineering' }
											: existing.claims,
								permittedGrants:
									change === 'narrower current tier'
										? storedPermittedGrantsSchema.parse(
												trustClassGrants['release-write']
											)
										: existing.permittedGrants
							});
						}
						if (change === 'narrower current tier') {
							await oidcTrustService.addRule({
								issuer: existing.issuer,
								audience: existing.audience,
								claims: {},
								permittedGrants: storedPermittedGrantsSchema.parse(
									trustClassGrants.write
								)
							});
						}
					} finally {
						releaseSigning.resolve(undefined);
					}

					let result: { readonly kind: 'refused' | 'issued' };

					try {
						await refreshing;
						result = { kind: 'issued' };
					} catch (error) {
						expect(error).toBeInstanceOf(StaleRefreshTokenError);
						result = { kind: 'refused' };
					}

					const database = drizzle(state.storage, {
						schema: { refreshTokenFamilies, refreshTokenMembers }
					});

					return {
						result,
						familyGenerations: database
							.select()
							.from(refreshTokenFamilies)
							.all()
							.map((family) => family.generation),
						memberGenerations: database
							.select()
							.from(refreshTokenMembers)
							.all()
							.map((member) => member.generation)
					};
				}
			);

			const isPermitted =
				change === 'equivalent replacement' ||
				change === 'broader current tier';
			expect(outcome).toStrictEqual({
				result: { kind: isPermitted ? 'issued' : 'refused' },
				familyGenerations: isPermitted ? [1] : [],
				memberGenerations: isPermitted ? [0, 1] : []
			});
		}
	);

	it('does not create a fresh refresh session when current policy permits only CI authority', async () => {
		const subject = await installTrustedIdp('admin');
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const identity = new TenantIdentityService(instance.context);
				const keys = new AuthKeysService(instance.context, identity);
				const trust = new OidcTrustService(instance.context, identity);
				const service = new TokenExchangeService(instance.context, keys, trust);
				const activeAuthKey = keys.activeAuthKey.bind(keys);
				const spy = vi
					.spyOn(keys, 'activeAuthKey')
					.mockImplementation(async () => {
						const existing = trust.getRule(
							trustRuleIdSchema.parse('admin-rule')
						);
						trust.removeRule(existing.id);
						await trust.addRule({
							issuer: existing.issuer,
							audience: existing.audience,
							claims: existing.claims,
							permittedGrants: storedPermittedGrantsSchema.parse(
								trustClassGrants.write
							)
						});
						return activeAuthKey();
					});
				try {
					const endpoint = new URL('/token', currentOrigin());
					const request = new Request(endpoint, {
						method: 'POST',
						headers: { 'content-type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({
							grant_type: tokenExchangeGrantType,
							subject_token: subject,
							subject_token_type: subjectTokenTypeIdToken,
							authorization_details: JSON.stringify(ciRequest)
						}).toString()
					});
					const response = await service.handleToken(rootLogger(), request);
					const result = tokenResponseSchema.parse(await response.json());
					return {
						status: response.status,
						refresh: result.refresh_token,
						grants: result.authorization_details,
						families: drizzle(state.storage, {
							schema: { refreshTokenFamilies }
						})
							.select()
							.from(refreshTokenFamilies)
							.all()
					};
				} finally {
					spy.mockRestore();
				}
			}
		);
		expect(outcome).toStrictEqual({
			status: 200,
			refresh: undefined,
			grants: ciRequest,
			families: []
		});
	});

	it('keeps the presented refresh token usable when loading the signing key fails during rotation', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const refreshToken = exchanged.refresh_token ?? '';
		const before = {
			families: await refreshTokenRows(),
			members: await refreshTokenMemberRows()
		};
		const signingFailure = new Error('the signing key is unavailable');

		const failure = await refreshWithFault(refreshToken, (authKeys) => {
			vi.spyOn(authKeys, 'activeAuthKey').mockRejectedValueOnce(signingFailure);
		});
		const afterFailure = {
			families: await refreshTokenRows(),
			members: await refreshTokenMemberRows()
		};
		const retried = await refresh(refreshToken);
		await retried.text();
		const membersAfterRetry = await refreshTokenMemberRows();

		expect({
			isSigningFailure: failure === signingFailure,
			afterFailure,
			retried: retried.status,
			generations: membersAfterRetry.map((member) => member.generation)
		}).toStrictEqual({
			isSigningFailure: true,
			afterFailure: before,
			retried: StatusCodes.OK,
			generations: [0, 1]
		});
	});

	it('keeps the presented refresh token usable when the successor member cannot be inserted', async () => {
		const exchanged = await exchange(await installTrustedIdp('admin'));
		const refreshToken = exchanged.refresh_token ?? '';
		const before = {
			families: await refreshTokenRows(),
			members: await refreshTokenMemberRows()
		};
		const [family] = before.families;

		if (family === undefined) {
			throw new Error('the exchange created no refresh token family');
		}

		// A member at the successor's generation makes the successor's insert
		// violate the unique family and generation constraint.
		const blocking = {
			id: 'blocking-member',
			familyId: family.id,
			generation: family.generation + 1
		};
		const failure = await refreshWithFault(refreshToken, (_authKeys, state) => {
			drizzle(state.storage, { schema: { refreshTokenMembers } })
				.insert(refreshTokenMembers)
				.values({
					...blocking,
					credentialHash: '0'.repeat(64),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
				})
				.run();
		});
		const afterFailure = {
			families: await refreshTokenRows(),
			members: await refreshTokenMemberRows()
		};
		await runInDurableObject(currentServer(), (_instance, state) => {
			drizzle(state.storage, { schema: { refreshTokenMembers } })
				.delete(refreshTokenMembers)
				.where(eq(refreshTokenMembers.id, blocking.id))
				.run();
		});
		const retried = await refresh(refreshToken);
		await retried.text();
		const membersAfterRetry = await refreshTokenMemberRows();

		expect({
			isRefused: failure instanceof Error,
			isRevocation: failure instanceof StaleRefreshTokenError,
			afterFailure,
			retried: retried.status,
			generations: membersAfterRetry.map((member) => member.generation)
		}).toStrictEqual({
			isRefused: true,
			isRevocation: false,
			afterFailure: {
				families: before.families,
				members: [...before.members, blocking]
			},
			retried: StatusCodes.OK,
			generations: [0, 1]
		});
	});

	it('refuses an owner exchange completed after the owner changes', async () => {
		const subjectToken = await installTrustedOwner();
		const issuerFetch = fetch;
		const verificationStarted = Promise.withResolvers<undefined>();
		const releaseVerification = Promise.withResolvers<undefined>();
		let isHeld = false;

		vi.stubGlobal(
			'fetch',
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);

				if (
					!isHeld &&
					url === 'https://idp.test/.well-known/openid-configuration'
				) {
					isHeld = true;
					verificationStarted.resolve(undefined);
					await releaseVerification.promise;
				}

				return issuerFetch(input, init);
			}
		);

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const parameters = new URLSearchParams({
					grant_type: tokenExchangeGrantType,
					subject_token: subjectToken,
					subject_token_type: subjectTokenTypeIdToken
				});
				const requestUrl = new URL('/token', currentOrigin());
				const request = new Request(requestUrl, {
					method: 'POST',
					headers: {
						'content-type': 'application/x-www-form-urlencoded'
					},
					body: parameters.toString()
				});
				const exchangeRequest = instance.fetch(request);

				await verificationStarted.promise;

				try {
					await instance.configure({
						tenant: tenantIdSchema.parse('v1'),
						issuer: oidcIssuerSchema.parse('cupboard'),
						audience: oidcAudienceSchema.parse('cupboard'),
						ownerIssuer: oidcIssuerSchema.parse('https://new-idp.test'),
						ownerSubject: oidcSubjectSchema.parse('new-owner'),
						ownerAudience: oidcAudienceSchema.parse('new-audience'),
						configVersion: 2
					});
				} finally {
					releaseVerification.resolve(undefined);
				}

				const response = await exchangeRequest;

				return {
					status: response.status,
					body: oauthErrorShape(await response.json())
				};
			}
		);

		expect({
			status: outcome.status,
			error: outcome.body.error,
			problem: outcome.body.problem,
			families: await refreshTokenRows(),
			members: await refreshTokenMemberRows()
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_request',
			problem: 'subject-token-untrusted',
			families: [],
			members: []
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

	it.each<{
		name: string;
		field: 'subject_token' | 'subject_token_type';
		value: string;
	}>([
		{
			name: 'subject_token',
			field: 'subject_token',
			value: 'inbound.jwt.value'
		},
		{
			name: 'subject_token_type',
			field: 'subject_token_type',
			value: subjectTokenTypeIdToken
		}
	])(
		'rejects the exchange-only $name field on refresh',
		async ({ field, value }) => {
			const subjectToken = await installTrustedIdp('admin');
			const exchanged = await exchange(subjectToken);
			const response = await postToken({
				grant_type: refreshTokenGrantType,
				refresh_token: exchanged.refresh_token ?? '',
				[field]: value
			});
			const body = oauthErrorShape(await response.json());

			expect({
				status: response.status,
				error: body.error,
				problem: body.problem
			}).toStrictEqual({
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_request',
				problem: 'schema-mismatch'
			});
		}
	);

	it('does not revoke a family for a forged secret with a valid member id', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		const refreshToken = exchanged.refresh_token ?? '';
		const [memberId] = z
			.tuple([z.uuid(), z.string(), z.string(), z.string()])
			.parse(refreshToken.split('.'));
		const forged = await staleRefreshOutcome(`${memberId}.deadbeef`);
		const valid = await refresh(refreshToken);
		const validBody = tokenResponseSchema.parse(await valid.json());

		expect({
			forged,
			validStatus: valid.status,
			hasSuccessor: typeof validBody.refresh_token
		}).toStrictEqual({
			forged: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			validStatus: StatusCodes.OK,
			hasSuccessor: 'string'
		});
	});

	it('reaps expired refresh tokens in the garbage-collection pass', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const firstExchange = await exchange(subjectToken);
		const secondExchange = await exchange(subjectToken);

		const [live] = z
			.tuple([z.object({ id: z.string(), expiresAt: z.string() })])
			.rest(z.object({ id: z.string(), expiresAt: z.string() }))
			.parse(await refreshTokenRows());

		await runInDurableObject(currentServer(), (_instance, state) => {
			const database = drizzle(state.storage, {
				schema: { refreshTokenFamilies }
			});
			const rows = database.select().from(refreshTokenFamilies).all();
			const staleRows = rows.filter((row) => row.id !== live.id);
			const [stale] = z
				.tuple([z.looseObject({ id: z.string() })])
				.parse(staleRows);

			database
				.update(refreshTokenFamilies)
				.set({
					expiresAt: isoTimestampSchema.parse('2020-01-01T00:00:00.000Z')
				})
				.where(eq(refreshTokenFamilies.id, stale.id))
				.run();
		});

		await currentServer().runGarbageCollection();

		const survivors = await refreshTokenRows();
		const survivingMembers = await refreshTokenMemberRows();

		expect({
			exchangeStatuses: [firstExchange.status, secondExchange.status],
			survivors: survivors.map((row) => row.id),
			memberFamilies: survivingMembers.map((member) => member.familyId)
		}).toStrictEqual({
			exchangeStatuses: [StatusCodes.OK, StatusCodes.OK],
			survivors: [live.id],
			memberFamilies: [live.id]
		});
	});

	it('collects families at their deadline and continues to the next family', async () => {
		vi.useFakeTimers();

		try {
			const deadline = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
			vi.setSystemTime(new Date(deadline));
			const subjectToken = await installTrustedIdp('admin');
			await exchange(subjectToken);
			await exchange(subjectToken);

			const firstPass = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const database = drizzle(state.storage, {
						schema: { refreshTokenFamilies, refreshTokenMembers }
					});
					database
						.update(refreshTokenFamilies)
						.set({ expiresAt: deadline })
						.run();

					await underOneUnitOfWork(() => instance.runGarbageCollection());
					const continuation = await state.storage.get(gcContinuationKey);
					await state.storage.deleteAlarm();

					return {
						families: database.select().from(refreshTokenFamilies).all(),
						members: database.select().from(refreshTokenMembers).all(),
						continuation
					};
				}
			);

			expect({
				families: firstPass.families.length,
				members: firstPass.members.length,
				continuation: firstPass.continuation
			}).toStrictEqual({
				families: 1,
				members: 1,
				continuation: [{ scope: 'tenant' }]
			});

			await runInDurableObject(currentServer(), (instance) => instance.alarm());

			const drained = await runInDurableObject(
				currentServer(),
				async (_instance, state) => {
					const database = drizzle(state.storage, {
						schema: { refreshTokenFamilies, refreshTokenMembers }
					});

					return {
						families: database.select().from(refreshTokenFamilies).all(),
						members: database.select().from(refreshTokenMembers).all(),
						continuation: await state.storage.get(gcContinuationKey)
					};
				}
			);

			expect(drained).toStrictEqual({
				families: [],
				members: [],
				continuation: undefined
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('drains expired refresh families through bounded continuation passes', async () => {
		// The large family holds `phaseStepSize` spent members beside its active
		// one. That is one member more than a step deletes, so the family
		// survives the first pass.
		const spentMembers = phaseStepSize;
		const subjectToken = await installTrustedIdp('admin');
		await exchange(subjectToken);
		await exchange(subjectToken);

		const capture = startCapture();
		const firstPass = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const database = drizzle(state.storage, {
					schema: { refreshTokenFamilies, refreshTokenMembers }
				});
				const [largeFamily, smallFamily] = z
					.tuple([
						z.object({ id: z.string(), activeMemberId: z.string() }),
						z.object({ id: z.string(), activeMemberId: z.string() })
					])
					.parse(database.select().from(refreshTokenFamilies).all());
				state.storage.sql.exec(
					"UPDATE refresh_session_family SET expires_at = '2019-01-01T00:00:00.000Z', generation = ? WHERE id = ?",
					spentMembers,
					largeFamily.id
				);
				state.storage.sql.exec(
					'UPDATE refresh_session_member SET generation = ? WHERE id = ?',
					spentMembers,
					largeFamily.activeMemberId
				);
				state.storage.sql.exec(
					"UPDATE refresh_session_family SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
					smallFamily.id
				);
				state.storage.sql.exec(
					`WITH digits(digit) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)),
					 generations(value) AS (
					   SELECT ones.digit + tens.digit * 10 + hundreds.digit * 100 + thousands.digit * 1000
					   FROM digits AS ones
					   CROSS JOIN digits AS tens
					   CROSS JOIN digits AS hundreds
					   CROSS JOIN digits AS thousands
					 )
					 INSERT INTO refresh_session_member (id, family_id, generation, credential_hash, created_at)
					 SELECT printf('gc-spent-%d', value), ?, value, lower(hex(randomblob(32))), '2019-01-01T00:00:00.000Z'
					 FROM generations
					 WHERE value < ?`,
					largeFamily.id,
					spentMembers
				);
				await underOneUnitOfWork(() => instance.runGarbageCollection());
				const continuation = await state.storage.get(gcContinuationKey);
				await state.storage.deleteAlarm();

				return {
					families: database
						.select()
						.from(refreshTokenFamilies)
						.orderBy(refreshTokenFamilies.id)
						.all(),
					members: database
						.select()
						.from(refreshTokenMembers)
						.orderBy(refreshTokenMembers.familyId)
						.all(),
					continuation
				};
			}
		);
		capture.stop();
		const backlogs = capture.logs
			.filter(
				(entry) =>
					entry.message ===
					'refresh-token family backlog remains after bounded collection'
			)
			.map((entry) => ({
				level: entry.level,
				properties: entry.properties
			}));

		expect({
			remainingFamilies: firstPass.families.length,
			remainingMembers: firstPass.members.length,
			remainingMemberFamilies: firstPass.members.map(
				(member) => member.familyId
			),
			remainingFamilyIds: firstPass.families.map((family) => family.id),
			continuation: firstPass.continuation,
			backlogs
		}).toStrictEqual({
			remainingFamilies: 2,
			remainingMembers: 2,
			remainingMemberFamilies: firstPass.families.map((family) => family.id),
			remainingFamilyIds: firstPass.families.map((family) => family.id),
			continuation: [{ scope: 'tenant' }],
			backlogs: [
				{
					level: 'warning',
					properties: {
						job: 'garbage-collection',
						method: 'garbage-collection',
						membersDeleted: phaseStepSize,
						familiesDeleted: 0
					}
				}
			]
		});

		// The continuation pass runs on a whole budget, which covers the member the
		// first pass left and the second family behind it.
		const drained = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.alarm();
				const database = drizzle(state.storage, {
					schema: { refreshTokenFamilies, refreshTokenMembers }
				});
				const continuation = await state.storage.get(gcContinuationKey);
				await state.storage.deleteAlarm();

				return {
					families: database.select().from(refreshTokenFamilies).all(),
					members: database.select().from(refreshTokenMembers).all(),
					continuation
				};
			}
		);

		expect(drained).toStrictEqual({
			families: [],
			members: [],
			continuation: undefined
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

describe('requested grants', () => {
	beforeEach(resetTestServer);

	it('issues exact read access before a named cache exists without creating it', async () => {
		const cache: CacheScope = {
			kind: 'named',
			name: cacheNameSchema.parse('future')
		};
		const subjectToken = await installTrustedIdp('read');
		await installAdditionalTrustRule('future-cache-read-rule', [
			{
				type: 'cupboard_cache',
				actions: ['cache:content-read'],
				resources: {
					cache: { kind: 'named', exact: 'future', validate: 'cacheName' }
				}
			}
		]);
		const before = await runInDurableObject(currentServer(), (instance) =>
			instance.context.cacheRepository.resolve(cache)
		);
		const requested = [
			{
				type: 'cupboard_cache',
				actions: ['cache:content-read'],
				cache
			}
		];
		const issued = await exchange(subjectToken, requested);
		const claims = decodeJwt(issued.access_token);

		expect({
			status: issued.status,
			grants: issued.authorization_details,
			claims: claims.authorization_details,
			expiresIn: issued.expires_in,
			refreshToken: issued.refresh_token,
			before,
			after: await runInDurableObject(currentServer(), (instance) =>
				instance.context.cacheRepository.resolve(cache)
			)
		}).toStrictEqual({
			status: StatusCodes.OK,
			grants: requested,
			claims: requested,
			expiresIn: 900,
			refreshToken: undefined,
			before: undefined,
			after: undefined
		});
	});

	it('issues exact cache and view read grants without write authority', async () => {
		const subjectToken = await installTrustedIdp('read');
		const requested = [
			{
				type: 'cupboard_cache',
				actions: ['cache:content-read'],
				cache: { kind: 'default' }
			},
			{
				type: 'cupboard_view',
				actions: ['view:content-read'],
				view: 'sources'
			}
		];
		const issued = await exchange(subjectToken, requested);
		const claims = decodeJwt(issued.access_token);
		const refused = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken,
			authorization_details: JSON.stringify([
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					cache: { kind: 'default' }
				}
			])
		});

		expect({
			status: issued.status,
			grants: issued.authorization_details,
			claims: claims.authorization_details,
			expiresIn: issued.expires_in,
			refreshToken: issued.refresh_token,
			writeStatus: refused.status,
			writeError: oauthErrorShape(await refused.json()).error
		}).toStrictEqual({
			status: StatusCodes.OK,
			grants: requested,
			claims: requested,
			expiresIn: 900,
			refreshToken: undefined,
			writeStatus: StatusCodes.BAD_REQUEST,
			writeError: 'invalid_authorization_details'
		});
	});

	it('issues a stateless read-only token under a wildcard trust rule', async () => {
		const requested = [
			{
				type: 'cupboard_cache',
				actions: ['cache:content-read'],
				cache: { kind: 'default' }
			}
		];
		const issued = await exchange(await installTrustedIdp('admin'), requested);

		expect({
			status: issued.status,
			grants: issued.authorization_details,
			expiresIn: issued.expires_in,
			refreshToken: issued.refresh_token,
			refreshFamilies: await refreshTokenRows()
		}).toStrictEqual({
			status: StatusCodes.OK,
			grants: requested,
			expiresIn: 900,
			refreshToken: undefined,
			refreshFamilies: []
		});
	});

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

	it('uses requested authority to distinguish tied identity rules', async () => {
		const subjectToken = await installTrustedIdp('write');
		const privateGrant: PermittedGrant = {
			type: 'cupboard_cache',
			actions: ['upload:commit'],
			resources: {
				cache: { kind: 'named', exact: 'private', validate: 'cacheName' }
			}
		};
		await installAdditionalTrustRule('private-rule', [privateGrant]);
		const requested = [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: namedCache('private')
			}
		];

		const exchanged = await exchange(subjectToken, requested);
		const claims = decodeJwt(exchanged.access_token);

		expect({
			status: exchanged.status,
			granted: exchanged.authorization_details,
			tokenGrants: claims.authorization_details
		}).toStrictEqual({
			status: StatusCodes.OK,
			granted: requested,
			tokenGrants: requested
		});
	});

	it('deterministically composes overlapping explicit authority', async () => {
		const subjectToken = await installTrustedIdp('write');
		const overlappingGrant: PermittedGrant = {
			type: 'cupboard_cache',
			actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
			resources: {
				cache: { kind: 'named', exact: 'ci', validate: 'cacheName' }
			}
		};
		await installAdditionalTrustRule('overlapping-rule', [overlappingGrant]);

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken,
			authorization_details: JSON.stringify(ciRequest)
		});
		expect(response.status).toBe(StatusCodes.OK);
		const result = tokenResponseSchema.parse(await response.json());
		const claims = decodeJwt(result.access_token);
		expect({
			grants: result.authorization_details,
			tokenGrants: claims.authorization_details,
			refresh: result.refresh_token,
			rule: claims.cb_rule,
			rules: claims.cb_rules
		}).toStrictEqual({
			grants: ciRequest,
			tokenGrants: ciRequest,
			refresh: undefined,
			rule: 'overlapping-rule',
			rules: undefined
		});
	});

	it.each(['run/1', 'other/1'])(
		'composes actions for the same cache without extending root authority to %s',
		async (root) => {
			const subject = await installTrustedIdp('write');
			await installAdditionalTrustRule('retain-rule', [
				{
					type: 'cupboard_cache',
					actions: ['root:set'],
					resources: {
						cache: { kind: 'named', exact: 'ci', validate: 'cacheName' },
						root: { exact: 'run/', validate: 'rootName' }
					}
				}
			]);
			const requested = [
				{
					type: 'cupboard_cache',
					cache: namedCache('ci'),
					actions: ['upload:commit', 'root:set'],
					root
				}
			];
			const response = await postToken({
				grant_type: tokenExchangeGrantType,
				subject_token: subject,
				subject_token_type: subjectTokenTypeIdToken,
				authorization_details: JSON.stringify(requested)
			});
			if (root === 'other/1') {
				expect({
					status: response.status,
					body: await response.json()
				}).toStrictEqual({
					status: StatusCodes.BAD_REQUEST,
					body: {
						error: 'invalid_authorization_details',
						error_description:
							'The requested authorization_details are not permitted',
						problem: 'not-permitted'
					}
				});
				return;
			}
			expect(response.status).toBe(StatusCodes.OK);
			const result = tokenResponseSchema.parse(await response.json());
			const claims = decodeJwt(result.access_token);
			expect({
				grants: result.authorization_details,
				tokenGrants: claims.authorization_details,
				refresh: result.refresh_token,
				rule: claims.cb_rule,
				rules: claims.cb_rules
			}).toStrictEqual({
				grants: requested,
				tokenGrants: requested,
				refresh: undefined,
				rule: undefined,
				rules: undefined
			});
		}
	);

	it('composes exact explicit authority from separate rules without refresh', async () => {
		const subjectToken = await installTrustedIdp('write');
		const privateGrant: PermittedGrant = {
			type: 'cupboard_cache',
			actions: ['upload:commit'],
			resources: {
				cache: { kind: 'named', exact: 'private', validate: 'cacheName' }
			}
		};
		await installAdditionalTrustRule('private-rule', [privateGrant]);
		const requested = [
			...ciRequest,
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: namedCache('private')
			}
		];

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken,
			authorization_details: JSON.stringify(requested)
		});
		expect(response.status).toBe(StatusCodes.OK);
		const result = tokenResponseSchema.parse(await response.json());
		const claims = decodeJwt(result.access_token);
		expect({
			grants: result.authorization_details,
			tokenGrants: claims.authorization_details,
			refresh: result.refresh_token,
			rule: claims.cb_rule,
			rules: claims.cb_rules
		}).toStrictEqual({
			grants: requested,
			tokenGrants: requested,
			refresh: undefined,
			rule: undefined,
			rules: undefined
		});
	});

	// A grant names a cache and says nothing about its access. A rule bound to
	// `release` issues one grant, which covers the cache `release` and no other.
	it('confines a grant to the cache it names', async () => {
		await putTestCache(
			await issueServerSignedToken(adminGrants()),
			{ kind: 'named', name: cacheNameSchema.parse('release') },
			'public'
		);
		const subjectToken = await installTrustedIdp('release-write');
		const issued = await exchange(subjectToken, releaseRequest);
		const refused = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken,
			authorization_details: JSON.stringify(ciRequest)
		});
		const refusedBody = oauthErrorShape(await refused.json());
		const negotiated = await negotiateFor(issued.access_token, 'release');
		const denied = await negotiateFor(issued.access_token, 'ci');

		expect({
			granted: issued.authorization_details,
			refusedStatus: refused.status,
			refusedProblem: refusedBody.problem,
			negotiated: negotiated.status,
			denied: denied.status
		}).toStrictEqual({
			granted: releaseRequest,
			refusedStatus: StatusCodes.BAD_REQUEST,
			refusedProblem: 'not-permitted',
			negotiated: StatusCodes.OK,
			denied: StatusCodes.FORBIDDEN
		});
	});

	// `upload:commit` can modify only state created by upload negotiation.
	// `upload:confirm` can refresh any committed path, so commit permission must
	// not imply confirm permission.
	it('refuses upload:confirm when the rule permits only upload:commit', async () => {
		const confirmRequest = [
			{
				type: 'cupboard_cache',
				actions: ['upload:confirm'],
				cache: namedCache('ci')
			}
		];
		const { status, body } = await exchangeWith(JSON.stringify(confirmRequest));

		expect({ status, shape: oauthErrorShape(body) }).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			shape: {
				error: 'invalid_authorization_details',
				error_description:
					'The requested authorization_details are not permitted',
				problem: 'not-permitted'
			}
		});
	});

	it('rejects a CI exchange with no requested grants as invalid_request', async () => {
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
			name: "a grant outside the rule's permitted caches",
			details: JSON.stringify([
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					cache: namedCache('other')
				}
			]),
			problem: 'not-permitted'
		},
		{
			name: "an operation outside the rule's permissions",
			details: JSON.stringify([
				{ type: 'cupboard_cache', actions: ['gc:run'], cache: namedCache('ci') }
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
						'The requested authorization_details are not permitted',
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

async function ownerToken(): Promise<string> {
	const subjectToken = await installTrustedIdp('admin');
	const exchanged = await exchange(subjectToken);

	return exchanged.access_token;
}

describe('attenuation', () => {
	beforeEach(resetTestServer);

	it('does not extend the presented token lifetime', async () => {
		vi.useFakeTimers();

		try {
			const issuedAt = new Date('2026-01-01T00:00:00.000Z');
			vi.setSystemTime(issuedAt);
			const owner = await ownerToken();
			const parent = decodeJwt(owner);

			vi.setSystemTime(new Date(issuedAt.getTime() + 9 * 60 * 1000));
			const response = await attenuate(owner, adminGrants());
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

	it('narrows a self-issued token to a requested subset, with no refresh', async () => {
		const owner = await ownerToken();
		const subset = [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: namedCache('pr-1')
			}
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
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: namedCache('pr-1')
			}
		]);
		const narrowed = tokenResponseSchema.parse(await narrowResponse.json());

		const otherCache = await attenuate(narrowed.access_token, [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: namedCache('pr-2')
			}
		]);
		const otherOp = await attenuate(narrowed.access_token, [
			{ type: 'cupboard_cache', actions: ['gc:run'], cache: namedCache('pr-1') }
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

	it('refuses to narrow a commit-only token into confirm authority', async () => {
		const owner = await ownerToken();
		const narrowResponse = await attenuate(owner, [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: namedCache('pr-1')
			}
		]);
		const narrowed = tokenResponseSchema.parse(await narrowResponse.json());

		const confirmAttempt = await attenuate(narrowed.access_token, [
			{
				type: 'cupboard_cache',
				actions: ['upload:confirm'],
				cache: namedCache('pr-1')
			}
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
		// Matching issuer and audience values do not select attenuation. This token
		// uses a foreign signing key, so self-verification fails and external trust
		// matching rejects it.
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
			subject_token_type: subjectTokenTypeIdToken,
			authorization_details: JSON.stringify([{ type: 'cupboard_wildcard' }])
		});

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
	});

	it('reissues a narrower session when refresh requests a subset', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		const subset = [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: namedCache('pr-1')
			}
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

	it('keeps the original grant ceiling across refresh rotations', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const subset = [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: namedCache('pr-1')
			}
		];
		const exchanged = await exchange(subjectToken, subset);

		const firstResponse = await refresh(exchanged.refresh_token ?? '');
		const first = tokenResponseSchema.parse(await firstResponse.json());
		const widenedResponse = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: first.refresh_token ?? '',
			authorization_details: JSON.stringify([{ type: 'cupboard_wildcard' }])
		});
		const widened = oauthErrorShape(await widenedResponse.json());

		expect({
			exchanged: exchanged.authorization_details,
			firstStatus: firstResponse.status,
			firstGrants: first.authorization_details,
			widenedStatus: widenedResponse.status,
			widenedError: widened.error,
			widenedProblem: widened.problem
		}).toStrictEqual({
			exchanged: subset,
			firstStatus: StatusCodes.OK,
			firstGrants: subset,
			widenedStatus: StatusCodes.BAD_REQUEST,
			widenedError: 'invalid_authorization_details',
			widenedProblem: 'not-permitted'
		});
	});

	it('persists a narrower grant ceiling across refresh rotations', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const initial = [
			{
				type: 'cupboard_cache',
				actions: ['upload:negotiate', 'upload:commit'],
				cache: namedCache('pr-1')
			}
		];
		const narrower = [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: namedCache('pr-1')
			}
		];
		const exchanged = await exchange(subjectToken, initial);

		const narrowedResponse = await postToken({
			grant_type: refreshTokenGrantType,
			refresh_token: exchanged.refresh_token ?? '',
			authorization_details: JSON.stringify(narrower)
		});
		const narrowed = tokenResponseSchema.parse(await narrowedResponse.json());
		const preservedResponse = await refresh(narrowed.refresh_token ?? '');
		const preserved = tokenResponseSchema.parse(await preservedResponse.json());

		expect({
			exchanged: exchanged.authorization_details,
			narrowedStatus: narrowedResponse.status,
			narrowed: narrowed.authorization_details,
			preservedStatus: preservedResponse.status,
			preserved: preserved.authorization_details
		}).toStrictEqual({
			exchanged: initial,
			narrowedStatus: StatusCodes.OK,
			narrowed: narrower,
			preservedStatus: StatusCodes.OK,
			preserved: narrower
		});
	});
});

describe('owner rule seeding', () => {
	beforeEach(resetTestServer);

	it('seeds the owner admin rule from the assigned identity during initialisation', async () => {
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
		await provisionNamedTenant('v1');
		const response = await readFetch('/.well-known/oauth-authorization-server');
		const origin = currentOrigin();

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			body: authorizationServerMetadataSchema.parse(await response.json())
		}).toStrictEqual({
			status: StatusCodes.OK,
			cacheControl: 'no-store',
			body: {
				issuer: `${origin}/t/v1`,
				token_endpoint: `${origin}/t/v1/token`,
				jwks_uri: `${origin}/t/v1/.well-known/jwks.json`,
				response_types_supported: [],
				grant_types_supported: [
					tokenExchangeGrantType,
					refreshTokenGrantType,
					readAccessGrantType
				],
				authorization_details_types_supported: [
					'cupboard_cache',
					'cupboard_view',
					'cupboard_domain',
					'cupboard_wildcard'
				],
				token_endpoint_auth_methods_supported: ['none']
			}
		});
	});
});

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
				createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
			})
			.run();
	});

	vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input);

		if (url === `${githubIssuer}/.well-known/openid-configuration`) {
			return Promise.resolve(
				Response.json({
					issuer: githubIssuer,
					jwks_uri: `${githubIssuer}/jwks`,
					response_types_supported: ['id_token'],
					subject_types_supported: ['public'],
					id_token_signing_alg_values_supported: ['RS256']
				})
			);
		}

		if (url === `${githubIssuer}/jwks`) {
			return Promise.resolve(
				Response.json({ keys: [{ ...jwk, kid: 'idp', alg: 'RS256' }] })
			);
		}

		return Promise.resolve(
			new Response('not found', { status: StatusCodes.NOT_FOUND })
		);
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

	it('reports the first failing claim for a verified token from the pinned repository', async () => {
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
				error: 'invalid_request',
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

	it('returns the generic refusal when the claimed repository matches no rule', async () => {
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

	it('returns the generic refusal for a forged token that claims the pinned repository', async () => {
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

	it('reports 503, not untrusted, when the pinned issuer is unavailable', async () => {
		const { sign } = await installGithubBranchRule();
		const subjectToken = await sign(branchRuleClaims);
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
});

describe('multi-audience subject tokens', () => {
	beforeEach(resetTestServer);

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const secondAudienceGrant: PermittedGrant = {
		type: 'cupboard_cache',
		actions: ['upload:commit'],
		resources: {
			cache: { kind: 'named', exact: 'other', validate: 'cacheName' }
		}
	};

	it('exchanges a token whose audiences are all configured', async () => {
		const subjectToken = await installTrustedIdp('write', {
			tokenAudience: ['cupboard-aud', 'cupboard-aud-2'],
			azp: 'cupboard-aud'
		});
		await installAdditionalTrustRule(
			'second-audience-rule',
			[secondAudienceGrant],
			{ audience: 'cupboard-aud-2', claims: { sub: 'bob' } }
		);

		const exchanged = await exchange(subjectToken, ciRequest);

		expect({
			status: exchanged.status,
			granted: exchanged.authorization_details
		}).toStrictEqual({
			status: StatusCodes.OK,
			granted: ciRequest
		});
	});

	it('refuses a multi-audience token without an authorised party', async () => {
		const subjectToken = await installTrustedIdp('write', {
			tokenAudience: ['cupboard-aud', 'cupboard-aud-2']
		});
		await installAdditionalTrustRule(
			'second-audience-rule',
			[secondAudienceGrant],
			{ audience: 'cupboard-aud-2', claims: { sub: 'bob' } }
		);

		const refused = await refusedExchange(subjectToken);

		expect({
			status: refused.status,
			problem: refused.body.problem
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			problem: 'subject-token-invalid'
		});
	});

	it('refuses an extra audience configured only for another issuer', async () => {
		const subjectToken = await installTrustedIdp('write', {
			tokenAudience: ['cupboard-aud', 'cupboard-aud-2'],
			azp: 'cupboard-aud'
		});
		await installAdditionalTrustRule(
			'other-issuer-rule',
			[secondAudienceGrant],
			{ issuer: 'https://other-idp.test', audience: 'cupboard-aud-2' }
		);

		const error = await tokenExchangeError({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken,
			authorization_details: JSON.stringify(ciRequest)
		});

		expect(error).toBeInstanceOf(SubjectTokenVerificationFailedError);
	});

	it('refuses a token with an unconfigured audience', async () => {
		const subjectToken = await installTrustedIdp('write', {
			tokenAudience: ['cupboard-aud', 'unconfigured-aud'],
			azp: 'cupboard-aud'
		});

		const refused = await refusedExchange(subjectToken);

		expect({
			status: refused.status,
			problem: refused.body.problem
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			problem: 'subject-token-invalid'
		});
	});
});

function unreadableRuleOutcome(outcome: unknown): unknown {
	if (outcome instanceof StoredOidcTrustInvalidError) {
		return { refused: outcome.id };
	}

	if (outcome instanceof Response) {
		return { status: outcome.status };
	}

	return outcome;
}

interface UnreadableRuleCase {
	readonly name: string;
	readonly scope: 'write' | 'read';
	readonly narrowAudience: string;
	readonly form: Readonly<Record<string, string>>;
	readonly expected: unknown;
}

describe('unreadable trust rules', () => {
	beforeEach(resetTestServer);

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const mainClaims = { ref: 'refs/heads/main' };

	const narrowGrant: PermittedGrant = {
		type: 'cupboard_cache',
		actions: ['upload:commit'],
		resources: {
			cache: { kind: 'named', exact: 'main', validate: 'cacheName' }
		}
	};

	function installNarrowRule(audience: string): Promise<void> {
		return installAdditionalTrustRule('narrow-rule', [narrowGrant], {
			audience,
			claims: { sub: 'alice', ...mainClaims }
		});
	}

	function makeNarrowRuleUnreadable(state: DurableObjectState): void {
		drizzle(state.storage, { schema: { oidcTrust } })
			.update(oidcTrust)
			.set({
				permittedGrantsJson: JSON.stringify([{ type: 'cupboard_unknown' }])
			})
			.where(eq(oidcTrust.id, trustRuleIdSchema.parse('narrow-rule')))
			.run();
	}

	const exchangeForm = {
		grant_type: tokenExchangeGrantType,
		authorization_details: JSON.stringify(ciRequest)
	};

	it.each<UnreadableRuleCase>([
		{
			name: 'refuses an exchange when an unreadable rule matches its audience',
			scope: 'write',
			narrowAudience: 'cupboard-aud',
			form: exchangeForm,
			expected: { refused: 'narrow-rule' }
		},
		{
			name: 'refuses a read access request when an unreadable rule matches its audience',
			scope: 'read',
			narrowAudience: 'cupboard-aud',
			form: {
				grant_type: readAccessGrantType,
				read_resources: JSON.stringify([
					{
						type: 'cupboard_cache',
						cache: { kind: 'default' },
						mode: 'content'
					}
				])
			},
			expected: { refused: 'narrow-rule' }
		},
		{
			name: 'accepts an exchange when the unreadable rule has another audience',
			scope: 'write',
			narrowAudience: 'other-aud',
			form: exchangeForm,
			expected: { status: StatusCodes.OK }
		}
	])('$name', async ({ scope, narrowAudience, form, expected }) => {
		const subjectToken = await installTrustedIdp(scope, {
			claims: mainClaims
		});
		await installNarrowRule(narrowAudience);
		await runInDurableObject(currentServer(), (_instance, state) => {
			makeNarrowRuleUnreadable(state);
		});

		const outcome = await tokenExchangeError({
			...form,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});

		expect(unreadableRuleOutcome(outcome)).toStrictEqual(expected);
	});

	it('refuses to rotate a refresh family when an unreadable rule matches its identity', async () => {
		const original = await exchange(
			await installTrustedIdp('admin', { claims: mainClaims })
		);
		await installNarrowRule('cupboard-aud');
		const families = await refreshTokenRows();

		const outcome = await refreshWithFault(
			original.refresh_token ?? '',
			(_authKeys, state) => {
				makeNarrowRuleUnreadable(state);
			}
		);

		expect({
			outcome: unreadableRuleOutcome(outcome),
			families: await refreshTokenRows()
		}).toStrictEqual({ outcome: { refused: 'narrow-rule' }, families });
	});
});
