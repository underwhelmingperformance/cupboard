import path from 'node:path';

import { createOctokitClient } from '@cupboard/shared/octokit';
import { RemoteBodyTooLargeError } from '@cupboard/shared/response-body';
import type { RequestError } from '@octokit/request-error';
import { StatusCodes } from 'http-status-codes';
import makeFetchHappen from 'make-fetch-happen';

import { abortReason, isAbortError } from '../../abort.ts';
import { cacheDirectory } from '../../auth/secret-file.ts';
import {
	authExitCode,
	CliError,
	CliUsageError,
	transientExitCode
} from '../../errors.ts';

const forbiddenStatus: number = StatusCodes.FORBIDDEN;
const requestTimeoutStatus: number = StatusCodes.REQUEST_TIMEOUT;

// The numeric ids remain stable when a repository is renamed. `fullName`
// supplies name-based claims and root names, so setup must still rewrite the
// rule after a rename.
export interface RepositoryIdentity {
	readonly repositoryId: number;
	readonly repositoryOwnerId: number;
	readonly fullName: string;
	readonly defaultBranch: string;
}

export class InvalidRepositoryError extends CliUsageError {
	constructor(public readonly value: string) {
		super(`--repo must be <owner>/<name>, got '${value}'.`);
		this.name = 'InvalidRepositoryError';
	}
}

export class RepositoryNotFoundError extends Error {
	constructor(public readonly repository: string) {
		super(
			`GitHub repository '${repository}' was not found or is not accessible. ` +
				'Check --repo, and set GH_TOKEN or GITHUB_TOKEN to a token with permission to read a private repository.'
		);
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

class GithubCacheError extends CliError {
	constructor(cachePath: string, options: ErrorOptions) {
		super(
			`Could not read the local GitHub cache at '${cachePath}'. Check its permissions and remove damaged cache data, then try again.`,
			options
		);
		this.name = 'GithubCacheError';
	}
}

const filesystemErrorCodes = new Set([
	'EACCES',
	'EPERM',
	'EISDIR',
	'ENOTDIR',
	'ENOENT',
	'ENOSPC',
	'EROFS',
	'EIO',
	'EMFILE',
	'ENFILE'
]);

function cacheReadError(error: unknown, cachePath: string): unknown {
	if (
		error instanceof Error &&
		'code' in error &&
		typeof error.code === 'string' &&
		filesystemErrorCodes.has(error.code)
	) {
		return new GithubCacheError(cachePath, { cause: error });
	}

	return error;
}

export class GithubTemporaryError extends CliError {
	constructor(
		public readonly resource: string,
		public readonly status: number | undefined,
		options: ErrorOptions
	) {
		super(
			status === undefined
				? `GitHub could not be reached while reading ${resource}. Check your network connection and https://www.githubstatus.com/, then try again.`
				: `GitHub temporarily failed while reading ${resource} (HTTP ${String(status)}). Check https://www.githubstatus.com/ and try again.`,
			options
		);
		this.name = 'GithubTemporaryError';
	}

	override get exitCode(): number {
		return transientExitCode;
	}
}

export function throwIfGithubTemporaryError(
	error: unknown,
	resource: string
): void {
	if (
		typeof error !== 'object' ||
		error === null ||
		!('status' in error) ||
		typeof error.status !== 'number' ||
		isAbortError(error)
	) {
		return;
	}

	if (
		error.status !== requestTimeoutStatus &&
		(error.status < 500 || error.status >= 600)
	) {
		return;
	}

	if ('cause' in error && error.cause instanceof GithubCacheError) {
		throw error.cause;
	}

	if ('cause' in error && error.cause instanceof RemoteBodyTooLargeError) {
		return;
	}

	const status =
		'response' in error && error.response !== undefined
			? error.status
			: undefined;
	throw new GithubTemporaryError(resource, status, { cause: error });
}

export interface LookupRepositoryOptions {
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
}

function isAsyncByteIterable(
	value: unknown
): value is AsyncIterable<Uint8Array> {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	return typeof Reflect.get(value, Symbol.asyncIterator) === 'function';
}

function webStream(
	body: AsyncIterable<Uint8Array>,
	cachePath: string
): ReadableStream<Uint8Array> {
	const iterator = body[Symbol.asyncIterator]();

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			let result: IteratorResult<Uint8Array>;
			try {
				result = await iterator.next();
			} catch (error) {
				throw cacheReadError(error, cachePath);
			}

			if (result.done) {
				controller.close();
				return;
			}

			controller.enqueue(result.value);
		},
		async cancel() {
			await iterator.return?.();
		}
	});
}

function cachedGithubFetch(cachePath: string): typeof fetch {
	const fetcher = makeFetchHappen.defaults({ cachePath });

	return async (input, init) => {
		const request = new Request(input, init);

		if (request.method !== 'GET' && request.method !== 'HEAD') {
			throw new TypeError(
				'The cached GitHub transport accepts only GET and HEAD requests.'
			);
		}

		const requestOptions = {
			headers: Object.fromEntries(request.headers.entries()),
			method: request.method,
			signal: request.signal
		};
		let response: Awaited<ReturnType<typeof fetcher>>;
		try {
			response = await fetcher(request.url, requestOptions);
		} catch (error) {
			throw cacheReadError(error, cachePath);
		}
		const responseHeaders = new Headers();
		response.headers.forEach((value, name) => {
			responseHeaders.append(name, value);
		});
		const hasNoBody = [
			StatusCodes.NO_CONTENT,
			StatusCodes.RESET_CONTENT,
			StatusCodes.NOT_MODIFIED
		].includes(response.status);
		const responseBody: unknown = response.body;

		let body: ReadableStream<Uint8Array> | undefined;

		if (!hasNoBody) {
			if (!isAsyncByteIterable(responseBody)) {
				throw new TypeError('The cached GitHub response body is not readable.');
			}

			body = webStream(responseBody, cachePath);
		}

		return new Response(body, {
			headers: responseHeaders,
			status: response.status,
			statusText: response.statusText
		});
	};
}

export function githubApi(
	options: LookupRepositoryOptions = {}
): ReturnType<typeof createOctokitClient> {
	const cachePath = path.join(cacheDirectory(), 'github');
	const signal = githubRequestSignal(options.signal);
	const token = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN].find(
		(candidate) => candidate !== undefined && candidate !== ''
	);
	const fetcher = options.fetch ?? cachedGithubFetch(cachePath);

	return createOctokitClient({
		replaySafety: 'replay-safe',
		...(token !== undefined && { auth: token }),
		request: {
			fetch: fetcher,
			...(signal !== undefined && { signal })
		}
	});
}

export function parseRepository(value: string): string {
	if (!/^[^\s/]+\/[^\s/]+$/u.test(value)) {
		throw new InvalidRepositoryError(value);
	}
	return value;
}

/**
 * Reads a repository's numeric ids and current full name from GitHub. The
 * lookup uses `GH_TOKEN`, then `GITHUB_TOKEN`, when either is set. Without a
 * token, GitHub only returns public repositories. Conditional requests reuse a
 * local HTTP cache. A 404 throws {@link RepositoryNotFoundError}; rate limits
 * throw {@link GithubRateLimitError}; and authentication or permission failures
 * throw {@link GithubPermissionError}. Temporary request failures throw
 * {@link GithubTemporaryError}.
 */
export async function lookupRepository(
	repository: string,
	options: LookupRepositoryOptions = {}
): Promise<RepositoryIdentity> {
	parseRepository(repository);
	const slash = repository.indexOf('/');

	const owner = repository.slice(0, slash);
	const repo = repository.slice(slash + 1);

	const octokit = githubApi(options);

	try {
		const { data } = await octokit.rest.repos.get({ owner, repo });

		return {
			repositoryId: data.id,
			repositoryOwnerId: data.owner.id,
			fullName: data.full_name,
			defaultBranch: data.default_branch
		};
	} catch (error) {
		if (options.signal?.aborted === true) {
			throw abortReason(options.signal);
		}

		if (isGithubResponseStatus(error, StatusCodes.NOT_FOUND)) {
			throw new RepositoryNotFoundError(repository);
		}

		if (isGithubRateLimitResponse(error)) {
			throw new GithubRateLimitError();
		}

		if (
			isGithubResponseStatus(error, StatusCodes.UNAUTHORIZED) ||
			isGithubResponseStatus(error, StatusCodes.FORBIDDEN)
		) {
			throw new GithubPermissionError(`repository '${repository}'`);
		}

		throwIfGithubTemporaryError(error, `repository '${repository}'`);
		throw error;
	}
}

export function isGithubRateLimitResponse(error: unknown): boolean {
	if (isGithubResponseStatus(error, StatusCodes.TOO_MANY_REQUESTS)) {
		return true;
	}

	if (!isGithubResponseStatus(error, forbiddenStatus)) {
		return false;
	}

	const headers = requestErrorHeaders(error);

	return (
		headers?.['x-ratelimit-remaining'] === '0' ||
		headers?.['retry-after'] !== undefined
	);
}

type RequestErrorHeaders = NonNullable<RequestError['response']>['headers'];

function requestErrorHeaders(error: object): RequestErrorHeaders | undefined {
	if (!('response' in error)) {
		return undefined;
	}

	const { response } = error;

	if (
		typeof response !== 'object' ||
		response === null ||
		!('headers' in response) ||
		!isRequestErrorHeaders(response.headers)
	) {
		return undefined;
	}

	return response.headers;
}

function isRequestErrorHeaders(value: unknown): value is RequestErrorHeaders {
	return (
		typeof value === 'object' &&
		value !== null &&
		Object.values(value).every(
			(header) => header === undefined || typeof header === 'string'
		)
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

/**
 * Tests the HTTP status of a GitHub request failure by reading its `status`
 * field. More than one installed copy of `@octokit/request-error` can define
 * `RequestError`, so an `instanceof` check can miss an error from another copy.
 */
export function isGithubResponseStatus(
	error: unknown,
	status: number
): error is { readonly status: number } {
	return (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		error.status === status
	);
}
