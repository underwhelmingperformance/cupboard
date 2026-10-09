import { env } from 'node:process';

import { canonicalHref } from '@cupboard/nix-store/url';
import { subjectBindingProblems } from '@cupboard/protocol/subject-binding';
import { genericExitCode } from '@cupboard/shared/errors';
import {
	readResponseJson,
	readResponseText,
	RemoteBodyTooLargeError
} from '@cupboard/shared/response-body';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isAbortError, throwIfAborted } from '../abort.ts';
import { resilientFetcher } from '../client/transport.ts';
import {
	authExitCode,
	CliError,
	isTransientHttpStatus,
	transientExitCode
} from '../errors.ts';

import { isBindingRefusal } from './bound-sign-in.ts';

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
		if (this.status === unauthorisedStatus || this.status === forbiddenStatus) {
			return authExitCode;
		}

		return isTransientHttpStatus(this.status)
			? transientExitCode
			: genericExitCode;
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
		return this.kind === 'unreadable' ? transientExitCode : genericExitCode;
	}
}

/**
 * The server at `target` refused a GitHub Actions token with
 * `subject-token-unbound`. The server accepts a token without a nonce binding
 * only when the token's audience is the server's own URL.
 */
export class GithubOidcAudienceRefusedError extends CliError {
	override readonly humanMessage: string;

	constructor(
		public readonly target: string,
		public readonly audience: string,
		options: { readonly cause: unknown }
	) {
		super(
			`${target} refused the GitHub Actions token because its audience is ` +
				`${audience}. The server accepts this token only when its audience ` +
				"is the server's own URL. Set --audience to the tenant URL, or to " +
				'the deployment URL for a control-plane command, and use the same ' +
				'audience in the trust rule.',
			options
		);
		this.name = 'GithubOidcAudienceRefusedError';
		this.humanMessage = this.message;
	}

	override get exitCode(): number {
		return authExitCode;
	}
}

/**
 * Returns the error to throw when the server at `target` refuses a GitHub
 * Actions token with the audience `audience`. A `subject-token-unbound`
 * refusal becomes `GithubOidcAudienceRefusedError`, and any other error is
 * returned unchanged.
 */
export function githubOidcExchangeFailure(
	error: unknown,
	target: URL,
	audience: string
): unknown {
	if (!isBindingRefusal(error, subjectBindingProblems.unbound)) {
		return error;
	}

	return new GithubOidcAudienceRefusedError(canonicalHref(target), audience, {
		cause: error
	});
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

	const fetcher = resilientFetcher('replay-safe', options.fetcher ?? fetch);
	let response: Response;
	try {
		response = await fetcher(url, {
			headers: { authorization: `Bearer ${requestToken}` },
			redirect: 'manual',
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
