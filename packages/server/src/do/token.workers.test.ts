import {
	subjectTokenTypeIdToken,
	subjectTokenTypeJwt,
	tokenExchangeGrantType
} from '@cupboard/protocol/oidc';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { generateKeyPair, SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';

import { oidcTrust } from '../db/schema.ts';
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

interface OAuthError {
	readonly error: string;
	readonly error_description: string;
}

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

describe('POST /token', () => {
	beforeEach(resetTestServer);

	it.each([
		{
			name: 'an unsupported grant type',
			form: () =>
				Promise.resolve({
					grant_type: 'authorization_code',
					subject_token: 'x',
					subject_token_type: subjectTokenTypeIdToken
				}),
			error: 'unsupported_grant_type',
			error_description: 'Unsupported grant type: authorization_code'
		},
		{
			name: 'an unsupported subject token type',
			form: () =>
				Promise.resolve({
					grant_type: tokenExchangeGrantType,
					subject_token: 'x',
					subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
				}),
			error: 'invalid_request',
			error_description:
				'Unsupported subject_token_type: urn:ietf:params:oauth:token-type:access_token'
		},
		{
			name: 'a subject token that is not a JWT',
			form: () =>
				Promise.resolve({
					grant_type: tokenExchangeGrantType,
					subject_token: 'not-a-jwt',
					subject_token_type: subjectTokenTypeIdToken
				}),
			error: 'invalid_grant',
			error_description: 'Subject token is not a JWT'
		},
		{
			name: 'a subject token matching no trust rule',
			form: async () => ({
				grant_type: tokenExchangeGrantType,
				subject_token: await untrustedToken(),
				subject_token_type: subjectTokenTypeJwt
			}),
			error: 'invalid_grant',
			error_description: 'No trust rule matches the subject token'
		}
	])('rejects $name', async ({ form, error, error_description }) => {
		const response = await postToken(await form());

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			body: await response.json<OAuthError>()
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			cacheControl: 'no-store',
			body: { error, error_description }
		});
	});

	it('rejects a request missing a required field as invalid_request', async () => {
		const response = await postToken({
			grant_type: tokenExchangeGrantType,
			subject_token_type: 'jwt'
		});
		const body = await response.json<OAuthError>();

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			error: body.error
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			cacheControl: 'no-store',
			error: 'invalid_request'
		});
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

		expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
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
		const [rule] = rules;
		const { disabledAt, createdAt, ...stable } = rule ?? {};

		expect(disabledAt).toBeNull();
		expect(typeof createdAt).toBe('string');
		expect(stable).toStrictEqual({
			id: 'owner',
			issuer: 'https://accounts.google.com',
			audience: 'client-id.apps.googleusercontent.com',
			scope: 'admin',
			claimsJson: JSON.stringify({ sub: 'owner-subject' }),
			allowedRootsJson: '[]'
		});
	});

	it('removes the owner rule when owner config is cleared on redeploy', async () => {
		await fetchPath('/.well-known/jwks.json');

		const remaining = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				instance.context.env = {
					...instance.context.env,
					CUPBOARD_OWNER_ISSUER: '',
					CUPBOARD_OWNER_SUBJECT: '',
					CUPBOARD_OWNER_AUDIENCE: ''
				};
				instance.seedOwnerRule();

				return drizzle(state.storage, { schema: { oidcTrust } })
					.select()
					.from(oidcTrust)
					.all();
			}
		);

		expect(remaining).toStrictEqual([]);
	});

	it('refuses to seed when the owner issuer is malformed', async () => {
		// Initialise the Durable Object so its schema (which owner-rule seeding now
		// consults for a configured identity) is in place before seeding.
		await fetchPath('/.well-known/jwks.json');

		const outcome = await runInDurableObject(currentServer(), (instance) => {
			instance.context.env = {
				...instance.context.env,
				CUPBOARD_OWNER_ISSUER: 'not-a-url'
			};

			try {
				instance.seedOwnerRule();

				return 'did not throw';
			} catch (error) {
				return error instanceof Error ? error.name : 'unknown';
			}
		});

		expect(outcome).toBe('OwnerConfigurationInvalidError');
	});
});

describe('auth discovery endpoints', () => {
	beforeEach(resetTestServer);

	it('serves the auth public key as a JWKS from the Durable Object', async () => {
		const response = await fetchPath('/.well-known/jwks.json');
		const body = await response.json<{ keys: JsonWebKeyWithKid[] }>();
		const [key] = body.keys;

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			count: body.keys.length,
			kty: key?.kty,
			crv: key?.crv,
			alg: key?.alg,
			use: key?.use,
			kid: typeof key?.kid,
			x: typeof key?.x
		}).toStrictEqual({
			status: StatusCodes.OK,
			cacheControl: 'no-cache',
			count: 1,
			kty: 'OKP',
			crv: 'Ed25519',
			alg: 'EdDSA',
			use: 'sig',
			kid: 'string',
			x: 'string'
		});
	});

	it('serves OAuth authorization-server metadata at the edge', async () => {
		const response = await readFetch('/.well-known/oauth-authorization-server');
		const origin = currentOrigin();

		expect({
			status: response.status,
			body: await response.json()
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: {
				// Mirrors CUPBOARD_AUTH_ISSUER (set in wrangler.toml), the issuer
				// cupboard stamps into its own tokens.
				issuer: 'cupboard',
				// The endpoints carry this tenant's `/t/<tenant>/` prefix.
				token_endpoint: `${origin}/t/v1/token`,
				jwks_uri: `${origin}/t/v1/.well-known/jwks.json`,
				grant_types_supported: [tokenExchangeGrantType],
				scopes_supported: ['write', 'admin'],
				token_endpoint_auth_methods_supported: ['none']
			}
		});
	});
});
