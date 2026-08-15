import { StatusCodes } from 'http-status-codes';

// A long push makes thousands of calls against one single-threaded Durable
// Object and streams as many blobs, so an occasional gateway blip or dropped
// connection is expected. A few backed-off retries keep one such blip from
// failing the whole push.
export const maxTransientRetries = 4;
const baseRetryDelayMs = 250;
const maxRetryDelayMs = 5000;

// The statuses that mean "make the same request again": a rate limit and the
// gateway/overload conditions a server clears on its own. A deterministic
// refusal is never in this set and reaches the caller on its first response: a
// `500` from a broken invariant, an over-quota `507`, or any 4xx. A
// `Retry-After` header only sets how long to wait, never whether to retry.
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
 * Wraps a fetcher so a transient failure retries with back-off: a network fault
 * (DNS, refused or reset connection) or a {@link isTransientResponse} status
 * backs off and repeats, up to {@link maxTransientRetries} times, so a single
 * gateway blip does not fail the call. A deterministic response is returned on
 * its first attempt for the caller to handle. The wait honours the server's
 * `Retry-After` when present (capped) and is abort-aware, so a Ctrl-C during it
 * is prompt.
 *
 * A `Request` input is cloned per attempt so its body survives a retry; callers
 * that retry a body must pass it as re-readable bytes, not a one-shot stream.
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
 * Discards a transient response body, then waits before retrying: the server's
 * `Retry-After` when it names one (capped at the backoff ceiling), otherwise
 * {@link backoffDelay}.
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
 * Waits before the next retry: exponential back-off with full jitter, capped,
 * and abort-aware so a Ctrl-C during the wait is prompt. The jittered delay
 * never exceeds the cap, so a test can fire any pending wait by advancing a fake
 * clock past it.
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
