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
	kill(): unknown;
}

export type DaemonCommandRunner = (
	command: string,
	commandArguments: readonly string[]
) => DaemonChildProcess;

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
	afterExit?: () => void
): NixDaemonConnector {
	return () =>
		Promise.resolve(
			new ProcessNixDaemonTransport(run(command, commandArguments), afterExit)
		);
}

class ProcessNixDaemonTransport implements NixDaemonTransport {
	private readonly reader: ByteStreamReader;

	private readonly exited: Promise<void>;

	private closePromise?: Promise<void>;

	constructor(
		private readonly child: DaemonChildProcess,
		afterExit?: () => void
	) {
		this.reader = new ByteStreamReader(child.stdout);
		this.exited = new Promise((resolve) => {
			let isFinished = false;
			const finish = (): void => {
				if (isFinished) {
					return;
				}

				isFinished = true;
				afterExit?.();
				resolve();
			};

			child.once('exit', () => {
				finish();
			});
			// A spawn failure surfaces on the child, never on its stdout, and a
			// child that never spawned emits no exit. The error therefore
			// settles both any read waiting on bytes and the promise close()
			// awaits.
			child.once('error', (error) => {
				this.reader.fail(error);
				finish();
			});
		});
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
		if (this.closePromise === undefined) {
			this.child.kill();
			this.closePromise = this.exited;
		}

		return this.closePromise;
	}
}
