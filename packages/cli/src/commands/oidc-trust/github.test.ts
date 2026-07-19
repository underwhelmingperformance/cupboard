import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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

// A fetch that answers the one repository URL under test, standing in for the
// GitHub API without a network or a mock-server dependency.
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

	it('resolves a repository to its immutable ids', async () => {
		const fetch = stubFetch(
			repoUrl,
			Response.json({
				id: 123,
				owner: { id: 456 },
				full_name: 'iainlane/cupboard'
			})
		);

		expect(
			await lookupRepository('iainlane/cupboard', { fetch })
		).toStrictEqual({
			repositoryId: 123,
			repositoryOwnerId: 456,
			fullName: 'iainlane/cupboard'
		});
	});

	// A private repository answers 404 to an unauthenticated lookup, so a
	// token from the environment must reach GitHub when one is set.
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

	it('maps a missing repository to a typed error', async () => {
		const fetch = stubFetch(repoUrl, new Response(undefined, { status: 404 }));

		await expect(
			lookupRepository('iainlane/cupboard', { fetch })
		).rejects.toBeInstanceOf(RepositoryNotFoundError);
	});

	it('maps an exhausted rate limit to a typed error', async () => {
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
});
