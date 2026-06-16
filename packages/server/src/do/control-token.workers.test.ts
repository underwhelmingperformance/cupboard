import {
	subjectTokenTypeIdToken,
	tokenExchangeGrantType
} from '@cupboard/protocol/oidc';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { controlTokenExchange } from '../control/control-plane.ts';
import {
	ControlSubjectTokenUntrustedError,
	SubjectTokenNotJwtError,
	UnsupportedGrantTypeError,
	UnsupportedSubjectTokenTypeError
} from '../errors.ts';
import {
	controlFetch,
	currentOrigin,
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

const jwksResponseSchema = z.strictObject({
	keys: z.tuple([
		z.strictObject({
			kty: z.string(),
			crv: z.string(),
			kid: z.string().min(1),
			alg: z.string(),
			use: z.string(),
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
	authorization_details_types_supported: z.array(z.string()),
	token_endpoint_auth_methods_supported: z.array(z.string())
});

function postToken(
	form: Record<string, string>,
	envOverride: Readonly<Record<string, string>> = {}
): Promise<Response> {
	return controlFetch(
		'/token',
		{
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(form).toString()
		},
		envOverride
	);
}

function tokenExchangeRequest(form: Record<string, string>): Request {
	return new Request(new URL('/token', currentOrigin()), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(form).toString()
	});
}

function tokenExchangeError(form: Record<string, string>): Promise<unknown> {
	return controlTokenExchange(
		tokenExchangeRequest(form),
		Object.assign({}, env, testControlEnv)
	).catch((error: unknown) => error);
}

// A well-formed token for a given issuer/audience. With no control trust rule it
// matches nothing; with a rule it routes there but issuer discovery or key
// retrieval is unavailable in these tests, so the signature is never confirmed.
async function signedToken(options: {
	issuer: string;
	audience: string;
	subject?: string;
}): Promise<string> {
	const { privateKey } = await generateKeyPair('RS256', { extractable: true });

	return new SignJWT({})
		.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
		.setIssuer(options.issuer)
		.setAudience(options.audience)
		.setSubject(options.subject ?? 'someone')
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
			subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
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
			name: 'the subject token is not a JWT',
			form: () =>
				Promise.resolve({
					grant_type: tokenExchangeGrantType,
					subject_token: 'not-a-jwt',
					subject_token_type: subjectTokenTypeIdToken
				}),
			error: SubjectTokenNotJwtError
		},
		{
			name: 'no control trust rule matches the subject token',
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
	])('rejects when $name', async ({ form, error }) => {
		expect(await tokenExchangeError(await form())).toBeInstanceOf(error);
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

	it.each<{ name: string; override: Readonly<Record<string, string>> }>([
		{ name: 'the wrapping secret', override: { CONTROL_KEY_WRAP_SECRET: '' } },
		{ name: 'the audience', override: { CUPBOARD_CONTROL_AUDIENCE: '' } }
	])(
		'reports 503 when $name is not configured, issuing nothing',
		async ({ override }) => {
			const response = await postToken(
				{
					grant_type: tokenExchangeGrantType,
					subject_token: 'x',
					subject_token_type: subjectTokenTypeIdToken
				},
				override
			);
			await response.text();

			expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
		}
	);

	it('refuses to issue, failing closed, when a control trust rule pins no subject', async () => {
		// An admin-scoped rule with no pinned subject would match every subject of
		// the trusted issuer and audience, so it must be rejected rather than honoured.
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

	it('reports 503 for authorization-server metadata when the control audience is unset', async () => {
		const response = await controlFetch(
			'/.well-known/oauth-authorization-server',
			undefined,
			{ CUPBOARD_CONTROL_AUDIENCE: '' }
		);
		await response.text();

		expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
	});

	it('publishes the control JWKS, distinct from any tenant key', async () => {
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
