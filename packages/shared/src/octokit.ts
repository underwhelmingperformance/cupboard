import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';
import { StatusCodes } from 'http-status-codes';

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

type OctokitClientConstructorOptions = NonNullable<
	ConstructorParameters<typeof OctokitClient>[0]
>;

export interface OctokitClientOptions {
	readonly auth?: string;
	readonly apiVersion?: string;
	readonly baseUrl?: string;
	readonly request?: OctokitClientConstructorOptions['request'];
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
	const octokit = new OctokitClient({
		...(options.auth !== undefined && { auth: options.auth }),
		...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
		...(options.request !== undefined && { request: options.request }),
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
