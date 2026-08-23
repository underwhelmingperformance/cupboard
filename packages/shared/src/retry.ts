import { StatusCodes } from 'http-status-codes';

import { discardResponseBody } from './cleanup.ts';
import { parseHttpDate } from './http-fields.ts';

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

/**
 * Retries every rejected fetch and each {@link isTransientResponse} status,
 * with at most {@link maxTransientRetries} additional attempts. Other responses
 * return immediately. A positive numeric `Retry-After` value supplies the delay
 * up to the configured maximum; HTTP-date values use the normal backoff. An
 * abort signal ends the wait immediately.
 *
 * The function clones a `Request` before each attempt. Callers that send a body
 * must therefore supply reusable bytes rather than a one-shot stream.
 */
export type ReplaySafety = 'replay-safe' | 'replay-unsafe';

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
				await backoffDelay(retries, signal);
				continue;
			}

			if (isTransientResponse(response) && retries < maxTransientRetries) {
				retries += 1;
				await transientResponseDelay(response, retries, signal);
				continue;
			}

			return response;
		}
	};
}

/**
 * Discards a transient response body, then waits for the next attempt. A
 * positive numeric `Retry-After` value supplies the delay, limited to the
 * maximum backoff. HTTP-date and invalid values use {@link backoffDelay}.
 */
export async function transientResponseDelay(
	response: Response,
	attempt: number,
	signal?: AbortSignal
): Promise<void> {
	const retryAfter = retryAfterDelayMs(response.headers.get('retry-after'));
	await discardResponseBody(response);

	if (retryAfter !== undefined) {
		await abortableSleep(Math.min(retryAfter, maxRetryDelayMs), signal);

		return;
	}

	await backoffDelay(attempt, signal);
}

/**
 * Waits for an exponentially increasing delay with full jitter: a random value
 * from zero to the current ceiling. The delay does not exceed
 * `maxRetryDelayMs`. An abort signal ends the wait immediately.
 */
export async function backoffDelay(
	attempt: number,
	signal?: AbortSignal
): Promise<void> {
	const ceiling = Math.min(
		baseRetryDelayMs * 2 ** (attempt - 1),
		maxRetryDelayMs
	);

	await abortableSleep(Math.random() * ceiling, signal);
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

async function abortableSleep(
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

	return hasNetworkCode(error.cause);
}

function hasNetworkCode(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	if ('code' in value && typeof value.code === 'string' && value.code !== '') {
		return true;
	}

	if ('errors' in value && Array.isArray(value.errors)) {
		return value.errors.some((error) => hasNetworkCode(error));
	}

	return 'cause' in value && hasNetworkCode(value.cause);
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
