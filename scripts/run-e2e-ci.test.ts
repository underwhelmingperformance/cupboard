import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { NixDaemonTrust } from '../packages/nix/src/nix-store.ts';
import { withTemporaryDirectory } from '../tests/support/filesystem.ts';

import {
	type CiEndToEndDependencies,
	OwnedNixDaemonSocket,
	runCiEndToEnd,
	RunningCiNixDaemon
} from './run-e2e-ci.ts';

function harness(overrides: Partial<CiEndToEndDependencies> = {}) {
	const daemon = {
		trust: vi.fn((): Promise<NixDaemonTrust> => Promise.resolve('trusted')),
		stop: vi.fn(() => Promise.resolve()),
		diagnostics: () => 'daemon diagnostics'
	};
	const dependencies: CiEndToEndDependencies = {
		platform: 'linux',
		userId: 1000,
		userName: 'runner',
		environment: {
			CI: 'true',
			PATH: '/bin',
			NIX_CONFIG: 'extra-experimental-features = nix-command flakes'
		},
		socketExists: () => false,
		assertTools: vi.fn(() => Promise.resolve()),
		startDaemon: vi.fn(() => Promise.resolve(daemon)),
		runTests: vi.fn(() => Promise.resolve(0)),
		reportFailure: vi.fn(),
		...overrides
	};

	return { daemon, dependencies };
}

describe('CI end-to-end prerequisites', () => {
	it('uses a trusted daemon only for the test child and stops it afterwards', async () => {
		const { daemon, dependencies } = harness();
		const signal = new AbortController().signal;
		const code = await runCiEndToEnd(
			['pnpm', 'check:e2e'],
			signal,
			dependencies
		);
		const expectedEnvironment = {
			...dependencies.environment,
			NIX_CONFIG:
				'extra-experimental-features = nix-command flakes\ntrusted-users = runner\nbuild-users-group =\nsandbox = false\n',
			NIX_DAEMON_SOCKET_PATH: '/nix/var/nix/daemon-socket/socket',
			NIX_REMOTE: 'daemon'
		};

		expect({
			code,
			trustCalls: daemon.trust.mock.calls.length,
			stopCalls: daemon.stop.mock.calls.length,
			environmentUnchanged: dependencies.environment.NIX_REMOTE
		}).toStrictEqual({
			code: 0,
			trustCalls: 1,
			stopCalls: 1,
			environmentUnchanged: undefined
		});
		expect(dependencies.startDaemon).toHaveBeenCalledWith(
			expectedEnvironment,
			signal
		);
		expect(dependencies.runTests).toHaveBeenCalledWith(
			['pnpm', 'check:e2e'],
			expectedEnvironment,
			signal
		);
	});

	it.each([
		{ case: 'a non-Linux host', changes: { platform: 'darwin' as const } },
		{ case: 'a root runner', changes: { userId: 0 } },
		{ case: 'a local session', changes: { environment: {} } },
		{ case: 'another daemon', changes: { socketExists: () => true } },
		{
			case: 'missing tools',
			changes: {
				assertTools: () => Promise.reject(new Error('Docker unavailable'))
			}
		}
	])('fails before starting a daemon for $case', async ({ changes }) => {
		const { dependencies } = harness(changes);

		await expect(
			runCiEndToEnd(
				['pnpm', 'check:e2e'],
				new AbortController().signal,
				dependencies
			)
		).rejects.toThrow();
		expect({
			startCalls: vi.mocked(dependencies.startDaemon).mock.calls.length,
			runCalls: vi.mocked(dependencies.runTests).mock.calls.length
		}).toStrictEqual({ startCalls: 0, runCalls: 0 });
	});

	it('rejects untrusted access and stops the daemon without running tests', async () => {
		const { daemon, dependencies } = harness();
		daemon.trust.mockResolvedValue('not-trusted');

		await expect(
			runCiEndToEnd(
				['pnpm', 'check:e2e'],
				new AbortController().signal,
				dependencies
			)
		).rejects.toThrow('must trust');
		expect({
			runCalls: vi.mocked(dependencies.runTests).mock.calls.length,
			stopCalls: daemon.stop.mock.calls.length,
			failureCalls: vi.mocked(dependencies.reportFailure).mock.calls.length
		}).toStrictEqual({ runCalls: 0, stopCalls: 1, failureCalls: 1 });
	});

	it('preserves a failed test exit and replays daemon diagnostics', async () => {
		const { daemon, dependencies } = harness({
			runTests: () => Promise.resolve(7)
		});

		expect(
			await runCiEndToEnd(
				['pnpm', 'check:e2e'],
				new AbortController().signal,
				dependencies
			)
		).toBe(7);
		expect(dependencies.reportFailure).toHaveBeenCalledWith(
			'daemon diagnostics'
		);
		expect(daemon.stop).toHaveBeenCalledExactlyOnceWith();
	});

	it('stops the daemon when the test child is cancelled', async () => {
		const controller = new AbortController();
		const { daemon, dependencies } = harness({
			runTests: (_command, _environment, signal) => {
				controller.abort(new Error('cancelled'));
				signal.throwIfAborted();
				return Promise.resolve(0);
			}
		});

		await expect(
			runCiEndToEnd(['pnpm', 'check:e2e'], controller.signal, dependencies)
		).rejects.toThrow('cancelled');
		expect(daemon.stop).toHaveBeenCalledExactlyOnceWith();
	});

	it('does not launch tests after cancellation during the trust handshake', async () => {
		const controller = new AbortController();
		const { daemon, dependencies } = harness();
		daemon.trust.mockImplementation(() => {
			controller.abort(new Error('cancelled handshake'));
			return Promise.resolve('trusted');
		});

		await expect(
			runCiEndToEnd(['pnpm', 'check:e2e'], controller.signal, dependencies)
		).rejects.toThrow('cancelled handshake');
		expect({
			runCalls: vi.mocked(dependencies.runTests).mock.calls.length,
			stopCalls: daemon.stop.mock.calls.length
		}).toStrictEqual({ runCalls: 0, stopCalls: 1 });
	});
});

function listen(socketPath: string): Promise<Server> {
	const server = createServer();

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => {
			resolve(server);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error !== undefined) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

describe('owned Nix daemon socket cleanup', () => {
	it('removes its own socket so a following daemon can start and tolerates repeated cleanup', async () => {
		await withTemporaryDirectory(
			'cupboard-owned-socket-',
			async (directory) => {
				const socketPath = path.join(directory, 'daemon.sock');
				const first = await listen(socketPath);
				try {
					const owned = OwnedNixDaemonSocket.capture(socketPath);
					expect(owned).toBeDefined();
					await owned?.remove();
					await owned?.remove();
					expect(existsSync(socketPath)).toBe(false);
				} finally {
					await close(first);
				}

				const second = await listen(socketPath);
				try {
					expect(OwnedNixDaemonSocket.capture(socketPath)).toBeDefined();
				} finally {
					await close(second);
				}
			}
		);
	});

	it('preserves a replacement socket at the same path', async () => {
		await withTemporaryDirectory(
			'cupboard-replaced-socket-',
			async (directory) => {
				const socketPath = path.join(directory, 'daemon.sock');
				const first = await listen(socketPath);
				const owned = OwnedNixDaemonSocket.capture(socketPath);
				expect(owned).toBeDefined();
				let second: Server | undefined;
				try {
					await rename(socketPath, path.join(directory, 'original.sock'));
					second = await listen(socketPath);
					await owned?.remove();
					expect(existsSync(socketPath)).toBe(true);
				} finally {
					if (second !== undefined) {
						await close(second);
					}
					await close(first);
				}
			}
		);
	});

	it('does not claim a normal file at the readiness path', async () => {
		await withTemporaryDirectory('cupboard-other-path-', async (directory) => {
			const socketPath = path.join(directory, 'daemon.sock');
			await writeFile(socketPath, 'another process');

			expect({
				owner: OwnedNixDaemonSocket.capture(socketPath),
				exists: existsSync(socketPath)
			}).toStrictEqual({ owner: undefined, exists: true });
		});
	});
});

async function inheritedDaemonProcess(
	directory: string,
	shouldExitLeader: boolean
) {
	const listenerPath = path.join(directory, 'child.sock');
	const descendant = [
		"const { createServer } = require('node:net');",
		"process.on('SIGTERM', () => {});",
		`createServer().listen(${JSON.stringify(listenerPath)}, () => process.send('ready'));`
	].join('\n');
	const script = [
		"const { spawn } = require('node:child_process');",
		"process.on('SIGTERM', () => {});",
		`const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', process.stderr, 'ipc'] });`,
		"child.on('message', () => {",
		"process.send('ready');",
		shouldExitLeader ? 'process.exit(0);' : '',
		'});'
	].join('\n');
	const child = spawn(process.execPath, ['-e', script], {
		detached: true,
		stdio: ['ignore', 'ignore', 'pipe', 'ipc']
	});
	const closed = once(child, 'close');
	const exited = once(child, 'exit');
	const daemon = RunningCiNixDaemon.observe(
		child,
		path.join(directory, 'daemon.sock')
	);
	await once(child, 'message');

	if (shouldExitLeader) {
		await exited;
	}

	return { child, closed, daemon };
}

function killTestProcessGroup(child: ChildProcess): void {
	if (child.pid === undefined) {
		return;
	}

	try {
		process.kill(-child.pid, 'SIGKILL');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
			return;
		}

		throw error;
	}
}

describe('owned daemon process groups', () => {
	it.each([false, true])(
		'removes a socket discovered after startup failure (already stopped: %s)',
		async (isAlreadyStopped) => {
			await withTemporaryDirectory(
				'cupboard-failed-daemon-',
				async (directory) => {
					const socketPath = path.join(directory, 'daemon.sock');
					const script = `const { createServer } = require('node:net'); createServer().listen(${JSON.stringify(socketPath)}, () => process.exit(7));`;
					const child = spawn(process.execPath, ['-e', script], {
						detached: true,
						stdio: ['ignore', 'ignore', 'pipe']
					});
					const daemon = RunningCiNixDaemon.observe(child, socketPath);
					await once(child, 'close');
					expect(existsSync(socketPath)).toBe(true);
					if (isAlreadyStopped) {
						await daemon.stop();
					}
					await expect(
						daemon.waitUntilReady(new AbortController().signal)
					).rejects.toThrow('did not open its socket');
					expect(existsSync(socketPath)).toBe(false);
				}
			);
		}
	);
	it('kills inherited stderr descendants before waiting for an exited leader to close', async () => {
		await withTemporaryDirectory(
			'cupboard-exited-daemon-',
			async (directory) => {
				const { child, closed, daemon } = await inheritedDaemonProcess(
					directory,
					true
				);
				const kill = vi.spyOn(process, 'kill');
				const stopping = daemon.stop();

				try {
					expect(daemon.stop()).toBe(stopping);
					expect(kill).toHaveBeenCalledWith(-(child.pid ?? 0), 'SIGKILL');
					await stopping;
				} finally {
					kill.mockRestore();
					killTestProcessGroup(child);
					await closed;
					await stopping;
				}
			}
		);
	});

	it('escalates a cancelled startup even while its process group ignores termination', async () => {
		await withTemporaryDirectory(
			'cupboard-stubborn-daemon-',
			async (directory) => {
				const { child, closed, daemon } = await inheritedDaemonProcess(
					directory,
					false
				);
				const kill = vi.spyOn(process, 'kill');
				vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
				const controller = new AbortController();
				const startup = daemon.waitUntilReady(controller.signal);
				const rejected = expect(startup).rejects.toThrow('cancelled startup');
				controller.abort(new Error('cancelled startup'));

				try {
					expect(vi.getTimerCount()).toBe(1);
					await vi.advanceTimersByTimeAsync(5000);
					expect(kill).toHaveBeenCalledWith(-(child.pid ?? 0), 'SIGKILL');
					await rejected;
					expect(vi.getTimerCount()).toBe(0);
				} finally {
					kill.mockRestore();
					killTestProcessGroup(child);
					await closed;
					await rejected;
					vi.useRealTimers();
				}
			}
		);
	});
});
