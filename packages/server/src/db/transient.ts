// How long a request-path read waits before its one retry of a thrown fault.
const readRetryDelayMs = 100;

/**
 * Runs an authoritative request-path D1 read with one bounded retry, so a
 * momentary control-plane fault is absorbed before it can surface to a
 * client. A fault that survives the retry propagates for the caller to map
 * to its route's typed retryable refusal.
 */
export async function readWithOneRetry<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch {
		await new Promise((resolve) => setTimeout(resolve, readRetryDelayMs));

		return read();
	}
}
