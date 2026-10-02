import { env } from 'node:process';

import {
	readResponseJson,
	readResponseText,
	RemoteBodyTooLargeError
} from '@cupboard/shared/response-body';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isAbortError, throwIfAborted } from '../abort.ts';
import { resilientFetcher } from '../client/transport.ts';
import { authExitCode, CliError, transientExitCode } from '../errors.ts';

const maximumGithubOidcResponseBytes = 1024 * 1024;
const unauthorisedStatus: number = StatusCodes.UNAUTHORIZED;
const forbiddenStatus: number = StatusCodes.FORBIDDEN;

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

	override get exitCode(): number {
		return authExitCode;
	}
}

export class GithubOidcRequestError extends CliError {
	constructor(
		public readonly status: number,
		public readonly body: string,
		options?: ErrorOptions
	) {
		super(
			`GitHub Actions OIDC token request failed with ${String(status)}: ${body}`,
			options
		);
		this.name = 'GithubOidcRequestError';
	}

	override get exitCode(): number {
		return this.status === unauthorisedStatus || this.status === forbiddenStatus
			? authExitCode
			: transientExitCode;
	}
}

// A 200 response without a token `value`. Keep this distinct from a failed
// request so it is not reported as "failed with 200".
export class GithubOidcResponseError extends CliError {
	constructor(
		public readonly kind:
			'missing-token' | 'non-json' | 'too-large' | 'unreadable',
		options?: ErrorOptions
	) {
		super(
			'GitHub Actions OIDC token response did not contain a token value',
			options
		);
		this.name = 'GithubOidcResponseError';
	}

	override get exitCode(): number {
		return transientExitCode;
	}
}

class GithubOidcTransportError extends CliError {
	constructor(cause: unknown) {
		super('The GitHub Actions OIDC token endpoint could not be reached.', {
			cause
		});
		this.name = 'GithubOidcTransportError';
	}

	override get exitCode(): number {
		return transientExitCode;
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

	const fetcher = options.fetcher ?? resilientFetcher('replay-safe');
	let response: Response;
	try {
		response = await fetcher(url, {
			headers: { authorization: `Bearer ${requestToken}` },
			signal: options.signal
		});
	} catch (error) {
		throwIfAborted(options.signal);
		if (isAbortError(error)) {
			throw error;
		}
		throw new GithubOidcTransportError(error);
	}

	if (!response.ok) {
		let body: string;
		try {
			body = await readResponseText(response, {
				description: 'GitHub Actions OIDC error response',
				maximumBytes: maximumGithubOidcResponseBytes,
				signal: options.signal
			});
		} catch (error) {
			throwIfAborted(options.signal);
			if (isAbortError(error)) {
				throw error;
			}
			throw new GithubOidcRequestError(
				response.status,
				'The response body could not be read.',
				{ cause: error }
			);
		}
		throw new GithubOidcRequestError(response.status, body);
	}

	let body: unknown;

	try {
		body = await readResponseJson(response, {
			description: 'GitHub Actions OIDC token response',
			maximumBytes: maximumGithubOidcResponseBytes,
			signal: options.signal
		});
	} catch (error) {
		throwIfAborted(options.signal);
		if (isAbortError(error)) {
			throw error;
		}
		const kind =
			error instanceof SyntaxError
				? 'non-json'
				: error instanceof RemoteBodyTooLargeError
					? 'too-large'
					: 'unreadable';
		throw new GithubOidcResponseError(kind, { cause: error });
	}

	const parsed = githubOidcResponseSchema.safeParse(body);

	if (!parsed.success) {
		throw new GithubOidcResponseError('missing-token');
	}

	return parsed.data.value;
}
