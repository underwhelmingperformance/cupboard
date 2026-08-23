import { spawn } from 'node:child_process';

import {
	ByteStreamReader,
	type ByteStreamSource,
	type NixDaemonConnector,
	type NixDaemonTransport
} from './nix-daemon.ts';

export interface DaemonChildProcess {
	readonly stdin: {
		write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown;
	};
	readonly stdout: ByteStreamSource;
	once(event: 'exit' | 'error', listener: (error: Error) => void): unknown;
	kill(signal?: NodeJS.Signals): unknown;
}

export type DaemonCommandRunner = (
	command: string,
	commandArguments: readonly string[]
) => DaemonChildProcess;

/**
 * Cleanup sends SIGKILL if the child has not exited this long after SIGTERM.
 */
export const daemonProcessTerminationGraceMs = 5000;

export interface ScheduledDaemonProcessKill {
	cancel(): void;
}

export type ScheduleDaemonProcessKill = (
	delayMs: number,
	onElapsed: () => void
) => ScheduledDaemonProcessKill;

const scheduleDaemonProcessKill: ScheduleDaemonProcessKill = (
	delayMs,
	onElapsed
) => {
	const timeout = setTimeout(onElapsed, delayMs);
	timeout.unref();

	return {
		cancel() {
			clearTimeout(timeout);
		}
	};
};

export const spawnDaemonProcess: DaemonCommandRunner = (
	command,
	commandArguments
) =>
	spawn(command, [...commandArguments], {
		stdio: ['pipe', 'pipe', 'inherit']
	});

/**
 * Runs one daemon child for each connection and exchanges the worker protocol
 * through its standard input and output. Closing the connection sends SIGTERM,
 * waits for the grace period, then sends SIGKILL if the child has not exited.
 */
export function createProcessNixDaemonConnector(
	command: string,
	commandArguments: readonly string[],
	run: DaemonCommandRunner = spawnDaemonProcess,
	afterExit?: () => void,
	scheduleKill: ScheduleDaemonProcessKill = scheduleDaemonProcessKill
): NixDaemonConnector {
	return () =>
		Promise.resolve(
			new ProcessNixDaemonTransport(
				run(command, commandArguments),
				afterExit,
				scheduleKill
			)
		);
}

class ProcessNixDaemonTransport implements NixDaemonTransport {
	private readonly reader: ByteStreamReader;

	private readonly exited: Promise<void>;

	private readonly finish: () => void;

	private closePromise?: Promise<void>;

	constructor(
		private readonly child: DaemonChildProcess,
		afterExit: (() => void) | undefined,
		private readonly scheduleKill: ScheduleDaemonProcessKill
	) {
		this.reader = new ByteStreamReader(child.stdout);
		const exit = Promise.withResolvers<undefined>();
		this.exited = exit.promise;
		let isFinished = false;
		this.finish = (): void => {
			if (isFinished) {
				return;
			}

			isFinished = true;

			try {
				afterExit?.();
			} finally {
				exit.resolve(undefined);
			}
		};

		child.once('exit', () => {
			this.finish();
		});
		// Node reports a spawn failure through the child's `error` event. The child
		// does not close stdout or emit `exit`, so fail pending reads and mark it as
		// finished here.
		child.once('error', (error) => {
			this.reader.fail(error);
			this.finish();
		});
	}

	private async closeOnce(): Promise<void> {
		this.child.kill('SIGTERM');
		const scheduledKill = this.scheduleKill(
			daemonProcessTerminationGraceMs,
			() => {
				this.child.kill('SIGKILL');
			}
		);

		try {
			await this.exited;
		} finally {
			scheduledKill.cancel();
		}
	}

	write(bytes: Uint8Array): Promise<void> {
		return new Promise((resolve, reject) => {
			this.child.stdin.write(bytes, (error) => {
				if (error === undefined || error === null) {
					resolve();
					return;
				}

				reject(error);
			});
		});
	}

	read(byteLength: number): Promise<Uint8Array> {
		return this.reader.read(byteLength);
	}

	close(): Promise<void> {
		this.closePromise ??= this.closeOnce();

		return this.closePromise;
	}
}
