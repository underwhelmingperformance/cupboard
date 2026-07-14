/**
 * Bounds a single asynchronous operation by a deadline. Resolves with the
 * operation's result when it settles before `ms` elapses, or rejects with
 * `makeError(abandoned)` when the deadline is reached first. The timer is
 * cleared either way, so a settled call leaves no pending timeout.
 *
 * The operation is not cancelled when the deadline wins: R2, D1 and the Cache
 * API expose no abort, so a call that loses the race keeps running in the
 * background until it settles or the invocation ends. Callers treat the
 * rejection as a transient fault and retry; the abandoned call must therefore be
 * idempotent. `makeError` receives that abandoned call's settled-signal: a
 * promise that never rejects and resolves once the call eventually settles
 * either way, so later work can order itself behind it.
 */
// The settled-signal for an abandoned call: resolves once the call settles,
// and never rejects, because it only reports that the call finished, not how.
async function settledSignal(pending: Promise<unknown>): Promise<void> {
	try {
		await pending;
	} catch {
		// Only that the call settled matters, not how.
	}
}

export async function withDeadline<T>(
	operation: () => Promise<T>,
	ms: number,
	makeError: (abandoned: Promise<void>) => Error
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const pending = operation();
	const abandoned = settledSignal(pending);

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
