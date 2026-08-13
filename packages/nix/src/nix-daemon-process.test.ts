import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it, vi } from 'vitest';

import {
	DyingDaemonChild,
	FakeDaemonChild,
	UnspawnableDaemonChild
} from '../../../tests/support/fake-daemon-child.ts';
import { FakeDaemonTransport } from '../../../tests/support/fake-daemon-transport.ts';

import { NixDaemonRemoteError, NixDaemonStoreClient } from './nix-daemon.ts';
import {
	createProcessNixDaemonConnector,
	type DaemonChildProcess,
	type DaemonCommandRunner,
	daemonProcessTerminationGraceMs,
	type ScheduleDaemonProcessKill
} from './nix-daemon-process.ts';

class ControlledKillScheduler {
	private onElapsed: (() => void) | undefined;

	readonly delays: number[] = [];

	readonly cancellations: number[] = [];

	readonly schedule: ScheduleDaemonProcessKill = (delayMs, onElapsed) => {
		this.delays.push(delayMs);
		this.onElapsed = onElapsed;

		return {
			cancel: () => {
				this.cancellations.push(delayMs);
				this.onElapsed = undefined;
			}
		};
	};

	elapse(): void {
		const onElapsed = this.onElapsed;
		this.onElapsed = undefined;

		if (onElapsed === undefined) {
			throw new Error('Expected a pending daemon-process kill');
		}

		onElapsed();
	}
}

class ControlledDaemonChild implements DaemonChildProcess {
	private errorListener: ((error: Error) => void) | undefined;

	private exitListener: ((error: Error) => void) | undefined;

	readonly killSignals: NodeJS.Signals[] = [];

	readonly stdin = {
		write: (
			_chunk: Uint8Array,
			callback: (error?: Error | null) => void
		): void => {
			callback();
		}
	};

	readonly stdout = new FakeDaemonChild(new FakeDaemonTransport({})).stdout;

	onKill: ((signal: NodeJS.Signals) => void) | undefined;

	once(event: 'exit' | 'error', listener: (error: Error) => void): void {
		if (event === 'exit') {
			this.exitListener = listener;
			return;
		}

		this.errorListener = listener;
	}

	kill(signal: NodeJS.Signals = 'SIGTERM'): void {
		this.killSignals.push(signal);
		this.onKill?.(signal);
	}

	emitExit(): void {
		this.exitListener?.(new Error('child exited'));
	}

	emitError(error: Error): void {
		this.errorListener?.(error);
	}
}

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const appHash = '11'.repeat(32);

describe('createProcessNixDaemonConnector', () => {
	it('starts the command with its arguments for each connection', async () => {
		const commands: {
			command: string;
			commandArguments: readonly string[];
		}[] = [];
		const run: DaemonCommandRunner = (command, commandArguments) => {
			commands.push({ command, commandArguments });

			return new FakeDaemonChild(new FakeDaemonTransport({}));
		};
		const client = new NixDaemonStoreClient({
			connect: createProcessNixDaemonConnector(
				'nix',
				['daemon', '--stdio'],
				run
			)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect(commands).toStrictEqual([
			{ command: 'nix', commandArguments: ['daemon', '--stdio'] }
		]);
	});

	it('drives the daemon handshake through the bridged stdio', async () => {
		const children: FakeDaemonChild[] = [];
		const run: DaemonCommandRunner = () => {
			const child = new FakeDaemonChild(
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
			connect: createProcessNixDaemonConnector('nix', ['daemon'], run)
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
			connect: createProcessNixDaemonConnector(
				'nix',
				['daemon'],
				() => new DyingDaemonChild()
			)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toBeInstanceOf(
			NixDaemonRemoteError
		);
	});

	it('settles cleanup and surfaces the spawn error when the child cannot start', async () => {
		const spawnError = new Error('spawn failed');
		const children: UnspawnableDaemonChild[] = [];
		const run: DaemonCommandRunner = () => {
			const child = new UnspawnableDaemonChild(spawnError);
			children.push(child);

			return child;
		};
		const client = new NixDaemonStoreClient({
			connect: createProcessNixDaemonConnector('nix', ['daemon'], run)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toBe(spawnError);
		expect(children.map((child) => child.killed)).toStrictEqual([1]);
	});

	it('kills the child when the connection closes', async () => {
		const children: FakeDaemonChild[] = [];
		const run: DaemonCommandRunner = () => {
			const child = new FakeDaemonChild(new FakeDaemonTransport({}));
			children.push(child);

			return child;
		};
		const client = new NixDaemonStoreClient({
			connect: createProcessNixDaemonConnector('nix', ['daemon'], run)
		});

		await client.queryValidPaths([]);

		expect(children.map((child) => child.killed)).toStrictEqual([1]);
	});

	it('settles close after an ordinary TERM exit without escalation', async () => {
		const child = new ControlledDaemonChild();
		const scheduler = new ControlledKillScheduler();
		child.onKill = (signal) => {
			if (signal === 'SIGTERM') {
				child.emitExit();
			}
		};
		const transport = await createProcessNixDaemonConnector(
			'nix',
			['daemon'],
			() => child,
			undefined,
			scheduler.schedule
		)('', undefined);

		await transport.close();

		expect({
			killSignals: child.killSignals,
			delays: scheduler.delays,
			cancellations: scheduler.cancellations
		}).toStrictEqual({
			killSignals: ['SIGTERM'],
			delays: [daemonProcessTerminationGraceMs],
			cancellations: [daemonProcessTerminationGraceMs]
		});
	});

	it('shares one close operation across repeated callers', async () => {
		const child = new ControlledDaemonChild();
		child.onKill = () => {
			child.emitExit();
		};
		const transport = await createProcessNixDaemonConnector(
			'nix',
			['daemon'],
			() => child
		)('', undefined);

		const first = transport.close();
		const second = transport.close();

		expect({
			samePromise: first === second,
			killSignals: child.killSignals
		}).toStrictEqual({ samePromise: true, killSignals: ['SIGTERM'] });
		await first;
	});

	it('escalates a TERM-resistant child to KILL and waits for its exit', async () => {
		const child = new ControlledDaemonChild();
		const scheduler = new ControlledKillScheduler();
		const afterExit = vi.fn();
		child.onKill = (signal) => {
			if (signal === 'SIGKILL') {
				child.emitExit();
			}
		};
		const transport = await createProcessNixDaemonConnector(
			'nix',
			['daemon'],
			() => child,
			afterExit,
			scheduler.schedule
		)('', undefined);

		const closing = transport.close();
		const settled = vi.fn();
		void closing.then(settled);

		expect({
			killSignals: child.killSignals,
			afterExitCalls: afterExit.mock.calls
		}).toStrictEqual({
			killSignals: ['SIGTERM'],
			afterExitCalls: []
		});
		expect(settled).not.toHaveBeenCalled();

		scheduler.elapse();
		await closing;

		expect({
			killSignals: child.killSignals,
			delays: scheduler.delays,
			cancellations: scheduler.cancellations,
			afterExitCalls: afterExit.mock.calls,
			settledCalls: settled.mock.calls
		}).toStrictEqual({
			killSignals: ['SIGTERM', 'SIGKILL'],
			delays: [daemonProcessTerminationGraceMs],
			cancellations: [daemonProcessTerminationGraceMs],
			afterExitCalls: [[]],
			settledCalls: [[undefined]]
		});
	});
});
