import { describe, expect, it } from 'vitest';

import { AuthorizationAccessDeniedError } from '../auth/oidc-login.ts';
import { UnreachableHostError } from '../errors.ts';

import {
	type CloudflareGrant,
	cloudflareLogin,
	cloudflareOauthClientId,
	CloudflareTokenRequestError,
	deployScopes,
	refreshCloudflareGrant
} from './cloudflare-oauth.ts';

const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';

type ErrorConstructor<T extends Error> = abstract new (
	...arguments_: never[]
) => T;

function expectError<T extends Error>(
	error: unknown,
	errorClass: ErrorConstructor<T>
): asserts error is T {
	expect(error).toBeInstanceOf(errorClass);
}

async function rejectedBy<T extends Error>(
	promise: Promise<unknown>,
	errorClass: ErrorConstructor<T>
): Promise<T> {
	let rejection: unknown;

	try {
		await promise;
	} catch (error) {
		rejection = error;
	}

	expectError(rejection, errorClass);

	return rejection;
}

function idToken(subject: string): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString(
		'base64url'
	);
	const payload = Buffer.from(JSON.stringify({ sub: subject })).toString(
		'base64url'
	);

	return `${header}.${payload}.signature`;
}

interface RecordedRequest {
	readonly url: string;
	readonly form: URLSearchParams;
}

function fakeCloudflare(options: {
	readonly tokenBody: Record<string, unknown>;
	readonly tokenStatus?: number;
}): { fetcher: typeof fetch; tokenRequests: RecordedRequest[] } {
	const tokenRequests: RecordedRequest[] = [];

	const fetcher: typeof fetch = (input, init) => {
		let url: string;

		if (typeof input === 'string') {
			url = input;
		} else if (input instanceof URL) {
			url = input.href;
		} else {
			url = input.url;
		}

		const form = typeof init?.body === 'string' ? init.body : '';
		expect({ url }).toStrictEqual({ url: tokenEndpoint });
		tokenRequests.push({ url, form: new URLSearchParams(form) });

		return Promise.resolve(
			Response.json(options.tokenBody, { status: options.tokenStatus ?? 200 })
		);
	};

	return { fetcher, tokenRequests };
}

function approvingBrowser(code: string): (url: string) => Promise<void> {
	return async (url) => {
		const authorize = new URL(url);
		const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
		redirect.searchParams.set('code', code);
		redirect.searchParams.set(
			'state',
			authorize.searchParams.get('state') ?? ''
		);

		await fetch(redirect);
	};
}

describe('cloudflareLogin', () => {
	it('completes the PKCE flow and returns the issued grant', async () => {
		const { fetcher, tokenRequests } = fakeCloudflare({
			tokenBody: {
				access_token: 'access-1',
				refresh_token: 'refresh-1',
				expires_in: 3600
			}
		});
		let authorizeUrl = '';

		const grant = await cloudflareLogin({
			openBrowser: async (url) => {
				authorizeUrl = url;
				await approvingBrowser('code-1')(url);
			},
			fetcher,
			ports: [0],
			now: () => 1_000_000
		});

		expect(grant).toStrictEqual({
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			expiresAt: 1_000_000 + 3600 * 1000,
			subject: undefined,
			idToken: undefined
		});

		const authorize = new URL(authorizeUrl);

		expect({
			clientId: authorize.searchParams.get('client_id'),
			scope: authorize.searchParams.get('scope'),
			challengeMethod: authorize.searchParams.get('code_challenge_method'),
			tokenRequests: tokenRequests.map(({ url, form }) => ({
				url,
				grantType: form.get('grant_type'),
				code: form.get('code'),
				clientId: form.get('client_id'),
				redirectUri: form.get('redirect_uri')
			}))
		}).toStrictEqual({
			clientId: cloudflareOauthClientId,
			scope: deployScopes.join(' '),
			challengeMethod: 'S256',
			tokenRequests: [
				{
					url: tokenEndpoint,
					grantType: 'authorization_code',
					code: 'code-1',
					clientId: cloudflareOauthClientId,
					redirectUri: authorize.searchParams.get('redirect_uri')
				}
			]
		});
	});

	it('captures the deployer identity from the id_token', async () => {
		const issued = idToken('cf-user-1');
		const { fetcher } = fakeCloudflare({
			tokenBody: {
				access_token: 'access-1',
				expires_in: 3600,
				id_token: issued
			}
		});

		const grant = await cloudflareLogin({
			openBrowser: approvingBrowser('code-1'),
			fetcher,
			ports: [0],
			now: () => 0
		});

		expect({
			subject: grant.subject,
			idToken: grant.idToken,
			deployScopes
		}).toStrictEqual({
			subject: 'cf-user-1',
			idToken: issued,
			deployScopes: [
				'account-settings.write',
				'd1.write',
				'offline_access',
				'openid',
				'queues.write',
				'workers-kv-storage.write',
				'workers-r2.write',
				'workers-routes.write',
				'workers-scripts.write',
				'zone.read'
			]
		});
	});

	it('tolerates a malformed id_token, leaving the identity unknown', async () => {
		const { fetcher } = fakeCloudflare({
			tokenBody: {
				access_token: 'access-1',
				expires_in: 3600,
				id_token: 'not-a-jwt'
			}
		});

		const grant = await cloudflareLogin({
			openBrowser: approvingBrowser('code-1'),
			fetcher,
			ports: [0],
			now: () => 0
		});

		expect(grant.subject).toBeUndefined();
	});

	it('rejects with the HTTP status when the token exchange fails', async () => {
		const { fetcher } = fakeCloudflare({
			tokenBody: { error: 'invalid_grant' },
			tokenStatus: 400
		});

		const login = cloudflareLogin({
			openBrowser: approvingBrowser('code-3'),
			fetcher,
			ports: [0]
		});

		const error = await rejectedBy(login, CloudflareTokenRequestError);

		expect({ name: error.name, status: error.status }).toStrictEqual({
			name: 'CloudflareTokenRequestError',
			status: 400
		});
	});

	it('rejects with the provider error when authorization is declined', async () => {
		const { fetcher } = fakeCloudflare({ tokenBody: {} });

		const login = cloudflareLogin({
			openBrowser: async (url) => {
				const authorize = new URL(url);
				const redirect = new URL(
					authorize.searchParams.get('redirect_uri') ?? ''
				);
				redirect.searchParams.set('error', 'access_denied');
				redirect.searchParams.set(
					'state',
					authorize.searchParams.get('state') ?? ''
				);
				await fetch(redirect);
			},
			fetcher,
			ports: [0]
		});

		const error = await rejectedBy(login, AuthorizationAccessDeniedError);

		expect({
			name: error.name,
			providerError: error.providerError
		}).toStrictEqual({
			name: 'AuthorizationAccessDeniedError',
			providerError: 'access_denied'
		});
	});
});

describe('refreshCloudflareGrant', () => {
	const previous: CloudflareGrant = {
		accessToken: 'access-old',
		refreshToken: 'refresh-old',
		expiresAt: 0,
		subject: 'cf-user-1',
		idToken: 'id-token-old'
	};

	it('renews the grant, keeping the refresh token and identity when not reissued', async () => {
		const { fetcher, tokenRequests } = fakeCloudflare({
			tokenBody: { access_token: 'access-4', expires_in: 1800 }
		});

		const grant = await refreshCloudflareGrant(previous, fetcher, () => 5000);

		expect({
			grant,
			tokenRequests: tokenRequests.map(({ url, form }) => ({
				url,
				grantType: form.get('grant_type'),
				refreshToken: form.get('refresh_token')
			}))
		}).toStrictEqual({
			grant: {
				accessToken: 'access-4',
				refreshToken: 'refresh-old',
				expiresAt: 5000 + 1800 * 1000,
				subject: 'cf-user-1',
				idToken: undefined
			},
			tokenRequests: [
				{
					url: tokenEndpoint,
					grantType: 'refresh_token',
					refreshToken: 'refresh-old'
				}
			]
		});
	});

	it('adopts a rotated refresh token and a reissued identity', async () => {
		const reissued = idToken('cf-user-2');
		const { fetcher } = fakeCloudflare({
			tokenBody: {
				access_token: 'access-5',
				refresh_token: 'refresh-new',
				expires_in: 1800,
				id_token: reissued
			}
		});

		const grant = await refreshCloudflareGrant(previous, fetcher, () => 0);

		expect({
			refreshToken: grant?.refreshToken,
			subject: grant?.subject,
			idToken: grant?.idToken
		}).toStrictEqual({
			refreshToken: 'refresh-new',
			subject: 'cf-user-2',
			idToken: reissued
		});
	});

	it('returns undefined when the grant has no refresh token', async () => {
		const { fetcher, tokenRequests } = fakeCloudflare({ tokenBody: {} });

		expect({
			grant: await refreshCloudflareGrant(
				{ ...previous, refreshToken: undefined },
				fetcher
			),
			requests: tokenRequests
		}).toStrictEqual({ grant: undefined, requests: [] });
	});

	it('returns undefined when Cloudflare declines the refresh', async () => {
		const { fetcher } = fakeCloudflare({
			tokenBody: { error: 'invalid_grant' },
			tokenStatus: 401
		});

		expect(await refreshCloudflareGrant(previous, fetcher)).toBeUndefined();
	});

	it('surfaces a transport failure instead of starting a new login', async () => {
		const cause = new TypeError('fetch failed', {
			cause: { code: 'ECONNREFUSED' }
		});
		const failure = new UnreachableHostError('dash.cloudflare.com', cause);

		await expect(
			refreshCloudflareGrant(previous, () => Promise.reject(failure))
		).rejects.toBe(failure);
	});

	it.each([
		['invalid_request', 400],
		['invalid_client', 401]
	])(
		'surfaces the %s response instead of starting a new login',
		async (code, status) => {
			const { fetcher } = fakeCloudflare({
				tokenBody: { error: code },
				tokenStatus: status
			});

			const error = await rejectedBy(
				refreshCloudflareGrant(previous, fetcher),
				CloudflareTokenRequestError
			);

			expect({
				status: error.status,
				providerError: error.providerError
			}).toStrictEqual({
				status,
				providerError: code
			});
		}
	);

	it('surfaces a malformed success response instead of starting a new login', async () => {
		const { fetcher } = fakeCloudflare({ tokenBody: {} });

		await expect(
			refreshCloudflareGrant(previous, fetcher)
		).rejects.toMatchObject({
			name: 'CloudflareTokenResponseMalformedError'
		});
	});

	it('surfaces a network failure instead of starting a new login', async () => {
		const failure = new TypeError('fetch failed', {
			cause: { code: 'ECONNREFUSED' }
		});
		const fetcher: typeof fetch = () => Promise.reject(failure);

		await expect(refreshCloudflareGrant(previous, fetcher)).rejects.toBe(
			failure
		);
	});

	it('surfaces an unrelated fetcher error instead of starting a new login', async () => {
		const failure = new TypeError('response decoder failed');
		const fetcher: typeof fetch = () => Promise.reject(failure);

		await expect(refreshCloudflareGrant(previous, fetcher)).rejects.toBe(
			failure
		);
	});

	it('surfaces an abort instead of starting a new login', async () => {
		const controller = new AbortController();
		controller.abort(new Error('cancelled by test'));

		await expect(
			refreshCloudflareGrant(previous, fetch, Date.now, controller.signal)
		).rejects.toThrow('cancelled by test');
	});
});
