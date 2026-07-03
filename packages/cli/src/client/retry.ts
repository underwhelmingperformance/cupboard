import { StatusCodes } from 'http-status-codes';

// A long push makes thousands of calls against one single-threaded Durable
// Object and streams as many blobs, so an occasional unmapped 5xx or dropped
// connection is expected. A few backed-off retries keep one such blip from
// failing the whole push.
export const maxTransientRetries = 4;
const baseRetryDelayMs = 250;
const maxRetryDelayMs = 5000;

const serviceUnavailable: number = StatusCodes.SERVICE_UNAVAILABLE;
const insufficientStorage: number = StatusCodes.INSUFFICIENT_STORAGE;
const serverErrorThreshold: number = StatusCodes.INTERNAL_SERVER_ERROR;

/**
 * Whether a wire response is a transient server failure worth retrying. An
 * unmapped 5xx is transient by default. A 503 is a deterministic refusal (an
 * unconfigured tenant) unless the server marks it temporary with a
 * `Retry-After`; an over-quota 507 is always deterministic.
 */
export function isTransientResponse(response: Response): boolean {
	if (response.status === serviceUnavailable) {
		return response.headers.has('retry-after');
	}

	if (response.status === insufficientStorage) {
		return false;
	}

	return response.status >= serverErrorThreshold;
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
