import { describe, expect, it } from 'vitest';

import { AuthorizationAccessDeniedError } from '../auth/oidc-login.ts';

import {
	cloudflareLogin,
	cloudflareOauthClientId,
	CloudflareTokenRequestError,
	deployScopes,
	refreshCloudflareGrant
} from './cloudflare-oauth.ts';

const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';

interface RecordedRequest {
	readonly url: string;
	readonly form: URLSearchParams;
}

/**
 * A fetcher standing in for Cloudflare's token endpoint, answering with
 * `tokenBody`. Any other request is unexpected and fails the test.
 */
function fakeCloudflare(options: {
	readonly tokenBody: Record<string, unknown>;
	readonly tokenStatus?: number;
}): { fetcher: typeof fetch; tokenRequests: RecordedRequest[] } {
	const tokenRequests: RecordedRequest[] = [];

	const fetcher: typeof fetch = (input, init) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.toString()
					: input.url;

		if (url !== tokenEndpoint) {
			throw new Error(`Unexpected fetch: ${url}`);
		}

		const form = typeof init?.body === 'string' ? init.body : '';
		tokenRequests.push({ url, form: new URLSearchParams(form) });

		return Promise.resolve(
			Response.json(options.tokenBody, { status: options.tokenStatus ?? 200 })
		);
	};

	return { fetcher, tokenRequests };
}

/** Follows the authorize URL like a browser that approves the login. */
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
			expiresAt: 1_000_000 + 3600 * 1000
		});

		const authorize = new URL(authorizeUrl);
		const exchange = tokenRequests[0];

		expect({
			clientId: authorize.searchParams.get('client_id'),
			scope: authorize.searchParams.get('scope'),
			challengeMethod: authorize.searchParams.get('code_challenge_method'),
			grantType: exchange?.form.get('grant_type'),
			code: exchange?.form.get('code'),
			exchangeClientId: exchange?.form.get('client_id'),
			redirectUri: exchange?.form.get('redirect_uri')
		}).toStrictEqual({
			clientId: cloudflareOauthClientId,
			scope: deployScopes.join(' '),
			challengeMethod: 'S256',
			grantType: 'authorization_code',
			code: 'code-1',
			exchangeClientId: cloudflareOauthClientId,
			redirectUri: authorize.searchParams.get('redirect_uri')
		});
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

		await expect(login).rejects.toStrictEqual(
			new CloudflareTokenRequestError(400)
		);
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

		await expect(login).rejects.toStrictEqual(
			new AuthorizationAccessDeniedError()
		);
	});
});

describe('refreshCloudflareGrant', () => {
	it('renews the grant and keeps the previous refresh token when none is reissued', async () => {
		const { fetcher, tokenRequests } = fakeCloudflare({
			tokenBody: { access_token: 'access-4', expires_in: 1800 }
		});

		const grant = await refreshCloudflareGrant(
			'refresh-old',
			fetcher,
			() => 5000
		);

		expect({
			grant,
			grantType: tokenRequests[0]?.form.get('grant_type'),
			refreshToken: tokenRequests[0]?.form.get('refresh_token')
		}).toStrictEqual({
			grant: {
				accessToken: 'access-4',
				refreshToken: 'refresh-old',
				expiresAt: 5000 + 1800 * 1000
			},
			grantType: 'refresh_token',
			refreshToken: 'refresh-old'
		});
	});

	it('adopts a rotated refresh token', async () => {
		const { fetcher } = fakeCloudflare({
			tokenBody: {
				access_token: 'access-5',
				refresh_token: 'refresh-new',
				expires_in: 1800
			}
		});

		const grant = await refreshCloudflareGrant('refresh-old', fetcher, () => 0);

		expect(grant?.refreshToken).toBe('refresh-new');
	});

	it('returns undefined when Cloudflare declines the refresh', async () => {
		const { fetcher } = fakeCloudflare({
			tokenBody: { error: 'invalid_grant' },
			tokenStatus: 401
		});

		expect(
			await refreshCloudflareGrant('refresh-old', fetcher)
		).toBeUndefined();
	});
});
