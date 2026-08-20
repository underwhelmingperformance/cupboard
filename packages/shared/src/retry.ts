import { StatusCodes } from 'http-status-codes';

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

/**
Whether a wire response is a transient server failure worth retrying.
*/
export function isTransientResponse(response: Response): boolean {
	return retryableStatuses.has(response.status);
}

/**
 * Wraps a fetcher so transient network failures and
 * {@link isTransientResponse} statuses retry after a delay. The function makes
 * at most {@link maxTransientRetries} additional attempts. Deterministic
 * responses return immediately. A valid `Retry-After` header supplies the delay
 * up to the configured maximum, and an abort signal ends the wait immediately.
 *
 * The function clones a `Request` before each attempt. Callers that send a body
 * must therefore supply reusable bytes rather than a one-shot stream.
 */
export function retryingFetcher(fetcher: typeof fetch): typeof fetch {
	return async (input, init) => {
		const signal = init?.signal ?? undefined;
		let retries = 0;

		for (;;) {
			signal?.throwIfAborted();

			const attempt = input instanceof Request ? input.clone() : input;

			let response: Response;
			try {
				response = await fetcher(attempt, init);
			} catch (error) {
				if (signal?.aborted === true || retries >= maxTransientRetries) {
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
 * Discards a transient response body, then waits for the next attempt. A valid
 * `Retry-After` header supplies the delay, limited to the maximum backoff.
 * Otherwise the function calls {@link backoffDelay}.
 */
export async function transientResponseDelay(
	response: Response,
	attempt: number,
	signal?: AbortSignal
): Promise<void> {
	const retryAfterSeconds = Number(response.headers.get('retry-after'));
	await response.body?.cancel();

	if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
		await abortableSleep(
			Math.min(retryAfterSeconds * 1000, maxRetryDelayMs),
			signal
		);

		return;
	}

	await backoffDelay(attempt, signal);
}

/**
 * Waits for an exponentially increasing delay with full jitter. The delay does
 * not exceed `maxRetryDelayMs`. An abort signal ends the wait immediately. Tests
 * can complete any wait by advancing a fake clock past the maximum.
 */
export async function backoffDelay(
	attempt: number,
	signal?: AbortSignal
): Promise<void> {
	const ceiling = Math.min(
		baseRetryDelayMs * 2 ** (attempt - 1),
		maxRetryDelayMs
	);

	await abortableSleep(ceiling / 2 + Math.random() * (ceiling / 2), signal);
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
 * Wraps a fetcher so a network-level failure (a DNS lookup, a refused
 * connection) surfaces as the caller's own typed error naming the host. An
 * abort is a `DOMException`, so it propagates unchanged; only the `TypeError`
 * fetch uses for network faults is translated.
 */
export function reachableFetcher(
	fetcher: typeof fetch,
	makeError: (host: string, cause: TypeError) => Error
): typeof fetch {
	return async (input, init) => {
		try {
			return await fetcher(input, init);
		} catch (error) {
			if (error instanceof TypeError) {
				throw makeError(hostOf(input), error);
			}

			throw error;
		}
	};
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
