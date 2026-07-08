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

// The overload text D1 injects when it sheds load. The binding exposes no
// structured error code, so the message is the only signal. It surfaces wrapped
// inside Drizzle's DrizzleQueryError or similar, so the check walks the chain.
const d1OverloadMessage = 'D1 DB is overloaded';

/**
 * Returns true when the error (or any error in its cause chain) is a D1
 * overload signal. Walks up to five levels deep to handle wrappers like
 * Drizzle's DrizzleQueryError without risking an infinite walk on pathological
 * cycles.
 */
export function isD1Overload(error: unknown): boolean {
	let current: unknown = error;

	for (let depth = 0; depth < 5; depth += 1) {
		if (!(current instanceof Error)) {
			return false;
		}

		if (current.message.includes(d1OverloadMessage)) {
			return true;
		}

		current = current.cause;
	}

	return false;
}
