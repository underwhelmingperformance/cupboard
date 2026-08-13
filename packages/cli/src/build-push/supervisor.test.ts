import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { platform } from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import { waitForFile } from '../../../../tests/support/filesystem.ts';

import {
	type ChildExit,
	runChild,
	type SignalSource,
	startTimerDelay,
	superviseAttemptedBuild,
	superviseBuild
} from './supervisor.ts';

async function runtimeDirectory(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), 'cup-sup-'));
}

function recordingSignalSource() {
	const listeners = new Map<string, (() => void)[]>();

	const source: SignalSource = {
		on(signal, listener) {
			listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);

			return source;
		},
		off(signal, listener) {
			listeners.set(
				signal,
				(listeners.get(signal) ?? []).filter((item) => item !== listener)
			);

			return source;
		}
	};

	return {
		source,
		emit(signal: string): void {
			const registered = listeners.get(signal) ?? [];

			for (const listener of registered) {
				listener();
			}
		},
		listenerCount(): number {
			return listeners
				.values()
				.reduce((total, registered) => total + registered.length, 0);
		}
	};
}

function blockUntilSignal(exitStatus: number): string {
	return `mkfifo "$CUPBOARD_TEST_GATE"; trap 'exit ${String(exitStatus)}' INT TERM; : > "$CUPBOARD_TEST_READY"; read _ 2>/dev/null < "$CUPBOARD_TEST_GATE"`;
}

describe('superviseBuild', () => {
	it.each([
		{
			name: 'a successful child',
			script: 'exit 0',
			expected: { status: 0, signal: undefined }
		},
		{
			name: 'a failing child, preserving its status',
			script: 'exit 7',
			expected: { status: 7, signal: undefined }
		}
	])('passes through the exit of $name', async ({ script, expected }) => {
		const directory = await runtimeDirectory();

		const exit = await superviseBuild({
			command: ['sh', '-c', script],
			environment: {},
			runtimeDirectory: directory
		});

		expect(exit).toStrictEqual(expected);
	});

	it('runs the child with the composed environment', async () => {
		const directory = await runtimeDirectory();
		const outFile = path.join(tmpdir(), `cup-sup-env-${String(Date.now())}`);

		try {
			const exit = await superviseBuild({
				command: ['sh', '-c', 'printf %s "$NIX_CONFIG" > "$CUPBOARD_TEST_OUT"'],
				environment: {
					PATH: '/usr/bin:/bin',
					CUPBOARD_TEST_OUT: outFile,
					NIX_CONFIG: 'post-build-hook = /inv/hook.sh'
				},
				runtimeDirectory: directory
			});

			expect({
				exit,
				written: await readFile(outFile, 'utf8')
			}).toStrictEqual({
				exit: { status: 0, signal: undefined },
				written: 'post-build-hook = /inv/hook.sh'
			});
		} finally {
			await rm(outFile, { force: true });
		}
	});

	it.each([
		{ name: 'a successful child', script: 'exit 0' },
		{ name: 'a failing child', script: 'exit 3' }
	])('removes the runtime directory after $name', async ({ script }) => {
		const directory = await runtimeDirectory();

		await superviseBuild({
			command: ['sh', '-c', script],
			environment: {},
			runtimeDirectory: directory
		});

		await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('removes the runtime directory when the child cannot start', async () => {
		const directory = await runtimeDirectory();

		await expect(
			superviseBuild({
				command: [path.join(directory, 'missing-executable')],
				environment: {},
				runtimeDirectory: directory
			})
		).rejects.toMatchObject({ code: 'ENOENT' });

		await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('drains through onExit before removing the runtime directory', async () => {
		const directory = await runtimeDirectory();
		const observed: { exit: ChildExit; directoryExisted: boolean }[] = [];

		await superviseBuild({
			command: ['sh', '-c', 'exit 5'],
			environment: {},
			runtimeDirectory: directory,
			onExit: async (exit) => {
				let didDirectoryExist = true;

				try {
					await stat(directory);
				} catch {
					didDirectoryExist = false;
				}

				observed.push({ exit, directoryExisted: didDirectoryExist });
			}
		});

		expect(observed).toStrictEqual([
			{ exit: { status: 5, signal: undefined }, directoryExisted: true }
		]);
	});

	it.runIf(platform === 'darwin' || platform === 'linux').each([
		{ signal: 'SIGINT', followingSignal: 'SIGTERM' },
		{ signal: 'SIGTERM', followingSignal: 'SIGINT' }
	])(
		'preserves the first $signal when the child traps signals and exits successfully',
		async ({ signal, followingSignal }) => {
			const directory = await runtimeDirectory();
			const readyFile = path.join(
				tmpdir(),
				`cup-sup-ready-${signal}-${String(Date.now())}`
			);
			const gateFile = `${readyFile}.fifo`;
			const signals = recordingSignalSource();

			try {
				const running = superviseBuild({
					command: ['sh', '-c', blockUntilSignal(0)],
					environment: {
						PATH: '/usr/bin:/bin',
						CUPBOARD_TEST_GATE: gateFile,
						CUPBOARD_TEST_READY: readyFile
					},
					runtimeDirectory: directory,
					signalSource: signals.source
				});

				await waitForFile(readyFile);
				signals.emit(signal);
				signals.emit(followingSignal);

				expect({
					exit: await running,
					remainingListeners: signals.listenerCount()
				}).toStrictEqual({
					exit: { status: undefined, signal },
					remainingListeners: 0
				});
			} finally {
				await Promise.all([
					rm(gateFile, { force: true }),
					rm(readyFile, { force: true })
				]);
			}
		}
	);

	it.runIf(platform === 'darwin' || platform === 'linux')(
		'forwards AbortSignal cancellation to the running child',
		async () => {
			const readyFile = path.join(
				tmpdir(),
				`cup-child-abort-ready-${String(Date.now())}`
			);
			const gateFile = `${readyFile}.fifo`;
			const controller = new AbortController();

			try {
				const running = runChild({
					command: ['sh', '-c', blockUntilSignal(0)],
					environment: {
						PATH: '/usr/bin:/bin',
						CUPBOARD_TEST_GATE: gateFile,
						CUPBOARD_TEST_READY: readyFile
					},
					signal: controller.signal
				});

				await waitForFile(readyFile);
				controller.abort(new Error('cancel child'));

				await expect(running).resolves.toStrictEqual({
					status: undefined,
					signal: 'SIGTERM'
				});
			} finally {
				await Promise.all([
					rm(gateFile, { force: true }),
					rm(readyFile, { force: true })
				]);
			}
		}
	);
});

function attemptIds(): () => string {
	let issued = 0;

	return () => {
		issued += 1;

		return `attempt-${String(issued)}`;
	};
}

describe('superviseAttemptedBuild', () => {
	it('stops at the first success, sleeping a growing delay between attempts', async () => {
		const directory = await runtimeDirectory();
		const sleeps: number[] = [];
		let calls = 0;

		const result = await superviseAttemptedBuild({
			command: (logFile) => {
				calls += 1;

				return [
					'sh',
					'-c',
					`printf %s '{"call":${String(calls)}}' > "${logFile}"; exit ${calls < 2 ? '1' : '0'}`
				];
			},
			attempts: 3,
			environment: { PATH: '/usr/bin:/bin' },
			runtimeDirectory: directory,
			nextAttemptId: attemptIds(),
			startDelay: (delayMs) => {
				sleeps.push(delayMs);

				return {
					completed: Promise.resolve(),
					cancel() {
						return;
					}
				};
			}
		});

		expect({ result, sleeps }).toStrictEqual({
			result: {
				exit: { status: 0, signal: undefined },
				attempts: [
					{
						attempt: 1,
						attemptId: 'attempt-1',
						log: '{"call":1}',
						exit: { status: 1, signal: undefined }
					},
					{
						attempt: 2,
						attemptId: 'attempt-2',
						log: '{"call":2}',
						exit: { status: 0, signal: undefined }
					}
				]
			},
			sleeps: [15_000]
		});
	});

	it('spends every attempt on a persistent failure, keeping the final exit', async () => {
		const directory = await runtimeDirectory();
		const sleeps: number[] = [];

		const result = await superviseAttemptedBuild({
			command: () => ['sh', '-c', 'exit 2'],
			attempts: 3,
			environment: { PATH: '/usr/bin:/bin' },
			runtimeDirectory: directory,
			nextAttemptId: attemptIds(),
			startDelay: (delayMs) => {
				sleeps.push(delayMs);

				return {
					completed: Promise.resolve(),
					cancel() {
						return;
					}
				};
			}
		});

		expect({ result, sleeps }).toStrictEqual({
			result: {
				exit: { status: 2, signal: undefined },
				attempts: [
					{
						attempt: 1,
						attemptId: 'attempt-1',
						log: '',
						exit: { status: 2, signal: undefined }
					},
					{
						attempt: 2,
						attemptId: 'attempt-2',
						log: '',
						exit: { status: 2, signal: undefined }
					},
					{
						attempt: 3,
						attemptId: 'attempt-3',
						log: '',
						exit: { status: 2, signal: undefined }
					}
				]
			},
			sleeps: [15_000, 30_000]
		});
	});

	it.runIf(platform === 'darwin' || platform === 'linux')(
		'does not retry a child interrupted by a forwarded signal',
		async () => {
			const directory = await runtimeDirectory();
			const readyFile = path.join(
				tmpdir(),
				`cup-attempt-ready-${String(Date.now())}`
			);
			const gateFile = `${readyFile}.fifo`;
			const signals = recordingSignalSource();
			let calls = 0;

			try {
				const running = superviseAttemptedBuild({
					command: () => {
						calls += 1;

						return ['sh', '-c', blockUntilSignal(42)];
					},
					attempts: 3,
					environment: {
						PATH: '/usr/bin:/bin',
						CUPBOARD_TEST_GATE: gateFile,
						CUPBOARD_TEST_READY: readyFile
					},
					runtimeDirectory: directory,
					signalSource: signals.source,
					nextAttemptId: attemptIds()
				});

				await waitForFile(readyFile);
				signals.emit('SIGINT');

				expect({ result: await running, calls }).toStrictEqual({
					result: {
						exit: { status: undefined, signal: 'SIGINT' },
						attempts: [
							{
								attempt: 1,
								attemptId: 'attempt-1',
								log: '',
								exit: { status: undefined, signal: 'SIGINT' }
							}
						]
					},
					calls: 1
				});
			} finally {
				await Promise.all([
					rm(gateFile, { force: true }),
					rm(readyFile, { force: true })
				]);
			}
		}
	);

	it('aborts a retry delay when a signal arrives', async () => {
		const directory = await runtimeDirectory();
		const signals = recordingSignalSource();
		let calls = 0;
		let cancellations = 0;

		const result = await superviseAttemptedBuild({
			command: () => {
				calls += 1;

				return ['sh', '-c', 'exit 2'];
			},
			attempts: 3,
			environment: { PATH: '/usr/bin:/bin' },
			runtimeDirectory: directory,
			signalSource: signals.source,
			nextAttemptId: attemptIds(),
			startDelay: () => {
				queueMicrotask(() => {
					signals.emit('SIGTERM');
				});

				return {
					completed: Promise.withResolvers<never>().promise,
					cancel() {
						cancellations += 1;
					}
				};
			}
		});

		expect({
			result,
			calls,
			cancellations,
			listeners: signals.listenerCount()
		}).toStrictEqual({
			result: {
				exit: { status: undefined, signal: 'SIGTERM' },
				attempts: [
					{
						attempt: 1,
						attemptId: 'attempt-1',
						log: '',
						exit: { status: 2, signal: undefined }
					}
				]
			},
			calls: 1,
			cancellations: 1,
			listeners: 0
		});
	});

	it('clears the production retry timer when it is cancelled', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		try {
			const baselineTimers = vi.getTimerCount();
			const delay = startTimerDelay(15_000);
			const timersAfterStarting = vi.getTimerCount() - baselineTimers;

			delay.cancel();
			const timersAfterCancelling = vi.getTimerCount() - baselineTimers;
			await delay.completed;

			expect({
				timersAfterStarting,
				timersAfterCancelling
			}).toStrictEqual({
				timersAfterStarting: 1,
				timersAfterCancelling: 0
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('removes the runtime directory once the attempts are over', async () => {
		const directory = await runtimeDirectory();

		await superviseAttemptedBuild({
			command: () => ['sh', '-c', 'exit 1'],
			attempts: 2,
			environment: { PATH: '/usr/bin:/bin' },
			runtimeDirectory: directory,
			startDelay: () => ({
				completed: Promise.resolve(),
				cancel() {
					return;
				}
			})
		});

		await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
