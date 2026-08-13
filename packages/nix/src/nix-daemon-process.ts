import { spawn } from 'node:child_process';

import {
	ByteStreamReader,
	type ByteStreamSource,
	type NixDaemonConnector,
	type NixDaemonTransport
} from './nix-daemon.ts';

/** The child-process pieces the transport drives, injected for tests. */
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

/** How long a daemon child has to exit after TERM before cleanup sends KILL. */
export const daemonProcessTerminationGraceMs = 5000;

/** A pending daemon-process escalation that can be cancelled after child exit. */
export interface ScheduledDaemonProcessKill {
	cancel(): void;
}

/** Starts the cancellable grace period before daemon-process cleanup escalates. */
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

/** Starts the daemon command as a child of this process. */
export const spawnDaemonProcess: DaemonCommandRunner = (
	command,
	commandArguments
) =>
	spawn(command, [...commandArguments], {
		stdio: ['pipe', 'pipe', 'inherit']
	});

/**
 * A connector that reaches a daemon speaking the worker protocol over a child
 * process's pipes: each connection starts the given command and speaks the
 * protocol on its stdin and stdout, so the handshake, SetOptions and every
 * operation behave exactly as they do over a local socket. Closing the
 * connection kills the child.
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
		// A spawn failure surfaces on the child, never on its stdout, and a
		// child that never spawned emits no exit. The error therefore
		// settles both any read waiting on bytes and the promise close()
		// awaits.
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
