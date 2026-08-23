import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';
import { StatusCodes } from 'http-status-codes';

import {
	filterProgressively,
	findProgressively,
	type ProgressivePage
} from './collections.ts';
import { fetchWithBufferedBoundedResponseBodies } from './response-body.ts';
import { type ReplaySafety } from './retry.ts';

// The single retry policy for the project: the throttling plugin handles the
// documented rate-limit responses and the retry plugin handles transient
// failures.
const OctokitClient = Octokit.plugin(throttling, retry);

// Statuses the retry plugin must never retry: the client errors that will not
// change when retried, plus the rate-limit responses the throttle policy
// already fails fast on. The plugin replaces this list wholesale and does not
// export its own defaults, so the complete set is declared here.
const doNotRetryStatuses = [
	StatusCodes.BAD_REQUEST,
	StatusCodes.UNAUTHORIZED,
	StatusCodes.FORBIDDEN,
	StatusCodes.NOT_FOUND,
	StatusCodes.GONE,
	StatusCodes.UNPROCESSABLE_ENTITY,
	StatusCodes.TOO_MANY_REQUESTS,
	StatusCodes.UNAVAILABLE_FOR_LEGAL_REASONS
];

export const githubReplaySafeRequest = { retries: 3 } as const;

interface OctokitRequestOptions {
	readonly fetch?: typeof fetch;
	readonly retries?: number;
	readonly signal?: AbortSignal;
}

export type CupboardOctokit = InstanceType<typeof OctokitClient>;

export interface GithubRepository {
	readonly owner: string;
	readonly repo: string;
}

export type GithubRelease = Awaited<
	ReturnType<CupboardOctokit['rest']['repos']['listReleases']>
>['data'][number];

export const maximumGithubReleaseCandidates = 1000;
export const maximumGithubReleasePages = 20;
export const maximumGithubSuccessResponseBytes = 16 * 1024 * 1024;
export const maximumGithubErrorResponseBytes = 64 * 1024;
const githubReleasesPerPage = 100;

export interface OctokitClientOptions {
	readonly auth?: string;
	readonly apiVersion?: string;
	readonly baseUrl?: string;
	readonly request?: OctokitRequestOptions;
	readonly replaySafety?: ReplaySafety;
}

/**
 * Build an Octokit client with the project's shared resilience policy: the
 * throttling plugin fails fast on rate limits and the retry plugin handles
 * transient failures. Pass `auth` to authenticate, `baseUrl` to target a
 * GitHub Enterprise host, and `request` to supply transport options such as a
 * caching or stubbed `fetch`.
 */
export function createOctokitClient(
	options: OctokitClientOptions = {}
): InstanceType<typeof OctokitClient> {
	const fetcher = options.request?.fetch ?? globalThis.fetch;
	const request = {
		...options.request,
		fetch: fetchWithBufferedBoundedResponseBodies(fetcher, {
			description: 'GitHub API response',
			successMaximumBytes: maximumGithubSuccessResponseBytes,
			errorMaximumBytes: maximumGithubErrorResponseBytes
		})
	};
	const octokit = new OctokitClient({
		...(options.auth !== undefined && { auth: options.auth }),
		...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
		request,
		throttle: {
			onRateLimit: () => false,
			onSecondaryRateLimit: () => false
		},
		retry: {
			doNotRetry: doNotRetryStatuses,
			retries:
				options.replaySafety === 'replay-safe'
					? githubReplaySafeRequest.retries
					: 0
		}
	});

	if (options.apiVersion !== undefined) {
		octokit.hook.before('request', (request) => {
			request.headers['x-github-api-version'] = options.apiVersion;
		});
	}

	return octokit;
}

function hasNextPage(link: string | undefined): boolean {
	return /(?:^|,)\s*<[^>]+>;[^,]*\brel="next"/u.test(link ?? '');
}

async function githubReleasePage(
	octokit: CupboardOctokit,
	repository: GithubRepository,
	page = 1
): Promise<ProgressivePage<GithubRelease>> {
	const response = await octokit.rest.repos.listReleases({
		...repository,
		page,
		per_page: githubReleasesPerPage
	});

	return {
		items: response.data,
		...(hasNextPage(response.headers.link) && {
			next: () => githubReleasePage(octokit, repository, page + 1)
		})
	};
}

function githubReleaseLimits(repository: GithubRepository) {
	return {
		description: `GitHub release search for ${repository.owner}/${repository.repo}`,
		maximumItems: maximumGithubReleaseCandidates,
		maximumPages: maximumGithubReleasePages
	};
}

/**
Finds the first matching release without reading the remaining history.
*/
export async function findGithubRelease(
	octokit: CupboardOctokit,
	repository: GithubRepository,
	isMatch: (release: GithubRelease) => boolean
): Promise<GithubRelease | undefined> {
	return findProgressively(
		await githubReleasePage(octokit, repository),
		isMatch,
		githubReleaseLimits(repository)
	);
}

/**
Collects matching releases within the shared release-search limits.
*/
export async function filterGithubReleases(
	octokit: CupboardOctokit,
	repository: GithubRepository,
	isMatch: (release: GithubRelease) => boolean
): Promise<GithubRelease[]> {
	return filterProgressively(
		await githubReleasePage(octokit, repository),
		isMatch,
		githubReleaseLimits(repository)
	);
}
