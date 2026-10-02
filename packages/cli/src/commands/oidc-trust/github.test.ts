import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import nodeHttp from 'node:http';
import nodeHttps from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as scheduleIo } from 'node:timers';

import { maximumGithubSuccessResponseBytes } from '@cupboard/shared/octokit';
import { RemoteBodyTooLargeError } from '@cupboard/shared/response-body';
import makeFetchHappen from 'make-fetch-happen';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi
} from 'vitest';

import { cliExitCode } from '../../cli.ts';
import { parseExactWorkflowReference } from '../github/convention.ts';
import { githubWorkflowSource } from '../github/discovery.ts';
import { verifyWorkflowReference } from '../github/workflow-reference.ts';

import {
	GithubPermissionError,
	GithubRateLimitError,
	InvalidRepositoryError,
	lookupRepository,
	RepositoryNotFoundError
} from './github.ts';

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.href;
	}

	return input.url;
}

function stubFetch(url: string, response: Response): typeof fetch {
	return (input) => {
		const requested = requestUrl(input);

		if (requested !== url) {
			return Promise.reject(new Error(`unexpected request: ${requested}`));
		}

		return Promise.resolve(response);
	};
}

const repoUrl = 'https://api.github.com/repos/iainlane/cupboard';

describe('lookupRepository', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('returns the repository ids and current full name from GitHub', async () => {
		const fetch = stubFetch(
			repoUrl,
			Response.json({
				id: 123,
				owner: { id: 456 },
				full_name: 'iainlane/cupboard',
				default_branch: 'main'
			})
		);

		expect(
			await lookupRepository('iainlane/cupboard', { fetch })
		).toStrictEqual({
			repositoryId: 123,
			repositoryOwnerId: 456,
			fullName: 'iainlane/cupboard',
			defaultBranch: 'main'
		});
	});

	it('authenticates the lookup with a GH_TOKEN from the environment', async () => {
		vi.stubEnv('GH_TOKEN', 'gh-token-under-test');

		const authorizations: (string | undefined)[] = [];
		const fetch: typeof globalThis.fetch = (input, init) => {
			if (requestUrl(input) !== repoUrl) {
				return Promise.reject(
					new Error(`unexpected request: ${requestUrl(input)}`)
				);
			}

			authorizations.push(
				new Headers(init?.headers).get('authorization') ?? undefined
			);

			return Promise.resolve(
				Response.json({
					id: 123,
					owner: { id: 456 },
					full_name: 'iainlane/cupboard'
				})
			);
		};

		await lookupRepository('iainlane/cupboard', { fetch });

		expect(authorizations).toStrictEqual(['token gh-token-under-test']);
	});

	it('falls back to GITHUB_TOKEN when GH_TOKEN is empty', async () => {
		vi.stubEnv('GH_TOKEN', '');
		vi.stubEnv('GITHUB_TOKEN', 'github-token-under-test');

		const authorizations: (string | undefined)[] = [];
		const fetch: typeof globalThis.fetch = (input, init) => {
			if (requestUrl(input) !== repoUrl) {
				return Promise.reject(
					new Error(`unexpected request: ${requestUrl(input)}`)
				);
			}

			authorizations.push(
				new Headers(init?.headers).get('authorization') ?? undefined
			);

			return Promise.resolve(
				Response.json({
					id: 123,
					owner: { id: 456 },
					full_name: 'iainlane/cupboard'
				})
			);
		};

		await lookupRepository('iainlane/cupboard', { fetch });

		expect(authorizations).toStrictEqual(['token github-token-under-test']);
	});

	it('rejects a malformed repository before any request', async () => {
		const fetch = stubFetch('', new Response());

		await expect(
			lookupRepository('no-slash', { fetch })
		).rejects.toBeInstanceOf(InvalidRepositoryError);
	});

	it.each([
		'no-slash',
		'/repo',
		'owner/',
		'owner/repo/extra',
		'owner name/repo',
		'owner/repo name'
	])(
		'rejects malformed repository %j as an argument error without a request',
		async (repository) => {
			const requests: string[] = [];
			let failure: unknown;
			try {
				await lookupRepository(repository, {
					fetch: (input) => {
						requests.push(requestUrl(input));
						return Promise.resolve(new Response(undefined, { status: 404 }));
					}
				});
			} catch (error) {
				failure = error;
			}
			expect({
				name: failure instanceof Error ? failure.name : undefined,
				status: cliExitCode(failure, 130),
				requests
			}).toStrictEqual({
				name: 'InvalidRepositoryError',
				status: 2,
				requests: []
			});
		}
	);

	it('throws RepositoryNotFoundError for a 404 response', async () => {
		const fetch = stubFetch(repoUrl, new Response(undefined, { status: 404 }));

		await expect(
			lookupRepository('iainlane/cupboard', { fetch })
		).rejects.toBeInstanceOf(RepositoryNotFoundError);
	});

	it('throws GithubRateLimitError when the rate limit is exhausted', async () => {
		const fetch = stubFetch(
			repoUrl,
			new Response(undefined, {
				status: 403,
				headers: { 'x-ratelimit-remaining': '0' }
			})
		);

		await expect(
			lookupRepository('iainlane/cupboard', { fetch })
		).rejects.toBeInstanceOf(GithubRateLimitError);
	});

	it('throws GithubRateLimitError for a secondary rate limit', async () => {
		const fetch = stubFetch(
			repoUrl,
			new Response(undefined, {
				status: 403,
				headers: {
					'retry-after': '60',
					'x-ratelimit-remaining': '1'
				}
			})
		);

		await expect(
			lookupRepository('iainlane/cupboard', { fetch })
		).rejects.toBeInstanceOf(GithubRateLimitError);
	});

	it('throws GithubPermissionError for a forbidden response outside a rate limit', async () => {
		const fetch = stubFetch(
			repoUrl,
			new Response(undefined, {
				status: 403,
				headers: { 'x-ratelimit-remaining': '1' }
			})
		);

		await expect(
			lookupRepository('iainlane/cupboard', { fetch })
		).rejects.toStrictEqual(
			new GithubPermissionError("repository 'iainlane/cupboard'")
		);
	});

	it('cancels a stalled repository lookup with the caller signal', async () => {
		const controller = new AbortController();
		const reason = new Error('cancel repository lookup');
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<true>();
		const fetch: typeof globalThis.fetch = (_input, init) => {
			markStarted(true);

			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					'abort',
					() => {
						const abortReason: unknown = init.signal?.reason;

						reject(
							abortReason instanceof Error
								? abortReason
								: new Error('request aborted')
						);
					},
					{ once: true }
				);
			});
		};
		const pending = lookupRepository('iainlane/cupboard', {
			fetch,
			signal: controller.signal
		});

		await started;
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
	});
});

async function requestFailure(pending: Promise<unknown>): Promise<unknown> {
	let failure: unknown;
	const completionState = { isComplete: false };
	const completion = (async () => {
		try {
			await pending;
		} catch (error) {
			failure = error;
		} finally {
			completionState.isComplete = true;
		}
	})();
	while (!completionState.isComplete) {
		await vi.advanceTimersByTimeAsync(250);
		await new Promise<void>((resolve) => scheduleIo(resolve));
	}
	await completion;
	return failure;
}

const temporaryRequestCallers = [
	{
		caller: 'repository identity',
		url: 'https://api.github.com/repos/acme/app',
		resource: "repository 'acme/app'",
		execute: (fetch: typeof globalThis.fetch, signal?: AbortSignal) =>
			lookupRepository('acme/app', { fetch, signal })
	},
	{
		caller: 'workflow content',
		url: 'https://api.github.com/repos/acme/app/contents/.github%2Fworkflows%2Fpublish.yml?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		resource:
			"workflow reference 'acme/app/.github/workflows/publish.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
		execute: (fetch: typeof globalThis.fetch, signal?: AbortSignal) =>
			verifyWorkflowReference(
				parseExactWorkflowReference(
					`acme/app/.github/workflows/publish.yml@${'a'.repeat(40)}`
				),
				{ fetch, signal }
			)
	},
	{
		caller: 'workflow release',
		url: 'https://api.github.com/repos/acme/app/releases/tags/v1.2.3',
		resource:
			"workflow reference 'acme/app/.github/workflows/publish.yml@refs/tags/v1.2.3'",
		execute: (fetch: typeof globalThis.fetch, signal?: AbortSignal) =>
			verifyWorkflowReference(
				parseExactWorkflowReference(
					'acme/app/.github/workflows/publish.yml@refs/tags/v1.2.3'
				),
				{ fetch, signal }
			)
	},
	{
		caller: 'branch discovery',
		url: 'https://api.github.com/repos/acme/app/branches/main',
		resource: 'acme/app branch main',
		execute: (fetch: typeof globalThis.fetch, signal?: AbortSignal) =>
			githubWorkflowSource({ fetch, signal }).resolveBranch('acme/app', 'main')
	},
	{
		caller: 'directory discovery',
		url: 'https://api.github.com/repos/acme/app/contents/.github%2Fworkflows?ref=revision',
		resource: 'acme/app/.github/workflows',
		execute: (fetch: typeof globalThis.fetch, signal?: AbortSignal) =>
			githubWorkflowSource({ fetch, signal }).list('acme/app', 'revision')
	},
	{
		caller: 'file discovery',
		url: 'https://api.github.com/repos/acme/app/contents/.github%2Fworkflows%2Fpublish.yml?ref=revision',
		resource: 'acme/app/.github/workflows/publish.yml@revision',
		execute: (fetch: typeof globalThis.fetch, signal?: AbortSignal) =>
			githubWorkflowSource({ fetch, signal }).read(
				'acme/app',
				'.github/workflows/publish.yml',
				'revision'
			)
	}
];

describe('GitHub request failure diagnostics', () => {
	beforeAll(() => {
		vi.useFakeTimers();
	});
	afterAll(() => {
		vi.useRealTimers();
	});
	it.each(
		temporaryRequestCallers.flatMap((caller) =>
			[408, 500, 502, 503, 504, undefined].map((status) => ({
				...caller,
				status
			}))
		)
	)(
		'reports temporary GitHub failure $status for $caller after retry exhaustion',
		async ({ resource, execute, status, url }) => {
			const transportFailure = new TypeError('network unavailable');
			const requests: string[] = [];
			const pending = requestFailure(
				execute((input) => {
					requests.push(requestUrl(input));
					return status === undefined
						? Promise.reject(transportFailure)
						: Promise.resolve(
								Response.json({ message: 'Server Error' }, { status })
							);
				})
			);
			const failure = await pending;
			const error = failure instanceof Error ? failure : undefined;
			expect({
				name: error?.name,
				message: error?.message,
				status: cliExitCode(failure, 130),
				causeStatus:
					typeof error?.cause === 'object' &&
					error.cause !== null &&
					'status' in error.cause
						? error.cause.status
						: undefined,
				cause:
					status === undefined &&
					typeof error?.cause === 'object' &&
					error.cause !== null &&
					'cause' in error.cause
						? error.cause.cause
						: undefined,
				requests
			}).toStrictEqual({
				name: 'GithubTemporaryError',
				message:
					status === undefined
						? `GitHub could not be reached while reading ${resource}. Check your network connection and https://www.githubstatus.com/, then try again.`
						: `GitHub temporarily failed while reading ${resource} (HTTP ${String(status)}). Check https://www.githubstatus.com/ and try again.`,
				status: 75,
				causeStatus: status ?? 500,
				cause: status === undefined ? transportFailure : undefined,
				requests: Array.from({ length: 4 }, () => url)
			});
		}
	);

	it.each(
		temporaryRequestCallers.flatMap((caller) =>
			[400, 422, 401, 403, 429].map((status) => ({ ...caller, status }))
		)
	)(
		'preserves permanent and permission distinctions for HTTP $status in $caller',
		async ({ caller, resource, execute, status, url }) => {
			const requests: string[] = [];
			const pending = requestFailure(
				execute((input) => {
					requests.push(requestUrl(input));
					return Promise.resolve(
						Response.json(
							{ message: 'Request refused' },
							{
								status,
								headers: { 'x-ratelimit-remaining': '1' }
							}
						)
					);
				})
			);
			const failure = await pending;
			const isPermission = status === 401 || status === 403;
			const isRateLimit = status === 429;
			const isDiscovery = caller.endsWith('discovery');
			expect({
				name: failure instanceof Error ? failure.name : undefined,
				message: failure instanceof Error ? failure.message : undefined,
				status: cliExitCode(failure, 130),
				requests
			}).toStrictEqual({
				name: isPermission
					? 'GithubPermissionError'
					: isRateLimit
						? 'GithubRateLimitError'
						: isDiscovery
							? 'WorkflowDiscoveryError'
							: 'HttpError',
				message: isPermission
					? `GitHub denied access to ${resource}; set GH_TOKEN or GITHUB_TOKEN to a token with permission to read it.`
					: isRateLimit
						? 'GitHub API rate limit reached; try again later.'
						: isDiscovery
							? `Cannot read ${resource} from GitHub`
							: 'Request refused',
				status: isPermission ? 77 : isRateLimit ? 75 : 1,
				requests: [url]
			});
		}
	);

	it.each(temporaryRequestCallers)(
		'preserves the permanent response-body limit refusal for $caller',
		async ({ caller, resource, execute, url }) => {
			const requests: string[] = [];
			const observedBytes = maximumGithubSuccessResponseBytes + 1;
			const pending = requestFailure(
				execute((input) => {
					requests.push(requestUrl(input));
					return Promise.resolve(
						new Response('{}', {
							headers: {
								'content-type': 'application/json',
								'content-length': String(observedBytes)
							}
						})
					);
				})
			);
			const failure = await pending;
			const isDiscovery = caller.endsWith('discovery');
			const requestError =
				isDiscovery && failure instanceof Error ? failure.cause : failure;
			expect({
				name: failure instanceof Error ? failure.name : undefined,
				message: failure instanceof Error ? failure.message : undefined,
				status: cliExitCode(failure, 130),
				cause: requestError instanceof Error ? requestError.cause : undefined,
				requests
			}).toStrictEqual({
				name: isDiscovery ? 'WorkflowDiscoveryError' : 'HttpError',
				message: isDiscovery
					? `Cannot read ${resource} from GitHub`
					: 'GitHub API response declared 16777217 bytes, above the 16777216-byte limit',
				status: 1,
				cause: new RemoteBodyTooLargeError(
					'GitHub API response',
					maximumGithubSuccessResponseBytes,
					observedBytes,
					'declared'
				),
				requests: Array.from({ length: 4 }, () => url)
			});
		}
	);

	it.each(temporaryRequestCallers)(
		'preserves an aborted $caller request',
		async ({ execute }) => {
			const controller = new AbortController();
			const reason = new DOMException('cancelled', 'AbortError');
			const pending = requestFailure(
				execute((_input, init) => {
					controller.abort(reason);
					const requestReason: unknown = init?.signal?.reason;
					return Promise.reject(
						requestReason instanceof Error
							? requestReason
							: new Error('Expected an aborted request signal')
					);
				}, controller.signal)
			);
			const failure = await pending;
			expect({ failure, status: cliExitCode(failure, 130) }).toStrictEqual({
				failure: reason,
				status: 130
			});
		}
	);

	it.each([undefined, 'token-under-test'])(
		'explains an inaccessible repository 404 with token %s',
		async (token) => {
			vi.stubEnv('GH_TOKEN', token);
			vi.stubEnv('GITHUB_TOKEN', '');
			const requests: { url: string; authorization: string | undefined }[] = [];
			let failure: unknown;
			try {
				const pending = requestFailure(
					lookupRepository('acme/app', {
						fetch: (input, init) => {
							requests.push({
								url: requestUrl(input),
								authorization:
									new Headers(init?.headers).get('authorization') ?? undefined
							});
							return Promise.resolve(
								Response.json({ message: 'Not Found' }, { status: 404 })
							);
						}
					})
				);
				failure = await pending;
			} finally {
				vi.unstubAllEnvs();
			}
			expect({
				name: failure instanceof Error ? failure.name : undefined,
				message: failure instanceof Error ? failure.message : undefined,
				status: cliExitCode(failure, 130),
				requests
			}).toStrictEqual({
				name: 'RepositoryNotFoundError',
				message:
					"GitHub repository 'acme/app' was not found or is not accessible. Check --repo, and set GH_TOKEN or GITHUB_TOKEN to a token with permission to read a private repository.",
				status: 1,
				requests: [
					{
						url: 'https://api.github.com/repos/acme/app',
						authorization: token === undefined ? undefined : `token ${token}`
					}
				]
			});
		}
	);
	it('reports a damaged local cache without diagnosing a network outage', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-github-cache-')
		);
		const cachePath = path.join(directory, 'cupboard', 'github');
		const url = 'https://api.github.com/repos/acme/app';
		const body = JSON.stringify({
			id: 1,
			owner: { id: 2 },
			full_name: 'acme/app',
			default_branch: 'main'
		});
		const server = setupServer(
			http.get(
				url,
				() =>
					new HttpResponse(body, {
						headers: {
							'content-type': 'application/json',
							'cache-control': 'public, max-age=3600',
							date: new Date().toUTCString()
						}
					})
			)
		);
		vi.stubEnv('XDG_CACHE_HOME', directory);
		vi.stubEnv('GH_TOKEN', '');
		vi.stubEnv('GITHUB_TOKEN', '');
		let failure: unknown;
		let networkAttempts = 0;
		const network = () => {
			networkAttempts += 1;
			throw new Error('Unexpected network request after cache preparation');
		};
		server.listen({ onUnhandledFrame: 'error' });
		try {
			const response = await makeFetchHappen(url, {
				cachePath,
				headers: { accept: 'application/vnd.github.v3+json' }
			});
			expect(await response.text()).toBe(body);
			const digest = createHash('sha512').update(body).digest('hex');
			const content = path.join(
				cachePath,
				'content-v2',
				'sha512',
				digest.slice(0, 2),
				digest.slice(2, 4),
				digest.slice(4)
			);
			await rm(content);
			await mkdir(content);
			const httpRequest = vi
				.spyOn(nodeHttp, 'request')
				.mockImplementation(network);
			const httpsRequest = vi
				.spyOn(nodeHttps, 'request')
				.mockImplementation(network);
			try {
				failure = await requestFailure(lookupRepository('acme/app'));
			} finally {
				httpRequest.mockRestore();
				httpsRequest.mockRestore();
			}
		} finally {
			server.close();
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
		expect({
			name: failure instanceof Error ? failure.name : undefined,
			message: failure instanceof Error ? failure.message : undefined,
			status: cliExitCode(failure, 130),
			networkAttempts
		}).toStrictEqual({
			name: 'GithubCacheError',
			message: `Could not read the local GitHub cache at '${cachePath}'. Check its permissions and remove damaged cache data, then try again.`,
			status: 1,
			networkAttempts: 0
		});
	});
});
