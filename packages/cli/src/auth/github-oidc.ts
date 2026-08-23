import { env } from 'node:process';

import { z } from 'zod';

import { throwIfAborted } from '../abort.ts';
import { resilientFetcher } from '../client/transport.ts';
import { CliError } from '../errors.ts';

// The OIDC token request endpoint, and the bearer token that GitHub Actions
// injects when a workflow grants `id-token: write`. Both are required to issue
// a token.
export interface GithubOidcEnvironment {
	readonly requestUrl: string | undefined;
	readonly requestToken: string | undefined;
}

function githubOidcEnvironment(
	source: Readonly<Record<string, string | undefined>> = env
): GithubOidcEnvironment {
	return {
		requestUrl: source.ACTIONS_ID_TOKEN_REQUEST_URL,
		requestToken: source.ACTIONS_ID_TOKEN_REQUEST_TOKEN
	};
}

export class GithubOidcUnavailableError extends CliError {
	constructor() {
		super(
			'No GitHub Actions OIDC token request endpoint; run with id-token: write permission'
		);
		this.name = 'GithubOidcUnavailableError';
	}
}

export class GithubOidcRequestError extends CliError {
	constructor(
		public readonly status: number,
		public readonly body: string
	) {
		super(
			`GitHub Actions OIDC token request failed with ${String(status)}: ${body}`
		);
		this.name = 'GithubOidcRequestError';
	}
}

// A 200 response without a token `value`. Keep this distinct from a failed
// request so it is not reported as "failed with 200".
export class GithubOidcResponseError extends CliError {
	constructor(public readonly kind: 'missing-token' | 'non-json') {
		super('GitHub Actions OIDC token response did not carry a token value');
		this.name = 'GithubOidcResponseError';
	}
}

const githubOidcResponseSchema = z.object({ value: z.string().min(1) });

/**
 * Requests a GitHub Actions OIDC token bound to `audience`, the value the
 * cupboard CI trust rule pins. Throws when the workflow lacks the
 * `id-token: write` permission that exposes the request endpoint.
 */
export async function fetchGithubOidcToken(options: {
	readonly audience: string;
	readonly environment?: GithubOidcEnvironment;
	readonly fetcher?: typeof fetch;
	readonly signal?: AbortSignal;
}): Promise<string> {
	throwIfAborted(options.signal);

	const { requestUrl, requestToken } =
		options.environment ?? githubOidcEnvironment();

	if (
		requestUrl === undefined ||
		requestUrl === '' ||
		requestToken === undefined ||
		requestToken === ''
	) {
		throw new GithubOidcUnavailableError();
	}

	const url = new URL(requestUrl);
	url.searchParams.set('audience', options.audience);

	const fetcher = options.fetcher ?? resilientFetcher();
	const response = await fetcher(url, {
		headers: { authorization: `Bearer ${requestToken}` },
		signal: options.signal
	});

	if (!response.ok) {
		throw new GithubOidcRequestError(response.status, await response.text());
	}

	// A 200 with a non-JSON body (a proxy notice, an HTML page) would otherwise
	// throw a raw SyntaxError; treat it as a malformed token response.
	let body: unknown;

	try {
		body = await response.json();
	} catch {
		throw new GithubOidcResponseError('non-json');
	}

	const parsed = githubOidcResponseSchema.safeParse(body);

	if (!parsed.success) {
		throw new GithubOidcResponseError('missing-token');
	}

	return parsed.data.value;
}
