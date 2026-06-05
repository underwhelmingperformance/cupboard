import {
	subjectTokenTypeIdToken,
	tokenExchangeGrantType
} from '@cupboard/protocol/oidc';
import { StatusCodes } from 'http-status-codes';
import { generateKeyPair, SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	controlFetch,
	currentOrigin,
	resetTestServer,
	seedControlTrust
} from '../test-support.ts';

interface OAuthError {
	readonly error: string;
	readonly error_description: string;
}

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

// A well-formed token for a given issuer/audience. With no control trust rule it
// matches nothing; with a rule it routes there but its issuer's JWKS is never
// reachable in these tests, so the signature is never confirmed.
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

	it.each([
		{
			name: 'an unsupported grant type',
			form: {
				grant_type: 'authorization_code',
				subject_token: 'x',
				subject_token_type: subjectTokenTypeIdToken
			},
			status: StatusCodes.BAD_REQUEST,
			error: 'unsupported_grant_type'
		},
		{
			name: 'an unsupported subject token type',
			form: {
				grant_type: tokenExchangeGrantType,
				subject_token: 'x',
				subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
			},
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_request'
		},
		{
			name: 'a subject token that is not a JWT',
			form: {
				grant_type: tokenExchangeGrantType,
				subject_token: 'not-a-jwt',
				subject_token_type: subjectTokenTypeIdToken
			},
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_grant'
		}
	])('rejects $name', async ({ form, status, error }) => {
		const response = await postToken(form);
		const body = await response.json<OAuthError>();

		expect({ status: response.status, error: body.error }).toStrictEqual({
			status,
			error
		});
	});

	it('refuses a token matching no control trust rule with invalid_grant', async () => {
		const subjectToken = await signedToken({
			issuer: 'https://idp.example.test',
			audience: 'cupboard-control'
		});

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});
		const body = await response.json<OAuthError>();

		expect({ status: response.status, error: body.error }).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_grant'
		});
	});

	it('reports 503, not invalid_grant, when the matched issuer is unreachable', async () => {
		const issuer = 'https://unreachable.example.test';

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

		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenTypeIdToken
		});

		expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
	});

	it.each<{ name: string; override: Readonly<Record<string, string>> }>([
		{ name: 'the wrapping secret', override: { CONTROL_KEY_WRAP_SECRET: '' } },
		{ name: 'the audience', override: { CUPBOARD_CONTROL_AUDIENCE: '' } }
	])(
		'reports 503 when $name is not configured, minting nothing',
		async ({ override }) => {
			const response = await postToken(
				{
					grant_type: tokenExchangeGrantType,
					subject_token: 'x',
					subject_token_type: subjectTokenTypeIdToken
				},
				override
			);

			expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
		}
	);

	it('refuses to mint, failing closed, when a control trust rule pins no subject', async () => {
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

		expect(response.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
	});

	it('reports 503 for authorization-server metadata when the control audience is unset', async () => {
		const response = await controlFetch(
			'/.well-known/oauth-authorization-server',
			undefined,
			{ CUPBOARD_CONTROL_AUDIENCE: '' }
		);

		expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
	});

	it('publishes the control JWKS, distinct from any tenant key', async () => {
		const response = await controlFetch('/.well-known/jwks.json');
		const body = await response.json<{
			keys: {
				kty: string;
				crv: string;
				kid: string;
				alg: string;
				use: string;
			}[];
		}>();

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			count: body.keys.length,
			key: {
				kty: body.keys[0]?.kty,
				crv: body.keys[0]?.crv,
				alg: body.keys[0]?.alg,
				use: body.keys[0]?.use,
				hasKid: typeof body.keys[0]?.kid === 'string'
			}
		}).toStrictEqual({
			status: StatusCodes.OK,
			cacheControl: 'no-cache',
			count: 1,
			key: {
				kty: 'OKP',
				crv: 'Ed25519',
				alg: 'EdDSA',
				use: 'sig',
				hasKid: true
			}
		});
	});

	it('serves control authorization-server metadata at the bare host', async () => {
		const response = await controlFetch(
			'/.well-known/oauth-authorization-server'
		);
		const origin = currentOrigin();
		const body = await response.json();

		expect({ status: response.status, body }).toStrictEqual({
			status: StatusCodes.OK,
			body: {
				issuer: origin,
				token_endpoint: `${origin}/token`,
				jwks_uri: `${origin}/.well-known/jwks.json`,
				grant_types_supported: [tokenExchangeGrantType],
				scopes_supported: ['admin'],
				token_endpoint_auth_methods_supported: ['none']
			}
		});
	});
});
