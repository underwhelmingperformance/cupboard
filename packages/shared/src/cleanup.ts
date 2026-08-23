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
	return withCleanups(operation, [cleanup]);
}

/**
 * Runs an operation and every cleanup in order. The first failure is reported,
 * while later cleanup failures cannot replace it or prevent remaining cleanup.
 */
export async function withCleanups<T>(
	operation: () => Promise<T>,
	cleanups: readonly (() => Promise<unknown>)[]
): Promise<T> {
	let outcome:
		| { readonly succeeded: true; readonly value: T }
		| { readonly succeeded: false; readonly error: unknown };

	try {
		outcome = { succeeded: true, value: await operation() };
	} catch (error) {
		outcome = { succeeded: false, error };
	}

	for (const cleanup of cleanups) {
		try {
			await cleanup();
		} catch (error) {
			if (outcome.succeeded) {
				outcome = { succeeded: false, error };
			}
		}
	}

	if (!outcome.succeeded) {
		throw outcome.error;
	}

	return outcome.value;
}

/**
 * Runs cleanup after iteration. A cleanup failure is reported only when the
 * source itself completed successfully.
 */
export async function* withIterableCleanup<T>(
	source: AsyncIterable<T>,
	cleanup: () => Promise<unknown>
): AsyncIterable<T> {
	let isSucceeded = false;

	try {
		yield* source;
		isSucceeded = true;
	} finally {
		if (isSucceeded) {
			await cleanup();
		} else {
			await bestEffort(cleanup);
		}
	}
}
