const readRetryDelayMs = 100;

/**
 * Retries an authoritative request-path D1 read once after 100 milliseconds.
 * If the second attempt fails, the function propagates the error so the route
 * can return its typed retryable response.
 */
export async function readWithOneRetry<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch {
		await new Promise((resolve) => setTimeout(resolve, readRetryDelayMs));

		return read();
	}
}

const d1OverloadMessage = 'D1 DB is overloaded';

/**
 * Cloudflare's D1 overload error does not expose a structured code that the
 * server can test, so detect it by matching the message. Drizzle can wrap the
 * D1 error in another error's cause. Follow at most five causes; the limit also
 * prevents a cyclic chain from looping forever.
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
