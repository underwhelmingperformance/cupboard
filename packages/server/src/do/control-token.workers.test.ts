import {
	issuedAccessTokenType,
	subjectTokenTypeIdToken,
	tokenExchangeGrantType,
	tokenResponseSchema
} from '@cupboard/protocol/oidc';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	controlOidcTrustRemove,
	controlTokenExchange
} from '../control/control-plane.ts';
import {
	ControlSubjectTokenUntrustedError,
	StoredControlTrustInvalidError,
	SubjectTokenNotJwtError,
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
	token_endpoint_auth_methods_supported: z.array(z.string())
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
			Object.assign({}, env, testControlEnv)
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

async function trustedControlToken(protectedType: string): Promise<string> {
	const issuer = `https://idp-${crypto.randomUUID()}.example.test`;
	const audience = 'cupboard-control';
	const { publicKey, privateKey } = await generateKeyPair('RS256', {
		extractable: true
	});
	const publicJwk = await exportJWK(publicKey);

	await seedControlTrust({
		issuer,
		audience,
		claims: { sub: 'global-admin' }
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

	return new SignJWT({})
		.setProtectedHeader({ alg: 'RS256', kid: 'idp', typ: protectedType })
		.setIssuer(issuer)
		.setAudience(audience)
		.setSubject('global-admin')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(privateKey);
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

	it('does not relabel an external access JWT as an ID token', async () => {
		const subjectToken = await trustedControlToken('at+jwt');
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

		expect(await exchange).toBeInstanceOf(ControlSubjectTokenUntrustedError);
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
				grant_types_supported: [tokenExchangeGrantType],
				authorization_details_types_supported: [
					'cupboard_tenant',
					'cupboard_control',
					'cupboard_wildcard'
				],
				token_endpoint_auth_methods_supported: ['none']
			}
		});
	});
});
