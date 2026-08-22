import path from 'node:path';

import { createOctokitClient } from '@cupboard/shared/octokit';
import { RequestError } from '@octokit/request-error';
import { StatusCodes } from 'http-status-codes';
import makeFetchHappen from 'make-fetch-happen';

import { abortReason } from '../../abort.ts';
import { cacheDirectory } from '../../auth/secret-file.ts';
import { authExitCode, CliError, transientExitCode } from '../../errors.ts';

const forbiddenStatus: number = StatusCodes.FORBIDDEN;

// The numeric ids remain stable when a repository is renamed. `fullName`
// supplies name-based claims and root names, so setup must still rewrite the
// rule after a rename.
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

export class GithubRateLimitError extends CliError {
	constructor() {
		super('GitHub API rate limit reached; try again later.');
		this.name = 'GithubRateLimitError';
	}

	override get exitCode(): number {
		return transientExitCode;
	}
}

export class GithubPermissionError extends CliError {
	constructor(public readonly resource: string) {
		super(
			`GitHub denied access to ${resource}; set GH_TOKEN or GITHUB_TOKEN ` +
				'to a token with permission to read it.'
		);
		this.name = 'GithubPermissionError';
	}

	override get exitCode(): number {
		return authExitCode;
	}
}

export interface LookupRepositoryOptions {
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
}

export function githubApi(
	options: LookupRepositoryOptions = {}
): ReturnType<typeof createOctokitClient> {
	const cachePath = path.join(cacheDirectory(), 'github');
	const signal = githubRequestSignal(options.signal);
	const token = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN].find(
		(candidate) => candidate !== undefined && candidate !== ''
	);

	return createOctokitClient({
		replaySafety: 'replay-safe',
		...(token !== undefined && { auth: token }),
		request: {
			fetch: options.fetch ?? makeFetchHappen.defaults({ cachePath }),
			...(signal !== undefined && { signal })
		}
	});
}

/**
 * Reads a repository's numeric ids and current full name from GitHub. The
 * lookup uses `GH_TOKEN`, then `GITHUB_TOKEN`, when either is set. Without a
 * token, GitHub only returns public repositories. Conditional requests reuse a
 * local HTTP cache. A 404 throws {@link RepositoryNotFoundError}; rate limits
 * throw {@link GithubRateLimitError}; and authentication or permission failures
 * throw {@link GithubPermissionError}.
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

	const octokit = githubApi(options);

	try {
		const { data } = await octokit.rest.repos.get({ owner, repo });

		return {
			repositoryId: data.id,
			repositoryOwnerId: data.owner.id,
			fullName: data.full_name
		};
	} catch (error) {
		if (options.signal?.aborted === true) {
			throw abortReason(options.signal);
		}

		if (isStatus(error, StatusCodes.NOT_FOUND)) {
			throw new RepositoryNotFoundError(repository);
		}

		if (isGithubRateLimitResponse(error)) {
			throw new GithubRateLimitError();
		}

		if (
			isStatus(error, StatusCodes.UNAUTHORIZED) ||
			isStatus(error, StatusCodes.FORBIDDEN)
		) {
			throw new GithubPermissionError(`repository '${repository}'`);
		}

		throw error;
	}
}

export function isGithubRateLimitResponse(error: unknown): boolean {
	if (isStatus(error, StatusCodes.TOO_MANY_REQUESTS)) {
		return true;
	}

	if (!(error instanceof RequestError) || error.status !== forbiddenStatus) {
		return false;
	}

	const headers = error.response?.headers;

	return (
		headers?.['x-ratelimit-remaining'] === '0' ||
		headers?.['retry-after'] !== undefined
	);
}

function githubRequestSignal(
	signal: AbortSignal | undefined
): AbortSignal | undefined {
	if (signal === undefined) {
		return undefined;
	}

	const controller = new AbortController();
	const abort = (): void => {
		controller.abort(
			new DOMException('The operation was aborted', 'AbortError')
		);
	};

	if (signal.aborted) {
		abort();
	} else {
		signal.addEventListener('abort', abort, { once: true });
	}

	return controller.signal;
}

function isStatus(error: unknown, status: number): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		error.status === status
	);
}
