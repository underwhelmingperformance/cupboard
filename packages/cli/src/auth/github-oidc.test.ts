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

function requestUrl(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.href;
	}

	return input.url;
}

describe('fetchGithubOidcToken', () => {
	it('requests a token for the audience and returns its value', async () => {
		const requests: { url: string; authorization: string | undefined }[] = [];
		const fetcher: typeof fetch = (input, init) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: requestUrl(input),
				authorization: headers.get('authorization') ?? undefined
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
		const requests: string[] = [];
		const outcome = await (async () => {
			try {
				const token = await fetchGithubOidcToken({
					audience: 'aud',
					environment: missing,
					fetcher: (input) => {
						requests.push(requestUrl(input));

						return Promise.resolve(Response.json({ value: 'unused' }));
					}
				});
				return { token };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(GithubOidcUnavailableError);

				if (!(error_ instanceof GithubOidcUnavailableError)) {
					return {};
				}

				return { error: { name: error_.name } };
			}
		})();

		expect({ outcome, requests }).toStrictEqual({
			outcome: { error: { name: 'GithubOidcUnavailableError' } },
			requests: []
		});
	});

	it('throws when the response has no token value', async () => {
		const outcome = await (async () => {
			try {
				const token = await fetchGithubOidcToken({
					audience: 'aud',
					environment,
					fetcher: () => Promise.resolve(Response.json({ nope: true }))
				});
				return { token };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(GithubOidcResponseError);

				if (!(error_ instanceof GithubOidcResponseError)) {
					return {};
				}

				return { error: { name: error_.name, kind: error_.kind } };
			}
		})();

		expect(outcome).toStrictEqual({
			error: { name: 'GithubOidcResponseError', kind: 'missing-token' }
		});
	});

	it('throws when a 200 response is not JSON', async () => {
		const outcome = await (async () => {
			try {
				const token = await fetchGithubOidcToken({
					audience: 'aud',
					environment,
					fetcher: () => Promise.resolve(new Response('<html>nope</html>'))
				});
				return { token };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(GithubOidcResponseError);

				if (!(error_ instanceof GithubOidcResponseError)) {
					return {};
				}

				return { error: { name: error_.name, kind: error_.kind } };
			}
		})();

		expect(outcome).toStrictEqual({
			error: { name: 'GithubOidcResponseError', kind: 'non-json' }
		});
	});

	it('throws when the token request fails', async () => {
		const outcome = await (async () => {
			try {
				const token = await fetchGithubOidcToken({
					audience: 'aud',
					environment,
					fetcher: () =>
						Promise.resolve(new Response('forbidden', { status: 403 }))
				});
				return { token };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(GithubOidcRequestError);

				if (!(error_ instanceof GithubOidcRequestError)) {
					return {};
				}

				return {
					error: {
						name: error_.name,
						status: error_.status
					}
				};
			}
		})();

		expect(outcome).toStrictEqual({
			error: {
				name: GithubOidcRequestError.name,
				status: 403
			}
		});
	});
});
