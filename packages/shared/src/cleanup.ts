/**
Runs cleanup without allowing its failure to replace an earlier failure.
*/
export async function bestEffort(
	cleanup: () => Promise<unknown>
): Promise<void> {
	try {
		await cleanup();
	} catch {
		// The caller has already selected the failure it must report.
	}
}

/**
Discards an unread response body without replacing the request's failure.
*/
export function discardResponseBody(response: {
	readonly body: { cancel(reason?: unknown): Promise<unknown> } | null;
}): Promise<void> {
	return bestEffort(async () => response.body?.cancel());
}

/**
 * Runs an operation and its cleanup. A cleanup failure is reported after a
 * successful operation, but cannot replace the operation's own failure.
 */
export async function withCleanup<T>(
	operation: () => Promise<T>,
	cleanup: () => Promise<unknown>
): Promise<T> {
	let isSucceeded = false;

	try {
		const result = await operation();
		isSucceeded = true;

		return result;
	} finally {
		if (isSucceeded) {
			await cleanup();
		} else {
			await bestEffort(cleanup);
		}
	}
}
