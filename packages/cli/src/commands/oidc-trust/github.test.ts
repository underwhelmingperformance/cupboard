import { describe, expect, it } from 'vitest';

import {
	GithubRateLimitError,
	InvalidRepositoryError,
	lookupRepository,
	RepositoryNotFoundError
} from './github.ts';

// A fetch that answers the one repository URL under test, standing in for the
// GitHub API without a network or a mock-server dependency.
function stubFetch(url: string, response: Response): typeof fetch {
	return (input) => {
		const requested =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url;

		if (requested !== url) {
			return Promise.reject(new Error(`unexpected request: ${requested}`));
		}

		return Promise.resolve(response);
	};
}

const repoUrl = 'https://api.github.com/repos/iainlane/cupboard';

describe('lookupRepository', () => {
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

	it('rejects a malformed repository before any request', async () => {
		await expect(
			lookupRepository('no-slash', { fetch: stubFetch('', new Response()) })
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
