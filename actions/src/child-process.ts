import type { ChildProcess } from 'node:child_process';

export interface ChildProcessLifecycle {
	onceError(listener: (error: Error) => void): void;
	onceClose(
		listener: (
			status: number | null,
			signal: NodeJS.Signals | undefined
		) => void
	): void;
}

export interface AbortableChildProcessLifecycle extends ChildProcessLifecycle {
	kill(signal: NodeJS.Signals): boolean;
}

export interface ScheduledChildProcessEscalation {
	cancel(): void;
}

export interface ChildProcessEscalationScheduler {
	schedule(run: () => void, delayMs: number): ScheduledChildProcessEscalation;
}

export interface ClosedChildProcess {
	readonly error: Error | undefined;
	readonly signal: NodeJS.Signals | undefined;
	readonly status: number | null;
}

export const terminationGracePeriodMs = 10_000;

const defaultEscalationScheduler: ChildProcessEscalationScheduler = {
	schedule(run, delayMs) {
		const timeout = setTimeout(run, delayMs);
		timeout.unref();

		return {
			cancel() {
				clearTimeout(timeout);
			}
		};
	}
};

export function observeChildProcess(
	child: Pick<ChildProcess, 'kill' | 'once'>
): AbortableChildProcessLifecycle {
	return {
		kill(signal) {
			return child.kill(signal);
		},
		onceError(listener) {
			child.once('error', listener);
		},
		onceClose(listener) {
			child.once('close', (status, signal) => {
				listener(status, signal ?? undefined);
			});
		}
	};
}

/**
 * Node can emit `error` before `close`. Record the error, but do not resolve
 * until `close` confirms that the process and its stdio streams have finished.
 */
export function waitForChildProcess(
	child: ChildProcessLifecycle
): Promise<ClosedChildProcess> {
	return new Promise((resolve) => {
		let error: Error | undefined;

		child.onceError((reported) => {
			error ??= reported;
		});
		child.onceClose((status, signal) => {
			resolve({ error, signal, status });
		});
	});
}

/**
 * On abort, send SIGTERM and wait for `close`; send SIGKILL only after the
 * grace period expires. Do not also pass the AbortSignal to Node's spawn API,
 * because this helper must remain the single owner of child termination.
 */
export async function waitForAbortableChildProcess(
	child: AbortableChildProcessLifecycle,
	signal: AbortSignal | undefined,
	scheduler: ChildProcessEscalationScheduler = defaultEscalationScheduler
): Promise<ClosedChildProcess> {
	if (signal === undefined) {
		return waitForChildProcess(child);
	}

	let hasClosed = false;
	let hasTerminated = false;
	let escalation: ScheduledChildProcessEscalation | undefined;
	const lifecycle: ChildProcessLifecycle = {
		onceError(listener) {
			child.onceError(listener);
		},
		onceClose(listener) {
			child.onceClose((status, terminationSignal) => {
				hasClosed = true;
				escalation?.cancel();
				signal.removeEventListener('abort', terminate);
				listener(status, terminationSignal);
			});
		}
	};
	const completion = waitForChildProcess(lifecycle);
	const terminate = (): void => {
		if (hasClosed || hasTerminated) {
			return;
		}

		hasTerminated = true;
		child.kill('SIGTERM');
		escalation = scheduler.schedule(() => {
			if (!hasClosed) {
				child.kill('SIGKILL');
			}
		}, terminationGracePeriodMs);
	};

	signal.addEventListener('abort', terminate, { once: true });

	if (signal.aborted) {
		terminate();
	}

	const result = await completion;

	if (signal.aborted) {
		throw signal.reason;
	}

	return result;
}
