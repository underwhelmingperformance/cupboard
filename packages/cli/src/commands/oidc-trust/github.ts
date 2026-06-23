import path from 'node:path';

import { createOctokitClient } from '@cupboard/shared/octokit';
import makeFetchHappen from 'make-fetch-happen';

import { cacheDirectory } from '../../auth/secret-file.ts';

// The immutable identifiers a per-PR rule pins, so a repository rename never
// silently widens or breaks the rule.
export interface RepositoryIdentity {
	readonly repositoryId: number;
	readonly repositoryOwnerId: number;
	readonly fullName: string;
}

export class InvalidRepositoryError extends Error {
	constructor(public readonly value: string) {
		super(`--repo must be <owner>/<name>, got '${value}'.`);
		this.name = 'InvalidRepositoryError';
	}
}

export class RepositoryNotFoundError extends Error {
	constructor(public readonly repository: string) {
		super(`GitHub repository '${repository}' was not found.`);
		this.name = 'RepositoryNotFoundError';
	}
}

export class GithubRateLimitError extends Error {
	constructor() {
		super('GitHub API rate limit reached; try again later.');
		this.name = 'GithubRateLimitError';
	}
}

export interface LookupRepositoryOptions {
	// Injected in tests; defaults to a caching `make-fetch-happen` over the real
	// GitHub API.
	readonly fetch?: typeof fetch;
}

/**
 * Resolve a public repository's immutable numeric ids from `owner/name`. Uses a
 * conditional-request HTTP cache so repeated rule edits do not re-spend the
 * unauthenticated rate budget. Throws {@link RepositoryNotFoundError} for a 404
 * and {@link GithubRateLimitError} when the budget is exhausted.
 */
export async function lookupRepository(
	repository: string,
	options: LookupRepositoryOptions = {}
): Promise<RepositoryIdentity> {
	const slash = repository.indexOf('/');

	if (slash <= 0 || slash === repository.length - 1) {
		throw new InvalidRepositoryError(repository);
	}

	const owner = repository.slice(0, slash);
	const repo = repository.slice(slash + 1);

	const cachePath = path.join(cacheDirectory(), 'github');
	const octokit = createOctokitClient({
		request: { fetch: options.fetch ?? makeFetchHappen.defaults({ cachePath }) }
	});

	try {
		const { data } = await octokit.rest.repos.get({ owner, repo });

		return {
			repositoryId: data.id,
			repositoryOwnerId: data.owner.id,
			fullName: data.full_name
		};
	} catch (error) {
		if (isStatus(error, 404)) {
			throw new RepositoryNotFoundError(repository);
		}

		if (isStatus(error, 403) || isStatus(error, 429)) {
			throw new GithubRateLimitError();
		}

		throw error;
	}
}

function isStatus(error: unknown, status: number): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		error.status === status
	);
}
