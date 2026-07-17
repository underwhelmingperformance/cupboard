import process from 'node:process';

import { createOctokitClient } from '@cupboard/shared/octokit';
import { StatusCodes } from 'http-status-codes';

import { GithubTokenMissingError } from '../../errors.ts';
import { InvalidRepositoryError } from '../oidc-trust/github.ts';

/**
 * Reads and writes a repository's Actions variables through the GitHub API.
 * `read` answers undefined for a variable that is not set.
 */
export interface VariablesClient {
	set(repository: string, name: string, value: string): Promise<void>;
	read(repository: string, name: string): Promise<string | undefined>;
}

/**
 * The GitHub token the variable calls authenticate with, drawn from the same
 * environment variables the `gh` CLI honours.
 */
export function githubToken(
	environment: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
	return [environment.GH_TOKEN, environment.GITHUB_TOKEN].find(
		(value): value is string => value !== undefined && value !== ''
	);
}

export function requireGithubToken(
	environment: Readonly<Record<string, string | undefined>> = process.env
): string {
	const token = githubToken(environment);

	if (token === undefined) {
		throw new GithubTokenMissingError();
	}

	return token;
}

export interface VariablesClientOptions {
	readonly fetch?: typeof fetch;
}

export function variablesClient(
	token: string,
	options: VariablesClientOptions = {}
): VariablesClient {
	const octokit = createOctokitClient({
		auth: token,
		...(options.fetch !== undefined && { request: { fetch: options.fetch } })
	});

	return {
		// An update converges the common case (the variable exists); a variable
		// seen for the first time answers NOT_FOUND and is created.
		async set(repository, name, value) {
			const { owner, repo } = splitRepository(repository);

			try {
				await octokit.rest.actions.updateRepoVariable({
					owner,
					repo,
					name,
					value
				});
			} catch (error) {
				if (isStatus(error, StatusCodes.NOT_FOUND)) {
					await octokit.rest.actions.createRepoVariable({
						owner,
						repo,
						name,
						value
					});

					return;
				}

				throw error;
			}
		},

		async read(repository, name) {
			const { owner, repo } = splitRepository(repository);

			try {
				const { data } = await octokit.rest.actions.getRepoVariable({
					owner,
					repo,
					name
				});

				return data.value;
			} catch (error) {
				if (isStatus(error, StatusCodes.NOT_FOUND)) {
					return;
				}

				throw error;
			}
		}
	};
}

function splitRepository(repository: string): {
	owner: string;
	repo: string;
} {
	const slash = repository.indexOf('/');

	if (slash <= 0 || slash === repository.length - 1) {
		throw new InvalidRepositoryError(repository);
	}

	return {
		owner: repository.slice(0, slash),
		repo: repository.slice(slash + 1)
	};
}

function isStatus(error: unknown, status: number): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		error.status === status
	);
}
