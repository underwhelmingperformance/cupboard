import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import { cacheNameSchema, tenantIdSchema } from '@cupboard/nix-store/scalars';
import { type PermittedGrant } from '@cupboard/protocol/grants';
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
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	maxRefreshTokenFamilyMembers,
	refreshTokenFamilyTtlSeconds
} from '../auth/auth.ts';
import { sha256Hex } from '../crypto/crypto.ts';
import {
	oidcTrust,
	refreshTokenFamilies,
	refreshTokenMembers
} from '../db/schema.ts';
import {
	OwnerConfigurationInvalidError,
	RefreshTokenRequiredError,
	StaleRefreshTokenError,
	StoredOidcTrustInvalidError,
	SubjectTokenNotJwtError,
	SubjectTokenRequiredError,
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
	latestPreContractMigrationIndex,
	migrateThrough,
	provisionNamedTenant,
	putTestCache,
	readFetch,
	resetTestServer,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation
} from '../test-support.ts';

import { AuthKeysService } from './auth-keys-service.ts';
import { ownerRuleId } from './context.ts';
import {
	maxPathsCollectedPerRun,
	maxRefreshTokenMembersDeletedPerRun
} from './garbage-collection-service.ts';
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
			await migrateThrough(state, latestPreContractMigrationIndex);
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

	// A rule the server cannot read is left out of the enumeration a token
	// exchange selects from, so it can never authorise anything, and the
	// exchange still answers with its ordinary refusal. The administrative read
	// reports the fault so the row can be found and corrected.
	it('leaves an existing loopback HTTP trust row out of issuance', async () => {
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await migrateThrough(state, latestPreContractMigrationIndex);
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
						.map((entry) => entry.level),
					readRefused: readError instanceof StoredOidcTrustInvalidError
				};
			}
		);

		expect(outcome).toStrictEqual({
			// The tenant's own owner rule remains; only the unreadable row is left out.
			enabled: [{ id: 'owner' }],
			skipped: ['error'],
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

const trustClassGrants = {
	admin: [{ type: 'cupboard_wildcard' }],
	write: [
		{
			type: 'cupboard_cache',
			actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
			resources: {
				cache: { exact: 'ci', kind: 'named', validate: 'cacheName' }
			}
		}
	],
	'release-write': [
		{
			type: 'cupboard_cache',
			actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
			resources: {
				cache: { exact: 'release', kind: 'named', validate: 'cacheName' }
			}
		}
	]
} as const;

async function installTrustedIdp(
	scope: 'admin' | 'write' | 'release-write',
	options: {
		failFirstFetches?: number;
		protectedType?: string;
		tokenAudience?: string | string[];
		azp?: string;
	} = {}
): Promise<string> {
	const idp = await generateKeyPair('RS256', { extractable: true });
	const jwk = await exportJWK(idp.publicKey);
	const signer = new SignJWT(
		options.azp === undefined ? {} : { azp: options.azp }
	);
	const subjectToken = await signer
		.setProtectedHeader({
			alg: 'RS256',
			kid: 'idp',
			...(options.protectedType !== undefined && {
				typ: options.protectedType
			})
		})
		.setIssuer('https://idp.test')
		.setAudience(options.tokenAudience ?? 'cupboard-aud')
		.setSubject('alice')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(idp.privateKey);

	let remainingFailures = options.failFirstFetches ?? 0;

	await runInDurableObject(currentServer(), async (_instance, state) => {
		await migrateThrough(state, latestPreContractMigrationIndex);
		drizzle(state.storage, { schema: { oidcTrust } })
			.insert(oidcTrust)
			.values({
				id: trustRuleIdSchema.parse(`${scope}-rule`),
				issuer: 'https://idp.test',
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

		if (url === 'https://idp.test/.well-known/openid-configuration') {
			return Promise.resolve(
				Response.json({
					issuer: 'https://idp.test',
					jwks_uri: 'https://idp.test/jwks',
					authorization_endpoint: 'https://idp.test/authorize',
					response_types_supported: ['id_token'],
					subject_types_supported: ['public'],
					id_token_signing_alg_values_supported: ['RS256']
				})
			);
		}

		if (url === 'https://idp.test/jwks') {
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
	options: { audience?: string; claims?: Record<string, string> } = {}
): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { oidcTrust } })
			.insert(oidcTrust)
			.values({
				id: trustRuleIdSchema.parse(id),
				issuer: 'https://idp.test',
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

const ciRequest = [
	{
		type: 'cupboard_cache',
		actions: ['upload:commit'],
		cache: { kind: 'named', name: 'ci' }
	}
];

const releaseRequest = [
	{
		type: 'cupboard_cache',
		actions: ['upload:negotiate'],
		cache: { kind: 'named', name: 'release' }
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

	// The cache-scope migration discards every refresh-token family, because a
	// stored family carries the grants it was issued with and those name their
	// cache in the retired grammar. A client presenting a token from before the
	// cutover must therefore be told its grant is invalid, which is the signal
	// that sends it back to the identity-token exchange.
	it('refuses a refresh token whose family the cutover discarded', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		const refreshToken = exchanged.refresh_token ?? '';

		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec('DELETE FROM refresh_token_member');
			state.storage.sql.exec('DELETE FROM refresh_token_family');
		});

		expect(await staleRefreshOutcome(refreshToken)).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_grant',
			problem: 'stale-refresh-token'
		});
	});

	it('revokes the family when a consumed refresh token is replayed', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		const refreshToken = exchanged.refresh_token ?? '';
		const first = await refresh(refreshToken);
		const firstBody = tokenResponseSchema.parse(await first.json());
		const successor = firstBody.refresh_token ?? '';

		const capture = startCapture();
		let replay;
		let successorAfterReplay;

		try {
			replay = await staleRefreshOutcome(refreshToken);
			successorAfterReplay = await staleRefreshOutcome(successor);
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
			firstStatus: first.status,
			replay,
			successorAfterReplay,
			revocations,
			rows: await refreshTokenRows()
		}).toStrictEqual({
			firstStatus: StatusCodes.OK,
			replay: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			successorAfterReplay: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			revocations: [
				{
					level: 'warning',
					properties: { method: 'POST', path: '/token', reason: 'replay' }
				}
			],
			rows: []
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
			.tuple([z.uuid(), z.string()])
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

	it('stores only member ids and SHA-256 secret hashes', async () => {
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
				.tuple([z.uuid(), z.string().min(1)])
				.parse(original.split('.'));
			const [successorId, successorSecret] = z
				.tuple([z.uuid(), z.string().min(1)])
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
				hash(originalSecret),
				hash(successorSecret)
			]);
			const persisted = await runInDurableObject(
				currentServer(),
				(_instance, state) => ({
					families: state.storage.sql
						.exec(
							'SELECT id, active_member_id, generation, rule_id, subject, created_at, expires_at FROM refresh_token_family'
						)
						.toArray(),
					members: state.storage.sql
						.exec('SELECT * FROM refresh_token_member ORDER BY generation')
						.toArray(),
					legacy: {
						live: state.storage.sql
							.exec('SELECT id FROM refresh_token ORDER BY id')
							.toArray()
					}
				})
			);
			const serialised = JSON.stringify(persisted);

			expect({
				persisted,
				containsOriginalSecret: serialised.includes(originalSecret),
				containsSuccessorSecret: serialised.includes(successorSecret),
				containsCiphertext: serialised.includes('ciphertext'),
				containsIv: serialised.includes('"iv"')
			}).toStrictEqual({
				persisted: {
					families: [
						{
							id: persisted.families[0]?.id,
							active_member_id: successorId,
							generation: 1,
							rule_id: 'admin-rule',
							subject: 'alice',
							created_at: '2026-01-01T00:00:00.000Z',
							expires_at: '2026-01-31T00:00:00.000Z'
						}
					],
					members: [
						{
							id: originalId,
							family_id: persisted.families[0]?.id,
							generation: 0,
							secret_hash: originalHash,
							created_at: '2026-01-01T00:00:00.000Z'
						},
						{
							id: successorId,
							family_id: persisted.families[0]?.id,
							generation: 1,
							secret_hash: successorHash,
							created_at: '2026-01-01T00:00:00.000Z'
						}
					],
					legacy: { live: [] }
				},
				containsOriginalSecret: false,
				containsSuccessorSecret: false,
				containsCiphertext: false,
				containsIv: false
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
			await migrateThrough(state, latestPreContractMigrationIndex);
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
		const original = exchanged.refresh_token ?? '';
		const [originalMemberId] = z
			.tuple([z.uuid(), z.string()])
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
				'UPDATE refresh_token_family SET generation = ? WHERE id = ?',
				activeGeneration,
				family.id
			);
			state.storage.sql.exec(
				'UPDATE refresh_token_member SET generation = ? WHERE id = ?',
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
				 INSERT INTO refresh_token_member (id, family_id, generation, secret_hash, created_at)
				 SELECT printf('spent-%d', value), ?, value, lower(hex(randomblob(32))), ?
				 FROM generations
				 WHERE value < ?`,
				family.id,
				family.createdAt,
				activeGeneration
			);
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

	it('revokes the family when the same refresh token is presented concurrently', async () => {
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
				const okStatusCode: number = StatusCodes.OK;
				const responses = await Promise.all([
					instance.fetch(present()),
					instance.fetch(present())
				]);

				return Promise.all(
					responses.map(async (response) => {
						if (response.status === okStatusCode) {
							const body = tokenResponseSchema.parse(await response.json());

							return {
								status: response.status,
								refreshToken: body.refresh_token ?? ''
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
		const granted = outcomes.find(
			(outcome): outcome is { status: number; refreshToken: string } =>
				'refreshToken' in outcome
		);
		const refused = outcomes.find(
			(
				outcome
			): outcome is {
				status: number;
				error: string;
				problem: string | undefined;
			} => 'error' in outcome
		);
		const grantedToken = z.string().min(1).parse(granted?.refreshToken);
		const successorAfterReplay = await staleRefreshOutcome(grantedToken);

		expect({
			exchangeStatus: exchanged.status,
			statuses: outcomes
				.map((outcome) => outcome.status)
				.toSorted((left, right) => left - right),
			refused,
			successorAfterReplay,
			families: await refreshTokenRows(),
			members: await refreshTokenMemberRows()
		}).toStrictEqual({
			exchangeStatus: StatusCodes.OK,
			statuses: [StatusCodes.OK, StatusCodes.BAD_REQUEST].toSorted(
				(left, right) => left - right
			),
			refused: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			successorAfterReplay: {
				status: StatusCodes.BAD_REQUEST,
				error: 'invalid_grant',
				problem: 'stale-refresh-token'
			},
			families: [],
			members: []
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

	it('refuses a refresh completed after its trust rule is removed', async () => {
		const subjectToken = await installTrustedIdp('admin');
		const exchanged = await exchange(subjectToken);
		const ruleId = trustRuleIdSchema.parse('admin-rule');

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const signingStarted = Promise.withResolvers<undefined>();
				const releaseSigning = Promise.withResolvers<undefined>();
				const tenantIdentity = new TenantIdentityService(instance.context);
				const authKeys = new AuthKeysService(instance.context, tenantIdentity);
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
					oidcTrustService.removeRule(ruleId);
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
					families: database.select().from(refreshTokenFamilies).all(),
					members: database.select().from(refreshTokenMembers).all()
				};
			}
		);

		expect(outcome).toStrictEqual({
			result: { kind: 'refused' },
			families: [],
			members: []
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
			.tuple([z.uuid(), z.string()])
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

					await instance.runGarbageCollection();
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
				continuation: [
					{ scope: 'tenant', collectLimit: maxPathsCollectedPerRun }
				]
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
					"UPDATE refresh_token_family SET expires_at = '2019-01-01T00:00:00.000Z', generation = ? WHERE id = ?",
					maxRefreshTokenMembersDeletedPerRun,
					largeFamily.id
				);
				state.storage.sql.exec(
					'UPDATE refresh_token_member SET generation = ? WHERE id = ?',
					maxRefreshTokenMembersDeletedPerRun,
					largeFamily.activeMemberId
				);
				state.storage.sql.exec(
					"UPDATE refresh_token_family SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
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
					 INSERT INTO refresh_token_member (id, family_id, generation, secret_hash, created_at)
					 SELECT printf('gc-spent-%d', value), ?, value, lower(hex(randomblob(32))), '2019-01-01T00:00:00.000Z'
					 FROM generations
					 WHERE value < ?`,
					largeFamily.id,
					maxRefreshTokenMembersDeletedPerRun
				);
				await instance.runGarbageCollection();
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
			continuation: [
				{ scope: 'tenant', collectLimit: maxPathsCollectedPerRun }
			],
			backlogs: [
				{
					level: 'warning',
					properties: {
						job: 'garbage-collection',
						method: 'garbage-collection',
						membersDeleted: maxRefreshTokenMembersDeletedPerRun,
						familiesDeleted: 0
					}
				}
			]
		});

		const afterSecondPass = await runInDurableObject(
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

		expect({
			families: afterSecondPass.families.length,
			members: afterSecondPass.members.length,
			memberFamily: afterSecondPass.members[0]?.familyId,
			familyId: afterSecondPass.families[0]?.id,
			continuation: afterSecondPass.continuation
		}).toStrictEqual({
			families: 1,
			members: 1,
			memberFamily: afterSecondPass.families[0]?.id,
			familyId: afterSecondPass.families[0]?.id,
			continuation: [{ scope: 'tenant', collectLimit: maxPathsCollectedPerRun }]
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
				cache: { exact: 'private', kind: 'named', validate: 'cacheName' }
			}
		};
		await installAdditionalTrustRule('private-rule', [privateGrant]);
		const requested = [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: { kind: 'named', name: 'private' }
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

	it('refuses tied rules that both permit the requested authority', async () => {
		const subjectToken = await installTrustedIdp('write');
		const overlappingGrant: PermittedGrant = {
			type: 'cupboard_cache',
			actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
			resources: {
				cache: { exact: 'ci', kind: 'named', validate: 'cacheName' }
			}
		};
		await installAdditionalTrustRule('overlapping-rule', [overlappingGrant]);

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken,
			authorization_details: JSON.stringify(ciRequest)
		});
		const body = oauthErrorShape(await response.json());

		expect({
			status: response.status,
			problem: body.problem,
			detail: body.detail
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			problem: 'subject-token-untrusted',
			detail: undefined
		});
	});

	it('does not combine requested authority from separate rules', async () => {
		const subjectToken = await installTrustedIdp('write');
		const privateGrant: PermittedGrant = {
			type: 'cupboard_cache',
			actions: ['upload:commit'],
			resources: {
				cache: { exact: 'private', kind: 'named', validate: 'cacheName' }
			}
		};
		await installAdditionalTrustRule('private-rule', [privateGrant]);
		const requested = [
			...ciRequest,
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: { kind: 'named', name: 'private' }
			}
		];

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken,
			authorization_details: JSON.stringify(requested)
		});
		const body = oauthErrorShape(await response.json());

		expect({ status: response.status, body }).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			body: {
				error: 'invalid_authorization_details',
				error_description:
					'The requested authorization_details are not permitted',
				problem: 'not-permitted'
			}
		});
	});

	it('confines a grant for a named selector to that cache', async () => {
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
				cache: { kind: 'named', name: 'ci' }
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
					cache: { kind: 'named', name: 'other' }
				}
			]),
			problem: 'not-permitted'
		},
		{
			name: "an operation outside the rule's permissions",
			details: JSON.stringify([
				{
					type: 'cupboard_cache',
					actions: ['gc:run'],
					cache: { kind: 'named', name: 'ci' }
				}
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
				cache: { kind: 'named', name: 'pr-1' }
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
				cache: { kind: 'named', name: 'pr-1' }
			}
		]);
		const narrowed = tokenResponseSchema.parse(await narrowResponse.json());

		const otherCache = await attenuate(narrowed.access_token, [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: { kind: 'named', name: 'pr-2' }
			}
		]);
		const otherOp = await attenuate(narrowed.access_token, [
			{
				type: 'cupboard_cache',
				actions: ['gc:run'],
				cache: { kind: 'named', name: 'pr-1' }
			}
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
				cache: { kind: 'named', name: 'pr-1' }
			}
		]);
		const narrowed = tokenResponseSchema.parse(await narrowResponse.json());

		const confirmAttempt = await attenuate(narrowed.access_token, [
			{
				type: 'cupboard_cache',
				actions: ['upload:confirm'],
				cache: { kind: 'named', name: 'pr-1' }
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
				cache: { kind: 'named', name: 'pr-1' }
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
				cache: { kind: 'named', name: 'pr-1' }
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
				cache: { kind: 'named', name: 'pr-1' }
			}
		];
		const narrower = [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: { kind: 'named', name: 'pr-1' }
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
		await migrateThrough(state, latestPreContractMigrationIndex);
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
			cache: { exact: 'other', kind: 'named', validate: 'cacheName' }
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
