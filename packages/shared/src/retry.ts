import { getLogger } from '@logtape/logtape';
import { StatusCodes } from 'http-status-codes';

import {
	ExponentialBackoff,
	type ExponentialBackoffPolicy,
	type RandomSource
} from './backoff.ts';
import { discardResponseBody } from './cleanup.ts';
import {
	type FetchObservationOptions,
	observeFetchAttempt,
	observeFetchOperation,
	recordFetchOutcome
} from './fetch-observation.ts';
import { parseHttpDate } from './http-fields.ts';

const firstErrorStatus: number = StatusCodes.BAD_REQUEST;

const logger = getLogger(['cupboard', 'fetch']);

// A long push makes thousands of requests to one single-threaded Durable Object
// and streams many blobs. Retry a small number of transient gateway and
// connection failures so one failed request does not abort the entire push.
export const maxTransientRetries = 4;
const maxRetryDelayMs = 5000;
const transientRetryPolicy: ExponentialBackoffPolicy = {
	baseMs: 250,
	maximumMs: maxRetryDelayMs,
	jitter: 'full'
};

/**
Returns the backoff for transient failures, which the transport and probe
retries use: full jitter below a ceiling that starts at 250 ms and doubles
up to 5 s. Create one for each operation that retries, and pass `random`
to make its delays predictable in a test.
*/
export function transientRetryBackoff(
	random?: RandomSource
): ExponentialBackoff {
	return new ExponentialBackoff(transientRetryPolicy, random);
}

const defaultTransientRetryBackoff = transientRetryBackoff();

// These statuses indicate a transient rate-limit, gateway, or overload
// response. Deterministic failures, including invariant failures, quota
// refusals, and other 4xx responses, return immediately. `Retry-After` controls
// the delay only after a response has been classified as retryable.
const retryableStatuses = new Set<number>([
	StatusCodes.TOO_MANY_REQUESTS,
	StatusCodes.BAD_GATEWAY,
	StatusCodes.SERVICE_UNAVAILABLE,
	StatusCodes.GATEWAY_TIMEOUT
]);

export function isTransientResponse(response: Response): boolean {
	return retryableStatuses.has(response.status);
}

export type ReplaySafety = 'replay-safe' | 'replay-unsafe';

export interface RetryingFetcherOptions extends FetchObservationOptions {
	/**
	Whether a `replay-unsafe` request is retried after its connection could
	not be established. Defaults to true. A caller that already retries the
	whole operation sets it to false, so that the two layers of retries do
	not multiply.
	*/
	readonly retriesConnectionFailures?: boolean;
	/**
	The random source for the backoff between attempts. The default is
	`Math.random`.
	*/
	readonly random?: RandomSource;
}

/**
For a `replay-safe` request, retries a fetch that rejects with a network
error ({@link isFetchNetworkError}) and each {@link isTransientResponse}
status, with at most {@link maxTransientRetries} additional attempts. Other
rejections and other responses return immediately. A `Retry-After` value in
seconds or as an HTTP date supplies the delay, up to the maximum backoff. A
missing or invalid value uses the normal backoff. An abort signal ends the
wait immediately.

A `replay-unsafe` request is retried with the same limit and backoff only
when its redirect mode is `manual` or `error` and the connection could not
be established. The server then cannot have received any part of the
request. When fetch follows redirects, the failed connection can belong to
a redirect target after the server completed the original request, so a
request that follows redirects is not retried. Every other rejection and
every response of a `replay-unsafe` request returns after one attempt.

The function clones a `Request` before each attempt. Callers that send a body
must therefore supply reusable bytes rather than a one-shot stream.
*/
export function retryingFetcher(
	fetcher: typeof fetch,
	replaySafety: ReplaySafety,
	options: RetryingFetcherOptions = {}
): typeof fetch {
	const { retriesConnectionFailures = true, random, ...observation } = options;
	const canRetryResponses = replaySafety === 'replay-safe';
	const backoff = transientRetryBackoff(random);

	const retrying: typeof fetch = async (input, init) => {
		const signal =
			init?.signal === null
				? undefined
				: (init?.signal ??
					(input instanceof Request ? input.signal : undefined));
		const redirect =
			init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
		const isRetryableRejection = (error: unknown): error is TypeError =>
			replaySafety === 'replay-safe'
				? isFetchNetworkError(error)
				: retriesConnectionFailures &&
					redirect !== 'follow' &&
					isConnectionSetupFailure(error);

		const request = {
			method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
			url: loggedUrl(input)
		};
		let retries = 0;

		for (;;) {
			signal?.throwIfAborted();

			const attempt = input instanceof Request ? input.clone() : input;

			let response: Response;
			try {
				response = await observeFetchAttempt(fetcher, attempt, init, {
					...observation,
					attempt: retries + 1,
					replaySafety
				});
			} catch (error) {
				if (
					signal?.aborted === true ||
					!isRetryableRejection(error) ||
					retries >= maxTransientRetries
				) {
					recordFetchOutcome(
						signal?.aborted === true
							? 'cancelled'
							: isRetryableRejection(error) && retries >= maxTransientRetries
								? 'exhausted'
								: 'failed'
					);
					throw error;
				}

				retries += 1;
				const delayMs = backoff.delayMs(retries);
				logger.debug('retrying after a network error', () => ({
					...request,
					retry: retries,
					code: networkErrorCode(error.cause),
					delayMs
				}));
				await abortableSleep(delayMs, signal);
				continue;
			}

			if (
				canRetryResponses &&
				isTransientResponse(response) &&
				retries < maxTransientRetries
			) {
				retries += 1;
				const delayMs = transientResponseDelayMs(response, retries, backoff);
				const cfRay = response.headers.get('cf-ray');
				logger.debug('retrying after a transient response', {
					...request,
					retry: retries,
					status: response.status,
					...(cfRay !== null && { cfRay }),
					delayMs
				});
				await discardResponseBody(response);
				await abortableSleep(delayMs, signal);
				continue;
			}

			recordFetchOutcome(
				canRetryResponses &&
					isTransientResponse(response) &&
					retries >= maxTransientRetries
					? 'exhausted'
					: retries > 0 && response.status < firstErrorStatus
						? 'recovered'
						: 'returned'
			);

			return response;
		}
	};

	return (input, init) =>
		observeFetchOperation(() => retrying(input, init), {
			...observation,
			replaySafety,
			signal:
				init?.signal === null
					? undefined
					: (init?.signal ??
						(input instanceof Request ? input.signal : undefined))
		});
}

/**
Returns the origin and path of a request URL. Debug logs use this form
because the user information and the query can contain credentials.
*/
export function loggedUrl(input: Parameters<typeof fetch>[0]): string {
	const url = URL.parse(
		input instanceof Request ? input.url : input.toString()
	);

	return url === null ? 'an unparsable URL' : `${url.origin}${url.pathname}`;
}

/**
Returns the delay before the next attempt after a transient response. A
`Retry-After` value in seconds or as an HTTP date supplies the delay,
limited to the maximum backoff. A missing or invalid value uses `backoff`.
*/
function transientResponseDelayMs(
	response: Response,
	attempt: number,
	backoff: ExponentialBackoff
): number {
	const retryAfter = retryAfterDelayMs(response.headers.get('retry-after'));

	return retryAfter === undefined
		? backoff.delayMs(attempt)
		: Math.min(retryAfter, maxRetryDelayMs);
}

/**
Waits for the jittered backoff delay for this attempt. An abort signal ends
the wait immediately. `backoff` defaults to {@link transientRetryBackoff}
with `Math.random`.
*/
export async function backoffDelay(
	attempt: number,
	signal?: AbortSignal,
	backoff: ExponentialBackoff = defaultTransientRetryBackoff
): Promise<void> {
	await abortableSleep(backoff.delayMs(attempt), signal);
}

/**
Returns a delay with full jitter for the given attempt, counted from 1: a
random value from zero to a ceiling. The ceiling starts at `baseMs` and
doubles with each attempt, up to `maximumMs`.
*/
export function fullJitterDelayMs(
	attempt: number,
	baseMs: number,
	maximumMs: number
): number {
	const ceiling = Math.min(baseMs * 2 ** (attempt - 1), maximumMs);

	return Math.random() * ceiling;
}

/**
Parses a `Retry-After` delay in milliseconds from delay-seconds or an HTTP date.
*/
export function retryAfterDelayMs(
	value: string | null | undefined,
	nowMilliseconds: number = Date.now()
): number | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}

	if (/^\d+$/u.test(value)) {
		const seconds = Number(value);

		return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
	}

	const retryAt = parseHttpDate(value);

	return retryAt === undefined
		? undefined
		: Math.max(0, retryAt - nowMilliseconds);
}

/**
Waits for `delay` milliseconds. An abort signal ends the wait immediately
and without an error.
*/
export async function abortableSleep(
	delay: number,
	signal?: AbortSignal
): Promise<void> {
	await new Promise<void>((resolve) => {
		const settle = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', settle);
			resolve();
		};
		const timer = setTimeout(settle, delay);

		if (signal?.aborted === true) {
			settle();

			return;
		}

		signal?.addEventListener('abort', settle, { once: true });
	});
}

/**
Replaces a rejected `TypeError` when its cause chain contains a non-empty
network error code. The caller supplies the typed error for the requested
host. Other rejected values propagate unchanged, including abort reasons.
*/
export function reachableFetcher(
	fetcher: typeof fetch,
	makeError: (host: string, cause: TypeError) => Error
): typeof fetch {
	return async (input, init) => {
		try {
			return await fetcher(input, init);
		} catch (error) {
			if (isFetchNetworkError(error)) {
				throw makeError(hostOf(input), error);
			}

			throw error;
		}
	};
}

/**
Whether Node's fetch implementation identified the failure as a network error.
*/
export function isFetchNetworkError(error: unknown): error is TypeError {
	if (!(error instanceof TypeError)) {
		return false;
	}

	return networkErrorCode(error.cause) !== undefined;
}

const connectFailureCodes = new Set([
	'ECONNREFUSED',
	'ENETUNREACH',
	'EHOSTUNREACH',
	'ETIMEDOUT'
]);
const lookupFailureCodes = new Set(['ENOTFOUND', 'EAI_AGAIN']);

/**
Whether Node's fetch failed before it had a connection to send the request
on: the DNS lookup failed, or every connection attempt failed or timed out.
*/
function isConnectionSetupFailure(error: unknown): error is TypeError {
	return error instanceof TypeError && isConnectionSetupCause(error.cause);
}

function isConnectionSetupCause(cause: unknown): boolean {
	if (cause instanceof AggregateError) {
		return (
			cause.errors.length > 0 &&
			cause.errors.every((entry) => isConnectionSetupCause(entry))
		);
	}

	const code = errorCode(cause);

	if (code === undefined) {
		return false;
	}

	// undici raises this code only from its connector, which completes before
	// undici writes any part of the request.
	if (code === 'UND_ERR_CONNECT_TIMEOUT') {
		return true;
	}

	// An established socket can report the same codes, for example
	// EHOSTUNREACH or ETIMEDOUT from a read after the request was sent. The
	// syscall distinguishes a failure of the connection itself.
	const syscall = errorSyscall(cause);

	return (
		(syscall === 'connect' && connectFailureCodes.has(code)) ||
		(syscall === 'getaddrinfo' && lookupFailureCodes.has(code))
	);
}

const responseBodyFailureCodes = new Set([
	'UND_ERR_SOCKET',
	'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
	'ECONNRESET'
]);

/**
Returns the error code of a response body that failed after its headers
arrived: the connection closed or was reset, or the body had fewer bytes
than its `Content-Length`. While the body is read, Node's fetch reports such
a failure as a `TypeError` whose cause has the code. The function also finds
that `TypeError` in the cause chain of an error that wraps it. It returns
`undefined` for every other error, including a failure before the headers,
an abort, and an error that the body's reader raises itself.
*/
export function responseBodyFailureCode(error: unknown): string | undefined {
	const seen = new Set<unknown>();
	let current: unknown = error;

	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);

		// undici's fetch uses this message only for a body that fails after the
		// headers. A failure before the headers is `fetch failed`, with the
		// same causes.
		if (current instanceof TypeError && current.message === 'terminated') {
			const code = errorCode(current.cause);

			return code !== undefined && responseBodyFailureCodes.has(code)
				? code
				: undefined;
		}

		current = current.cause;
	}

	return undefined;
}

function errorCode(value: unknown): string | undefined {
	return typeof value === 'object' &&
		value !== null &&
		'code' in value &&
		typeof value.code === 'string'
		? value.code
		: undefined;
}

function errorSyscall(value: unknown): string | undefined {
	return typeof value === 'object' &&
		value !== null &&
		'syscall' in value &&
		typeof value.syscall === 'string'
		? value.syscall
		: undefined;
}

function networkErrorCode(value: unknown): string | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	if ('code' in value && typeof value.code === 'string' && value.code !== '') {
		return value.code;
	}

	if ('errors' in value && Array.isArray(value.errors)) {
		for (const error of value.errors) {
			const code = networkErrorCode(error);

			if (code !== undefined) {
				return code;
			}
		}

		return undefined;
	}

	return 'cause' in value ? networkErrorCode(value.cause) : undefined;
}

function hostOf(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === 'string') {
		return safeHost(input);
	}

	if (input instanceof URL) {
		return input.host;
	}

	return safeHost(input.url);
}

function safeHost(value: string): string {
	try {
		const url = new URL(value);

		return url.host;
	} catch {
		return value;
	}
}
