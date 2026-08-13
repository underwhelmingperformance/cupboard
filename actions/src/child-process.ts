import type { ChildProcess } from 'node:child_process';

/** The child lifecycle events needed to wait until all stdio has closed. */
export interface ChildProcessLifecycle {
	onceError(listener: (error: Error) => void): void;
	onceClose(
		listener: (
			status: number | null,
			signal: NodeJS.Signals | undefined
		) => void
	): void;
}

/** A child process that can receive explicit POSIX termination signals. */
export interface AbortableChildProcessLifecycle extends ChildProcessLifecycle {
	kill(signal: NodeJS.Signals): boolean;
}

/** A cancellable delayed escalation, abstracted for deterministic tests. */
export interface ScheduledChildProcessEscalation {
	cancel(): void;
}

/** Schedules forced termination after the graceful shutdown window. */
export interface ChildProcessEscalationScheduler {
	schedule(run: () => void, delayMs: number): ScheduledChildProcessEscalation;
}

/** A child result observed only after its `close` event. */
export interface ClosedChildProcess {
	readonly error: Error | undefined;
	readonly signal: NodeJS.Signals | undefined;
	readonly status: number | null;
}

/** Time allowed for an aborted child to close after SIGTERM. */
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

/** Adapt Node's overloaded child-process events to the lifecycle contract. */
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

/** Records a spawn error and waits for the child to close before resolving. */
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
 * Wait for complete process closure, terminating an aborted child gracefully
 * before escalating to SIGKILL. Node's spawn-level AbortSignal handling must
 * not also be enabled: this helper is the single owner of child termination.
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
