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

/** A child result observed only after its `close` event. */
export interface ClosedChildProcess {
	readonly error: Error | undefined;
	readonly signal: NodeJS.Signals | undefined;
	readonly status: number | null;
}

/** Adapt Node's overloaded child-process events to the lifecycle contract. */
export function observeChildProcess(
	child: Pick<ChildProcess, 'once'>
): ChildProcessLifecycle {
	return {
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

/** Record a spawn error but do not settle until the child has fully closed. */
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
