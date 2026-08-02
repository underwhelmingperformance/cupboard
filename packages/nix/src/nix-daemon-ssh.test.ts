import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { FakeDaemonTransport } from '../../../tests/support/fake-daemon-transport.ts';

import {
	type ByteStreamSource,
	NixDaemonRemoteError,
	NixDaemonStoreClient
} from './nix-daemon.ts';
import {
	createSshNixDaemonConnector,
	parseSshNgStoreUri,
	type SshCommandRunner,
	type SshDaemonProcess
} from './nix-daemon-ssh.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const appHash = '11'.repeat(32);

class FakeByteSource implements ByteStreamSource {
	private dataListener: ((chunk: Buffer) => void) | undefined;

	private endListener: ((error: Error) => void) | undefined;

	private closeListener: ((error: Error) => void) | undefined;

	on(_event: 'data', listener: (chunk: Buffer) => void): void {
		this.dataListener = listener;
	}

	once(
		event: 'end' | 'close' | 'error',
		listener: (error: Error) => void
	): void {
		if (event === 'end') {
			this.endListener = listener;
			return;
		}

		if (event === 'close') {
			this.closeListener = listener;
		}
	}

	emitData(chunk: Buffer): void {
		this.dataListener?.(chunk);
	}

	emitClose(): void {
		const streamClosed = new Error('stream closed');
		this.closeListener?.(streamClosed);
		this.endListener?.(streamClosed);
	}
}

// A scripted ssh child: bytes written to its stdin drive the shared fake
// daemon, whose buffered responses come back as stdout data events, so the
// bridged pipes carry the same protocol as the socket transport.
class FakeSshChild implements SshDaemonProcess {
	private exitListener: ((error: Error) => void) | undefined;

	readonly stdout = new FakeByteSource();

	killed = 0;

	readonly stdin = {
		write: (
			chunk: Uint8Array,
			callback: (error?: Error | null) => void
		): void => {
			void this.pump(chunk, callback);
		}
	};

	constructor(private readonly daemon: FakeDaemonTransport) {}

	private async pump(
		chunk: Uint8Array,
		callback: (error?: Error | null) => void
	): Promise<void> {
		try {
			await this.daemon.write(chunk);

			for (const frame of this.daemon.takeResponses()) {
				this.stdout.emitData(frame);
			}

			callback();
		} catch (error) {
			callback(error instanceof Error ? error : new Error(String(error)));
		}
	}

	once(event: 'exit' | 'error', listener: (error: Error) => void): void {
		if (event === 'exit') {
			this.exitListener = listener;
		}
	}

	kill(): void {
		this.killed += 1;
		this.exitListener?.(new Error('child exited'));
	}
}

// The remote daemon dies as soon as it is spoken to: stdout closes before
// the handshake's first reply arrives.
class DyingSshChild implements SshDaemonProcess {
	private exitListener: ((error: Error) => void) | undefined;

	readonly stdout = new FakeByteSource();

	readonly stdin = {
		write: (
			_chunk: Uint8Array,
			callback: (error?: Error | null) => void
		): void => {
			this.stdout.emitClose();
			callback();
		}
	};

	once(event: 'exit' | 'error', listener: (error: Error) => void): void {
		if (event === 'exit') {
			this.exitListener = listener;
		}
	}

	kill(): void {
		this.exitListener?.(new Error('child exited'));
	}
}

// The ssh binary cannot start: the child reports the spawn failure through
// its error event and, having never run, emits no exit.
class UnspawnableSshChild implements SshDaemonProcess {
	private errorListener: ((error: Error) => void) | undefined;

	readonly stdout = new FakeByteSource();

	killed = 0;

	readonly stdin = {
		write: (
			_chunk: Uint8Array,
			callback: (error?: Error | null) => void
		): void => {
			this.errorListener?.(this.spawnError);
			callback();
		}
	};

	constructor(private readonly spawnError: Error) {}

	once(event: 'exit' | 'error', listener: (error: Error) => void): void {
		if (event === 'error') {
			this.errorListener = listener;
		}
	}

	kill(): void {
		this.killed += 1;
	}
}

describe('parseSshNgStoreUri', () => {
	it.each([
		{
			name: 'a destination with a user',
			uri: 'ssh-ng://build@example.test',
			expected: { destination: 'build@example.test' }
		},
		{
			name: 'a bare host',
			uri: 'ssh-ng://example.test',
			expected: { destination: 'example.test' }
		},
		{
			name: 'a remote-program parameter',
			uri: 'ssh-ng://example.test?remote-program=/opt/nix/bin/nix-daemon',
			expected: {
				destination: 'example.test',
				remoteProgram: '/opt/nix/bin/nix-daemon'
			}
		},
		{ name: 'an empty destination', uri: 'ssh-ng://', expected: undefined },
		{
			name: 'a different scheme',
			uri: 'ssh://example.test',
			expected: undefined
		}
	])('parses $name', ({ uri, expected }) => {
		expect(parseSshNgStoreUri(uri)).toStrictEqual(expected);
	});
});

describe('createSshNixDaemonConnector', () => {
	it.each([
		{
			name: 'the default remote program',
			spec: { destination: 'build@example.test' },
			expectedArguments: ['build@example.test', 'nix-daemon', '--stdio']
		},
		{
			name: 'a configured remote program',
			spec: {
				destination: 'example.test',
				remoteProgram: '/opt/nix/bin/nix-daemon'
			},
			expectedArguments: ['example.test', '/opt/nix/bin/nix-daemon', '--stdio']
		}
	])('starts ssh with $name', async ({ spec, expectedArguments }) => {
		const commands: {
			command: string;
			commandArguments: readonly string[];
		}[] = [];
		const run: SshCommandRunner = (command, commandArguments) => {
			commands.push({ command, commandArguments });

			return new FakeSshChild(new FakeDaemonTransport({}));
		};
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(spec, run)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect(commands).toStrictEqual([
			{ command: 'ssh', commandArguments: expectedArguments }
		]);
	});

	it('drives the daemon handshake through the bridged stdio', async () => {
		const children: FakeSshChild[] = [];
		const run: SshCommandRunner = () => {
			const child = new FakeSshChild(
				new FakeDaemonTransport({
					[appPath]: {
						hash: appHash,
						narSize: 123,
						references: [],
						signatures: []
					}
				})
			);
			children.push(child);

			return child;
		};
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{ destination: 'build@example.test' },
				run
			)
		});

		const info = await client.queryPathInfo(appPath);

		expect({
			storePath: info.storePath,
			narSize: info.narSize,
			kills: children.map((child) => child.killed)
		}).toStrictEqual({
			storePath: appPath,
			narSize: 123,
			kills: [1]
		});
	});

	it('surfaces a child that exits mid-connection as a typed error', async () => {
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{ destination: 'example.test' },
				() => new DyingSshChild()
			)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toBeInstanceOf(
			NixDaemonRemoteError
		);
	});

	it('settles cleanup and surfaces the spawn error when the child cannot start', async () => {
		const spawnError = new Error('spawn failed');
		const children: UnspawnableSshChild[] = [];
		const run: SshCommandRunner = () => {
			const child = new UnspawnableSshChild(spawnError);
			children.push(child);

			return child;
		};
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector({ destination: 'example.test' }, run)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toBe(spawnError);
		expect(children.map((child) => child.killed)).toStrictEqual([1]);
	});

	it('kills the child when the connection closes', async () => {
		const children: FakeSshChild[] = [];
		const run: SshCommandRunner = () => {
			const child = new FakeSshChild(new FakeDaemonTransport({}));
			children.push(child);

			return child;
		};
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector({ destination: 'example.test' }, run)
		});

		await client.queryValidPaths([]);

		expect(children.map((child) => child.killed)).toStrictEqual([1]);
	});
});
