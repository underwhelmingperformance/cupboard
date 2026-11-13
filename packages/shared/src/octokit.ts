import { retry, type RetryOptions } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';
import { StatusCodes } from 'http-status-codes';

import {
	filterProgressively,
	findProgressively,
	type ProgressivePage
} from './collections.ts';
import { keepAliveFetch } from './keep-alive-fetch.ts';
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

// The retry plugin waits n squared times this many milliseconds before retry
// number n, which is 1 s, 4 s and 9 s for three retries.
const defaultRetryBaseDelayMs = 1000;

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
	readonly retryBaseDelayMs?: number;
}

/**
The options that {@link createOctokitClient} gives the retry plugin.
*/
export function retryOptions(
	options: Pick<OctokitClientOptions, 'replaySafety' | 'retryBaseDelayMs'>
): RetryOptions {
	return {
		retryAfterBaseValue: options.retryBaseDelayMs ?? defaultRetryBaseDelayMs,
		doNotRetry: doNotRetryStatuses,
		retries:
			options.replaySafety === 'replay-safe'
				? githubReplaySafeRequest.retries
				: 0
	};
}

/**
Build an Octokit client with the project's shared resilience policy: the
throttling plugin fails fast on rate limits and the retry plugin handles
transient failures. Pass `auth` to authenticate, `baseUrl` to target a
GitHub Enterprise host, and `request` to supply transport options such as a
caching or stubbed `fetch`.

Before retry number n, the retry plugin waits n squared times
`retryBaseDelayMs`. With the default of 1000, the waits are 1 s, 4 s and
9 s. Tests pass `0` to retry without waiting.
*/
export function createOctokitClient(
	options: OctokitClientOptions = {}
): InstanceType<typeof OctokitClient> {
	const fetcher = options.request?.fetch ?? keepAliveFetch;
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
		retry: retryOptions(options)
	});

	if (options.apiVersion !== undefined) {
		octokit.hook.before('request', (request) => {
			request.headers['x-github-api-version'] = options.apiVersion;
		});
	}

	return octokit;
}

/**
Whether a GitHub `Link` response header contains a `rel="next"` link. A
missing header has no next page.
*/
export function hasNextPageLink(link: string | undefined = ''): boolean {
	// The two comma searches stay separate. The start of the next entry
	// advances one comma at a time, but the parameters of an entry can begin
	// after several later commas, so the two sequences of indexes differ.
	const nextClose = ascendingSearch((from) => link.indexOf('>', from));
	const nextEntry = ascendingSearch((from) => link.indexOf(',', from));
	const entryEnd = ascendingSearch((from) => link.indexOf(',', from));
	const nextRelation = ascendingSearch((from) => nextRelationStart(link, from));

	// Each link entry starts at the beginning or after a comma. A target can
	// contain commas, so an entry can extend past the next comma.
	for (let start = 0; start <= link.length;) {
		let target = start;

		while (target < link.length && /\s/u.test(link.charAt(target))) {
			target += 1;
		}

		const close = link.charAt(target) === '<' ? nextClose(target + 1) : -1;

		if (close > target + 1 && link.charAt(close + 1) === ';') {
			const parameters = close + 2;
			const relation = nextRelation(parameters);
			const end = entryEnd(parameters);

			if (relation !== -1 && (end === -1 || relation < end)) {
				return true;
			}
		}

		const comma = nextEntry(start);

		if (comma === -1) {
			return false;
		}

		start = comma + 1;
	}

	return false;
}

/**
Wraps a search for the first match at or after an index, for callers whose
indexes never decrease. A result at or after a later index is also the
result for that index, so the wrapper returns it without searching again.
Every search therefore covers text that the previous searches did not. The
wrapper throws when an index is lower than the previous one, because it
would return a result that is too late.
*/
function ascendingSearch(
	search: (from: number) => number
): (from: number) => number {
	let previous = 0;
	let result = -Infinity;

	return (from) => {
		if (from < previous) {
			throw new RangeError(
				`Search index ${String(from)} is lower than ${String(previous)}`
			);
		}

		previous = from;

		if (result === -1 || result >= from) {
			return result;
		}

		result = search(from);

		return result;
	};
}

function nextRelationStart(link: string, from: number): number {
	const relation = 'rel="next"';

	for (
		let index = link.indexOf(relation, from);
		index !== -1;
		index = link.indexOf(relation, index + 1)
	) {
		if (index === 0 || !/\w/u.test(link.charAt(index - 1))) {
			return index;
		}
	}

	return -1;
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
		...(hasNextPageLink(response.headers.link) && {
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
