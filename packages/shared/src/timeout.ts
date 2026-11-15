import { CodedError, transientExitCode } from './errors.ts';

const deadlineAborts = new WeakSet<AbortSignal>();

export function isDeadlineAbort(signal: AbortSignal | undefined): boolean {
	return signal !== undefined && signal.aborted && deadlineAborts.has(signal);
}

async function completionSignal(pending: Promise<unknown>): Promise<void> {
	try {
		await pending;
	} catch {
		// The caller needs only the completion signal, not the rejection.
	}
}

/**
Runs one asynchronous operation with a deadline. If the operation finishes
within `ms`, the function returns its result. Otherwise it rejects with the
error from `makeError`.

Reaching the deadline does not cancel the operation because R2, D1, and the
Cache API do not expose cancellation. The operation can continue until it
finishes or the invocation ends, so callers must use this function only for
idempotent operations. `makeError` receives a promise that resolves when the
timed-out operation finishes. Later work can await that promise before
accessing the same state.
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

export const probeDeadlineMs = 30_000;

/**
Arms a deadline. It calls `expire` after `milliseconds` and returns a
function that cancels the deadline. `attempt` is the signal that the
attempt's operation receives, so a test timer can tell which attempt a
deadline belongs to. The default timer uses `setTimeout` and ignores it.
*/
export type DeadlineTimer = (
	expire: () => void,
	milliseconds: number,
	attempt: AbortSignal
) => () => void;

/**
The deadline timer of production code. It uses `setTimeout`.
*/
const realDeadlineTimer: DeadlineTimer = (expire, milliseconds) => {
	const timer = setTimeout(expire, milliseconds);

	return () => {
		clearTimeout(timer);
	};
};

/**
Runs one attempt of `operation` with a deadline. `operation` receives a
signal that aborts when the caller's `signal` aborts or the deadline passes.
When the deadline passes first, the attempt rejects with the error from
`makeError`, and the signal aborts with that error so that a request using
it releases its connection. When the caller's signal aborts first, the
attempt rejects at once with its reason, even if `operation` ignores the
signal and never settles.

`timer` arms the deadline, and defaults to {@link realDeadlineTimer}. If it
throws, the attempt rejects with that error.
*/
export async function attemptWithDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	deadlineMs: number,
	makeError: () => Error,
	signal?: AbortSignal,
	timer: DeadlineTimer = realDeadlineTimer
): Promise<T> {
	signal?.throwIfAborted();

	const deadlineController = new AbortController();
	const attemptSignal =
		signal === undefined
			? deadlineController.signal
			: AbortSignal.any([signal, deadlineController.signal]);

	const pending = Promise.try(operation, attemptSignal);
	let cancelDeadline: (() => void) | undefined;
	let abandon: (() => void) | undefined;
	const interruption = new Promise<never>((_resolve, reject) => {
		try {
			cancelDeadline = timer(
				() => {
					const error = makeError();
					reject(error);
					deadlineAborts.add(attemptSignal);
					deadlineController.abort(error);
				},
				deadlineMs,
				attemptSignal
			);
		} catch (error) {
			// The operation has started, so stop it.
			deadlineController.abort(error);
			throw error;
		}
		abandon = () => {
			reject(abortError(signal));
		};
		signal?.addEventListener('abort', abandon, { once: true });
	});

	try {
		return await Promise.race([pending, interruption]);
	} finally {
		cancelDeadline?.();
		if (abandon !== undefined) {
			signal?.removeEventListener('abort', abandon);
		}
	}
}

function abortError(signal: AbortSignal | undefined): Error {
	const reason: unknown = signal?.reason;

	return reason instanceof Error
		? reason
		: new Error('The operation was aborted', { cause: reason });
}

export class ProbeTimeoutError extends CodedError {
	/**
	@param target The request that timed out: its URL, or a description such
	as `the caches.list procedure`.
	*/
	constructor(public readonly target: string) {
		super(`Timed out waiting for a response from ${target}`);
		this.name = 'ProbeTimeoutError';
	}

	override get exitCode(): number {
		return transientExitCode;
	}
}
