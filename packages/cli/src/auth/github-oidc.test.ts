import { CodedError } from '@cupboard/shared/errors';
import { maxTransientRetries } from '@cupboard/shared/retry';
import { describe, expect, it, vi } from 'vitest';

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

async function failureOf(operation: Promise<unknown>): Promise<unknown> {
	try {
		return await operation;
	} catch (error) {
		return error;
	}
}

describe('fetchGithubOidcToken', () => {
	it('retries a transient response from the supplied transport', async () => {
		let attempts = 0;
		const token = await fetchGithubOidcToken({
			audience: 'aud',
			environment,
			fetcher: () => {
				attempts += 1;

				return Promise.resolve(
					attempts === 1
						? new Response('upstream connection timeout', {
								status: 503,
								headers: { 'retry-after': '0' }
							})
						: Response.json({ value: 'github.oidc.jwt' })
				);
			}
		});

		expect({ token, attempts }).toStrictEqual({
			token: 'github.oidc.jwt',
			attempts: 2
		});
	});

	it('cancels transient retry backoff without another request', async () => {
		vi.useFakeTimers();

		try {
			const controller = new AbortController();
			const reason = new Error('cancel OIDC acquisition');
			let attempts = 0;
			const pending = failureOf(
				fetchGithubOidcToken({
					audience: 'aud',
					environment,
					signal: controller.signal,
					fetcher: () => {
						attempts += 1;

						return Promise.resolve(
							new Response('temporarily unavailable', {
								status: 503,
								headers: { 'retry-after': '60' }
							})
						);
					}
				})
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(1);
			controller.abort(reason);

			expect({ failure: await pending, attempts }).toStrictEqual({
				failure: reason,
				attempts: 1
			});
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

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

				return { error: { name: error_.name, exitCode: error_.exitCode } };
			}
		})();

		expect({ outcome, requests }).toStrictEqual({
			outcome: { error: { name: 'GithubOidcUnavailableError', exitCode: 77 } },
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

				return {
					error: {
						name: error_.name,
						kind: error_.kind,
						exitCode: error_.exitCode
					}
				};
			}
		})();

		expect(outcome).toStrictEqual({
			error: {
				name: 'GithubOidcResponseError',
				kind: 'missing-token',
				exitCode: 75
			}
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

				return {
					error: {
						name: error_.name,
						kind: error_.kind,
						exitCode: error_.exitCode
					}
				};
			}
		})();

		expect(outcome).toStrictEqual({
			error: { name: 'GithubOidcResponseError', kind: 'non-json', exitCode: 75 }
		});
	});

	it.each([
		{ status: 401, exitCode: 77 },
		{ status: 403, exitCode: 77 },
		{ status: 429, exitCode: 75 },
		{ status: 503, exitCode: 75 }
	])(
		'classifies a token request failure with status $status',
		async ({ status, exitCode }) => {
			let attempts = 0;
			const outcome = await (async () => {
				try {
					const token = await fetchGithubOidcToken({
						audience: 'aud',
						environment,
						fetcher: () => {
							attempts += 1;

							return Promise.resolve(
								new Response('request failed', {
									status,
									headers: { 'retry-after': '0' }
								})
							);
						}
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
							status: error_.status,
							exitCode: error_.exitCode
						}
					};
				}
			})();

			expect({ outcome, attempts }).toStrictEqual({
				outcome: {
					error: {
						name: GithubOidcRequestError.name,
						status,
						exitCode
					}
				},
				attempts: status === 401 || status === 403 ? 1 : maxTransientRetries + 1
			});
		}
	);
});

it.each(
	[200, 401, 503].flatMap((status) =>
		['declared', 'received'].map((sizeSource) => ({ status, sizeSource }))
	)
)(
	'classifies an oversized $status $sizeSource OIDC body',
	async ({ status, sizeSource }) => {
		const failure = await failureOf(
			fetchGithubOidcToken({
				audience: 'aud',
				environment,
				fetcher: () =>
					Promise.resolve(
						new Response(
							sizeSource === 'declared' ? 'short body' : 'x'.repeat(1_048_577),
							{
								status,
								...(sizeSource === 'declared' && {
									headers: { 'content-length': '1048577' }
								})
							}
						)
					)
			})
		);
		expect({
			name: failure instanceof Error ? failure.name : undefined,
			exitCode: failure instanceof CodedError ? failure.exitCode : undefined,
			hasSizeCause:
				failure instanceof Error &&
				failure.cause instanceof Error &&
				failure.cause.name === 'RemoteBodyTooLargeError'
		}).toStrictEqual({
			name:
				status === 200 ? 'GithubOidcResponseError' : 'GithubOidcRequestError',
			exitCode: status === 401 ? 77 : 75,
			hasSizeCause: true
		});
	}
);

it.each([200, 401, 503])(
	'preserves HTTP classification for an unreadable $status OIDC body',
	async (status) => {
		const cause = new TypeError('Fixture stream failed');
		const failure = await failureOf(
			fetchGithubOidcToken({
				audience: 'aud',
				environment,
				fetcher: () =>
					Promise.resolve(
						new Response(
							new ReadableStream({
								start(controller) {
									controller.error(cause);
								}
							}),
							{ status }
						)
					)
			})
		);
		expect({
			name: failure instanceof Error ? failure.name : undefined,
			exitCode: failure instanceof CodedError ? failure.exitCode : undefined,
			hasCause: failure instanceof Error && failure.cause === cause
		}).toStrictEqual({
			name:
				status === 200 ? 'GithubOidcResponseError' : 'GithubOidcRequestError',
			exitCode: status === 401 ? 77 : 75,
			hasCause: true
		});
	}
);

it('classifies an OIDC transport failure as temporary', async () => {
	const cause = new TypeError('Fixture connection failed');
	const failure = await failureOf(
		fetchGithubOidcToken({
			audience: 'aud',
			environment,
			fetcher: () => Promise.reject(cause)
		})
	);
	expect({
		name: failure instanceof Error ? failure.name : undefined,
		exitCode: failure instanceof CodedError ? failure.exitCode : undefined,
		hasCause: failure instanceof Error && failure.cause === cause
	}).toStrictEqual({
		name: 'GithubOidcTransportError',
		exitCode: 75,
		hasCause: true
	});
});

it.each([200, 401])(
	'preserves cancellation while reading HTTP %s',
	async (status) => {
		const controller = new AbortController();
		const cause = new Error('Fixture cancelled');
		const failure = await failureOf(
			fetchGithubOidcToken({
				audience: 'aud',
				environment,
				signal: controller.signal,
				fetcher: () => {
					controller.abort(cause);
					return Promise.resolve(new Response('', { status }));
				}
			})
		);
		expect(failure).toBe(cause);
	}
);
