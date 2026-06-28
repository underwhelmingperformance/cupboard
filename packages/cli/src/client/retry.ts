// A long push makes thousands of calls against one single-threaded Durable
// Object and streams as many blobs, so an occasional unmapped 5xx or dropped
// connection is expected. A few backed-off retries keep one such blip from
// failing the whole push.
export const maxTransientRetries = 4;
const baseRetryDelayMs = 250;
const maxRetryDelayMs = 5000;

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
	const delay = ceiling / 2 + Math.random() * (ceiling / 2);

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
