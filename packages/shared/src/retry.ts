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
// refusal keeps its own status and is never in this set: a `500` invariant, an
// over-quota `507`, or any 4xx surfaces to the caller on the first response.
// `Retry-After`, when present, only sets how long to wait, never whether.
const retryableStatuses = new Set<number>([
	StatusCodes.TOO_MANY_REQUESTS,
	StatusCodes.BAD_GATEWAY,
	StatusCodes.SERVICE_UNAVAILABLE,
	StatusCodes.GATEWAY_TIMEOUT
]);

/** Whether a wire response is a transient server failure worth retrying. */
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
 * Waits before retrying a transient response: the server's `Retry-After` when
 * it names one (capped at the backoff ceiling), otherwise {@link backoffDelay}.
 */
export async function transientResponseDelay(
	response: Response,
	attempt: number,
	signal?: AbortSignal
): Promise<void> {
	const retryAfterSeconds = Number(response.headers.get('retry-after'));

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
		const timer = setTimeout(resolve, delay);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};

		if (signal?.aborted === true) {
			onAbort();

			return;
		}

		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
