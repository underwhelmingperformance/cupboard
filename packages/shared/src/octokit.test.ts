import { StatusCodes } from 'http-status-codes';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProgressiveCollectionLimitError } from './collections.ts';
import {
	createOctokitClient,
	filterGithubReleases,
	findGithubRelease,
	maximumGithubErrorResponseBytes,
	maximumGithubReleaseCandidates,
	maximumGithubReleasePages,
	maximumGithubSuccessResponseBytes
} from './octokit.ts';
import { RemoteBodyTooLargeError } from './response-body.ts';

function countingFetch(status: number): {
	readonly fetch: typeof fetch;
	calls: () => number;
} {
	let calls = 0;

	return {
		fetch: () => {
			calls += 1;

			return Promise.resolve(
				new Response('{}', {
					status,
					headers: { 'content-type': 'application/json' }
				})
			);
		},
		calls: () => calls
	};
}

async function fetchCountFor(
	status: number,
	replaySafety: 'replay-safe' | 'replay-unsafe' = 'replay-unsafe'
): Promise<number> {
	const counter = countingFetch(status);
	const octokit = createOctokitClient({
		request: { fetch: counter.fetch },
		replaySafety
	});

	try {
		await octokit.request('GET /repos/{owner}/{repo}', {
			owner: 'o',
			repo: 'r'
		});
	} catch {
		// Ignore the expected response error; only the number of attempts matters.
	}

	return counter.calls();
}

function paginatedOctokit(
	itemsForPage: (page: number) => readonly { id: number; draft?: boolean }[],
	hasNextPage: (page: number) => boolean
): {
	readonly octokit: ReturnType<typeof createOctokitClient>;
	readonly pages: number[];
} {
	const pages: number[] = [];
	const octokit = createOctokitClient({
		request: {
			fetch: (input: string | URL | Request) => {
				const url = new URL(
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.href
							: input.url
				);
				const page = Number(url.searchParams.get('page') ?? '1');
				pages.push(page);
				const headers = new Headers({ 'content-type': 'application/json' });

				if (hasNextPage(page)) {
					headers.set(
						'link',
						`<https://api.github.com/repos/o/r/releases?per_page=100&page=${String(page + 1)}>; rel="next"`
					);
				}

				return Promise.resolve(Response.json(itemsForPage(page), { headers }));
			}
		}
	});

	return { octokit, pages };
}

describe('GitHub release lookup', () => {
	it('stops after the first matching release', async () => {
		const { octokit, pages } = paginatedOctokit(
			(page) => [{ id: page, draft: page === 2 }],
			(page) => page < 3
		);
		const release = await findGithubRelease(
			octokit,
			{
				owner: 'o',
				repo: 'r'
			},
			(item) => item.draft
		);

		expect({ pages, id: release?.id }).toStrictEqual({
			pages: [1, 2],
			id: 2
		});
	});

	it('collects only matching releases across pages', async () => {
		const { octokit, pages } = paginatedOctokit(
			(page) => [
				{ id: page * 10, draft: false },
				{ id: page * 10 + 1, draft: true }
			],
			(page) => page < 2
		);
		const releases = await filterGithubReleases(
			octokit,
			{
				owner: 'o',
				repo: 'r'
			},
			(item) => item.draft
		);

		expect({ pages, ids: releases.map((release) => release.id) }).toStrictEqual(
			{
				pages: [1, 2],
				ids: [11, 21]
			}
		);
	});

	it('rejects a continuation without fetching beyond the page limit', async () => {
		const { octokit, pages } = paginatedOctokit(
			(page) => [{ id: page }],
			() => true
		);

		await expect(
			filterGithubReleases(octokit, { owner: 'o', repo: 'r' }, () => true)
		).rejects.toStrictEqual(
			new ProgressiveCollectionLimitError(
				'GitHub release search for o/r',
				maximumGithubReleaseCandidates,
				maximumGithubReleasePages,
				maximumGithubReleasePages,
				maximumGithubReleasePages
			)
		);
		expect(pages).toHaveLength(maximumGithubReleasePages);
	});
});

describe('createOctokitClient', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		['a rate-limit response', 429],
		['a forbidden response', 403],
		['a not-found response', 404],
		['a bad-request response', 400]
	])('fails fast on %s', async (_name, status) => {
		expect(await fetchCountFor(status)).toBe(1);
	});

	it('sends an explicitly selected REST API version', async () => {
		let headers: Headers | undefined;
		const octokit = createOctokitClient({
			apiVersion: '2026-03-10',
			request: {
				fetch: (input: string | URL | Request, init?: RequestInit) => {
					headers = new Request(input, init).headers;

					return Promise.resolve(Response.json({}));
				}
			}
		});

		await octokit.request('GET /repos/{owner}/{repo}', {
			owner: 'o',
			repo: 'r'
		});

		expect(headers?.get('x-github-api-version')).toBe('2026-03-10');
	});

	it('does not replay an operation unless the client declares it safe', async () => {
		expect(await fetchCountFor(500)).toBe(1);
	});

	it.each([
		{
			name: 'successful',
			status: StatusCodes.OK,
			maximumBytes: maximumGithubSuccessResponseBytes
		},
		{
			name: 'error',
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			maximumBytes: maximumGithubErrorResponseBytes
		}
	])(
		'bounds and cancels an oversized $name response',
		async ({ status, maximumBytes }) => {
			vi.useRealTimers();
			let wasCancelled = false;
			const octokit = createOctokitClient({
				request: {
					fetch: () =>
						Promise.resolve(
							new Response(
								new ReadableStream<Uint8Array>({
									cancel() {
										wasCancelled = true;
									}
								}),
								{
									status,
									headers: {
										'content-length': String(maximumBytes + 1),
										'content-type': 'application/json'
									}
								}
							)
						)
				}
			});

			await expect(
				octokit.request('GET /repos/{owner}/{repo}', {
					owner: 'o',
					repo: 'r'
				})
			).rejects.toMatchObject({
				cause: new RemoteBodyTooLargeError(
					'GitHub API response',
					maximumBytes,
					maximumBytes + 1,
					'declared'
				)
			});
			expect(wasCancelled).toBe(true);
		}
	);

	it('does not override a cancellable client retry policy during release lookup', async () => {
		const controller = new AbortController();
		const reason = new Error('stop release lookup');
		let calls = 0;
		const { promise: started, resolve: requestStarted } =
			Promise.withResolvers<undefined>();
		const octokit = createOctokitClient({
			replaySafety: 'replay-safe',
			request: {
				retries: 0,
				signal: controller.signal,
				fetch: async () => {
					calls += 1;
					requestStarted(undefined);
					await new Promise<void>((_resolve, reject) => {
						controller.signal.addEventListener(
							'abort',
							() => {
								reject(reason);
							},
							{ once: true }
						);
					});

					throw new Error('unreachable');
				}
			}
		});
		const lookup = findGithubRelease(
			octokit,
			{ owner: 'o', repo: 'r' },
			() => true
		);

		await started;
		controller.abort(reason);

		await expect(lookup).rejects.toThrow(reason.message);
		expect(calls).toBe(1);
	});

	it('retries a transient server error for a replay-safe client', async () => {
		vi.useFakeTimers();

		const pending = fetchCountFor(500, 'replay-safe');
		await vi.runAllTimersAsync();

		expect(await pending).toBe(4);
	});
});
