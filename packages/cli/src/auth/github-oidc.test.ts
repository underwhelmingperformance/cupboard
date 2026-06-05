import { describe, expect, it } from 'vitest';

import {
	fetchGithubOidcToken,
	GithubOidcRequestError,
	GithubOidcResponseError,
	GithubOidcUnavailableError
} from './github-oidc.ts';

const environment = {
	requestUrl: 'https://actions.example.com/token?api-version=2.0',
	requestToken: 'request-bearer'
};

describe('fetchGithubOidcToken', () => {
	it('requests a token for the audience and returns its value', async () => {
		const requests: { url: string; authorization: string | undefined }[] = [];
		const fetcher: typeof fetch = (input, init) => {
			if (!(input instanceof URL)) {
				throw new TypeError('expected a URL');
			}

			requests.push({
				url: input.href,
				authorization:
					new Headers(init?.headers).get('authorization') ?? undefined
			});

			return Promise.resolve(Response.json({ value: 'github.oidc.jwt' }));
		};

		const token = await fetchGithubOidcToken({
			audience: 'https://cache.example.workers.dev',
			environment,
			fetcher
		});

		expect({ token, requests }).toStrictEqual({
			token: 'github.oidc.jwt',
			requests: [
				{
					url: 'https://actions.example.com/token?api-version=2.0&audience=https%3A%2F%2Fcache.example.workers.dev',
					authorization: 'Bearer request-bearer'
				}
			]
		});
	});

	it.each([
		{
			name: 'no request url',
			environment: { ...environment, requestUrl: undefined }
		},
		{
			name: 'no request token',
			environment: { ...environment, requestToken: '' }
		}
	])('throws when there is $name', async ({ environment: missing }) => {
		await expect(
			fetchGithubOidcToken({
				audience: 'aud',
				environment: missing,
				fetcher: () => Promise.reject(new Error('should not be called'))
			})
		).rejects.toBeInstanceOf(GithubOidcUnavailableError);
	});

	it('throws when the token request fails', async () => {
		await expect(
			fetchGithubOidcToken({
				audience: 'aud',
				environment,
				fetcher: () =>
					Promise.resolve(new Response('forbidden', { status: 403 }))
			})
		).rejects.toBeInstanceOf(GithubOidcRequestError);
	});

	it('throws when the response carries no token value', async () => {
		await expect(
			fetchGithubOidcToken({
				audience: 'aud',
				environment,
				fetcher: () => Promise.resolve(Response.json({ nope: true }))
			})
		).rejects.toBeInstanceOf(GithubOidcResponseError);
	});

	it('throws when a 200 response is not JSON', async () => {
		await expect(
			fetchGithubOidcToken({
				audience: 'aud',
				environment,
				fetcher: () => Promise.resolve(new Response('<html>nope</html>'))
			})
		).rejects.toBeInstanceOf(GithubOidcResponseError);
	});
});
