async function completionSignal(pending: Promise<unknown>): Promise<void> {
	try {
		await pending;
	} catch {
		// The caller needs only the completion signal, not the rejection.
	}
}

/**
 * Runs one asynchronous operation with a deadline. If the operation finishes
 * within `ms`, the function returns its result. Otherwise it rejects with the
 * error from `makeError`.
 *
 * Reaching the deadline does not cancel the operation because R2, D1, and the
 * Cache API do not expose cancellation. The operation can continue until it
 * finishes or the invocation ends, so callers must use this function only for
 * idempotent operations. `makeError` receives a promise that resolves when the
 * timed-out operation finishes. Later work can await that promise before
 * accessing the same state.
 */
export async function withDeadline<T>(
	operation: () => Promise<T>,
	ms: number,
	makeError: (abandoned: Promise<void>) => Error
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const pending = operation();
	const abandoned = completionSignal(pending);

	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(makeError(abandoned));
		}, ms);
	});

	try {
		return await Promise.race([pending, deadline]);
	} finally {
		clearTimeout(timer);
	}
}
