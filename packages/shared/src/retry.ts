import { getLogger } from '@logtape/logtape';
import { StatusCodes } from 'http-status-codes';

import { discardResponseBody } from './cleanup.ts';
import { parseHttpDate } from './http-fields.ts';

const logger = getLogger(['cupboard', 'fetch']);

// A long push makes thousands of requests to one single-threaded Durable Object
// and streams many blobs. Retry a small number of transient gateway and
// connection failures so one failed request does not abort the entire push.
export const maxTransientRetries = 4;
const baseRetryDelayMs = 250;
const maxRetryDelayMs = 5000;

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

/**
 * For a `replay-safe` request, retries a fetch that rejects with a network
 * error ({@link isFetchNetworkError}) and each {@link isTransientResponse}
 * status, with at most {@link maxTransientRetries} additional attempts. Other
 * rejections and other responses return immediately. A `Retry-After` value in
 * seconds or as an HTTP date supplies the delay, up to the maximum backoff. A
 * missing or invalid value uses the normal backoff. An abort signal ends the
 * wait immediately. A `replay-unsafe` request makes a single attempt.
 *
 * The function clones a `Request` before each attempt. Callers that send a body
 * must therefore supply reusable bytes rather than a one-shot stream.
 */
export function retryingFetcher(
	fetcher: typeof fetch,
	replaySafety: ReplaySafety
): typeof fetch {
	return async (input, init) => {
		const signal =
			init?.signal === null
				? undefined
				: (init?.signal ??
					(input instanceof Request ? input.signal : undefined));

		if (replaySafety === 'replay-unsafe') {
			signal?.throwIfAborted();

			return fetcher(input, init);
		}

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
				response = await fetcher(attempt, init);
			} catch (error) {
				if (
					signal?.aborted === true ||
					!isFetchNetworkError(error) ||
					retries >= maxTransientRetries
				) {
					throw error;
				}

				retries += 1;
				const delayMs = backoffDelayMs(retries);
				logger.debug('retrying after a network error', () => ({
					...request,
					retry: retries,
					code: networkErrorCode(error.cause),
					delayMs
				}));
				await abortableSleep(delayMs, signal);
				continue;
			}

			if (isTransientResponse(response) && retries < maxTransientRetries) {
				retries += 1;
				const delayMs = transientResponseDelayMs(response, retries);
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

			return response;
		}
	};
}

/**
 * Returns the origin and path of a request URL. Debug logs use this form
 * because the user information and the query can contain credentials.
 */
export function loggedUrl(input: Parameters<typeof fetch>[0]): string {
	const url = URL.parse(
		input instanceof Request ? input.url : input.toString()
	);

	return url === null ? 'an unparsable URL' : `${url.origin}${url.pathname}`;
}

/**
 * Returns the delay before the next attempt after a transient response. A
 * `Retry-After` value in seconds or as an HTTP date supplies the delay,
 * limited to the maximum backoff. A missing or invalid value uses
 * {@link backoffDelayMs}.
 */
function transientResponseDelayMs(response: Response, attempt: number): number {
	const retryAfter = retryAfterDelayMs(response.headers.get('retry-after'));

	return retryAfter === undefined
		? backoffDelayMs(attempt)
		: Math.min(retryAfter, maxRetryDelayMs);
}

/**
 * Waits for the jittered backoff delay for this attempt. An abort signal ends
 * the wait immediately.
 */
export async function backoffDelay(
	attempt: number,
	signal?: AbortSignal
): Promise<void> {
	await abortableSleep(backoffDelayMs(attempt), signal);
}

/**
 * Returns an exponentially increasing delay with full jitter for the given
 * attempt, counted from 1: a random value from zero to the current ceiling.
 * The delay does not exceed `maxRetryDelayMs`.
 */
export function backoffDelayMs(attempt: number): number {
	return fullJitterDelayMs(attempt, baseRetryDelayMs, maxRetryDelayMs);
}

/**
 * Returns a delay with full jitter for the given attempt, counted from 1: a
 * random value from zero to a ceiling. The ceiling starts at `baseMs` and
 * doubles with each attempt, up to `maximumMs`.
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
 * Waits for `delay` milliseconds. An abort signal ends the wait immediately
 * and without an error.
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
 * Replaces a rejected `TypeError` when its cause chain contains a non-empty
 * network error code. The caller supplies the typed error for the requested
 * host. Other rejected values propagate unchanged, including abort reasons.
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
