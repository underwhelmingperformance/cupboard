import { spawn } from 'node:child_process';

import {
	ByteStreamReader,
	type ByteStreamSource,
	type NixDaemonConnector,
	type NixDaemonTransport
} from './nix-daemon.ts';

const sshNgScheme = 'ssh-ng://';
const defaultRemoteProgram = 'nix-daemon';

/** The remote daemon an `ssh-ng` store URI names. */
export interface NixSshStoreSpec {
	/** The ssh destination: `host` or `user@host`. */
	readonly destination: string;
	/** The daemon command started on the remote host. */
	readonly remoteProgram?: string;
}

/**
 * The connection spec an `ssh-ng` store URI carries: the destination from
 * its authority and the daemon command from its `remote-program` query
 * parameter. `undefined` for any other URI, including an `ssh-ng` one with
 * no destination.
 */
export function parseSshNgStoreUri(uri: string): NixSshStoreSpec | undefined {
	if (!uri.startsWith(sshNgScheme)) {
		return undefined;
	}

	const rest = uri.slice(sshNgScheme.length);
	const queryStart = rest.indexOf('?');
	const destination = queryStart === -1 ? rest : rest.slice(0, queryStart);

	if (destination === '') {
		return undefined;
	}

	const query = queryStart === -1 ? '' : rest.slice(queryStart + 1);
	const remoteProgram = new URLSearchParams(query).get('remote-program');

	if (remoteProgram === null || remoteProgram === '') {
		return { destination };
	}

	return { destination, remoteProgram };
}

/** The child-process pieces the ssh transport drives, injected for tests. */
export interface SshDaemonProcess {
	readonly stdin: {
		write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown;
	};
	readonly stdout: ByteStreamSource;
	once(event: 'exit' | 'error', listener: (error: Error) => void): unknown;
	kill(): unknown;
}

export type SshCommandRunner = (
	command: string,
	commandArguments: readonly string[]
) => SshDaemonProcess;

const spawnSshProcess: SshCommandRunner = (command, commandArguments) =>
	spawn(command, [...commandArguments], {
		stdio: ['pipe', 'pipe', 'inherit']
	});

/**
 * A connector that reaches the daemon an `ssh-ng` store names: each
 * connection starts `ssh <destination> <remote-program> --stdio` and speaks
 * the worker protocol over the child's pipes, so the handshake, SetOptions
 * and every operation behave exactly as they do over the local socket.
 * Closing the connection kills the child.
 */
export function createSshNixDaemonConnector(
	spec: NixSshStoreSpec,
	run: SshCommandRunner = spawnSshProcess
): NixDaemonConnector {
	const remoteProgram = spec.remoteProgram ?? defaultRemoteProgram;

	return () =>
		Promise.resolve(
			new SshNixDaemonTransport(
				run('ssh', [spec.destination, remoteProgram, '--stdio'])
			)
		);
}

class SshNixDaemonTransport implements NixDaemonTransport {
	private readonly reader: ByteStreamReader;

	private readonly exited: Promise<void>;

	private closePromise?: Promise<void>;

	constructor(private readonly child: SshDaemonProcess) {
		this.reader = new ByteStreamReader(child.stdout);
		// A spawn failure surfaces on the child, never on its stdout, so it is
		// forwarded to settle any read waiting on bytes.
		child.once('error', (error) => {
			this.reader.fail(error);
		});
		this.exited = new Promise((resolve) => {
			child.once('exit', () => {
				resolve();
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
