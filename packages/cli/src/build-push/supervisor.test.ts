import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { platform } from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import {
	type ChildExit,
	childTerminationGracePeriodMs,
	type ChildTerminationScheduler,
	type RunChild,
	runChild,
	type RunChildOptions,
	type SignalSource,
	spawnChildProcess,
	startTimerDelay,
	superviseAttemptedBuild,
	superviseBuild,
	type SupervisedChild
} from './supervisor.ts';

class ControlledTerminationScheduler implements ChildTerminationScheduler {
	readonly scheduled: {
		readonly delayMs: number;
		readonly run: () => void;
		cancelled: boolean;
	}[] = [];

	schedule(run: () => void, delayMs: number) {
		const termination = { delayMs, run, cancelled: false };
		this.scheduled.push(termination);

		return {
			cancel() {
				termination.cancelled = true;
			}
		};
	}

	runPending(): void {
		for (const termination of this.scheduled) {
			if (!termination.cancelled) {
				termination.run();
			}
		}
	}
}

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

/**
 * A child the case drives. It is already running when `runChild` receives it
 * and exits only when the case says so, which is what a real child needed a
 * ready file and a wait to arrange.
 */
function controlledChild() {
	const exited = Promise.withResolvers<ChildExit>();
	const signals: NodeJS.Signals[] = [];
	const child: SupervisedChild = {
		kill(signal) {
			signals.push(signal);
		},
		exited: exited.promise
	};

	return {
		child,
		signals,
		exitWith(exit: ChildExit): void {
			exited.resolve(exit);
		},
		failWith(error: Error): void {
			exited.reject(error);
		}
	};
}

/**
 * A `runChild` the case controls. It records what the supervisor asked it for
 * and answers with the given exit.
 */
function recordingRunChild(exit: ChildExit) {
	const calls: RunChildOptions[] = [];
	const runs: RunChild = (options) => {
		calls.push(options);

		return Promise.resolve(exit);
	};

	return { calls, runChild: runs };
}

const succeeded: ChildExit = { status: 0, signal: undefined };

describe('superviseBuild', () => {
	it('preserves an on-exit failure when runtime removal also fails', async () => {
		const primary = new Error('on-exit failed');
		const removed: string[] = [];

		await expect(
			superviseBuild({
				command: ['sh', '-c', 'exit 0'],
				environment: {},
				runtimeDirectory: '/unused/runtime',
				runChild: () => Promise.resolve(succeeded),
				onExit: () => Promise.reject(primary),
				removeRuntimeDirectory: (directory) => {
					removed.push(directory);
					return Promise.reject(new Error('removal failed'));
				}
			})
		).rejects.toBe(primary);
		expect(removed).toStrictEqual(['/unused/runtime']);
	});

	it.each([
		{ name: 'a successful child', exit: { status: 0, signal: undefined } },
		{
			name: 'a failing child, preserving its status',
			exit: { status: 7, signal: undefined }
		},
		{
			name: 'a signalled child, preserving its signal',
			exit: { status: undefined, signal: 'SIGINT' as const }
		}
	])('passes through the exit of $name', async ({ exit }) => {
		const directory = await runtimeDirectory();

		const observed = await superviseBuild({
			command: ['sh', '-c', 'exit 0'],
			environment: {},
			runtimeDirectory: directory,
			runChild: () => Promise.resolve(exit)
		});

		expect(observed).toStrictEqual(exit);
	});

	it('hands the command and the composed environment to the child', async () => {
		const directory = await runtimeDirectory();
		const child = recordingRunChild(succeeded);
		const environment = {
			PATH: '/usr/bin:/bin',
			NIX_CONFIG: 'post-build-hook = /inv/hook.sh'
		};

		await superviseBuild({
			command: ['nix', 'build', '.#thing'],
			environment,
			runtimeDirectory: directory,
			runChild: child.runChild
		});

		expect(
			child.calls.map((call) => ({
				command: call.command,
				environment: call.environment
			}))
		).toStrictEqual([{ command: ['nix', 'build', '.#thing'], environment }]);
	});

	it.each([
		{ name: 'a successful child', exit: { status: 0, signal: undefined } },
		{ name: 'a failing child', exit: { status: 3, signal: undefined } }
	])('removes the runtime directory after $name', async ({ exit }) => {
		const directory = await runtimeDirectory();

		await superviseBuild({
			command: ['sh', '-c', 'exit 0'],
			environment: {},
			runtimeDirectory: directory,
			runChild: () => Promise.resolve(exit)
		});

		await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('removes the runtime directory when the child cannot start', async () => {
		const directory = await runtimeDirectory();
		const failure = new Error('spawn failed');

		await expect(
			superviseBuild({
				command: [path.join(directory, 'missing-executable')],
				environment: {},
				runtimeDirectory: directory,
				runChild: () => Promise.reject(failure)
			})
		).rejects.toBe(failure);

		await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('drains through onExit before removing the runtime directory', async () => {
		const directory = await runtimeDirectory();
		const observed: { exit: ChildExit; directoryExisted: boolean }[] = [];

		await superviseBuild({
			command: ['sh', '-c', 'exit 5'],
			environment: {},
			runtimeDirectory: directory,
			runChild: () => Promise.resolve({ status: 5, signal: undefined }),
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
});

describe('runChild', () => {
	it.each([
		{ signal: 'SIGINT' as const, followingSignal: 'SIGTERM' as const },
		{ signal: 'SIGTERM' as const, followingSignal: 'SIGINT' as const }
	])(
		'keeps the first $signal as the result when the child traps it and exits successfully',
		async ({ signal, followingSignal }) => {
			const child = controlledChild();
			const signals = recordingSignalSource();

			const running = runChild({
				command: ['sh', '-c', 'sleep 30'],
				environment: {},
				signalSource: signals.source,
				spawnChild: () => child.child
			});

			signals.emit(signal);
			signals.emit(followingSignal);
			child.exitWith(succeeded);

			expect({
				exit: await running,
				forwarded: child.signals,
				remainingListeners: signals.listenerCount()
			}).toStrictEqual({
				exit: { status: undefined, signal },
				forwarded: [signal],
				remainingListeners: 0
			});
		}
	);

	it('escalates to SIGKILL when the child outlives the grace period', async () => {
		const child = controlledChild();
		const signals = recordingSignalSource();
		const scheduler = new ControlledTerminationScheduler();

		const running = runChild({
			command: ['sh', '-c', 'sleep 30'],
			environment: {},
			signalSource: signals.source,
			terminationScheduler: scheduler,
			spawnChild: () => child.child
		});

		signals.emit('SIGTERM');

		expect(
			scheduler.scheduled.map(({ delayMs, cancelled }) => ({
				delayMs,
				cancelled
			}))
		).toStrictEqual([
			{ delayMs: childTerminationGracePeriodMs, cancelled: false }
		]);

		scheduler.runPending();
		child.exitWith({ status: undefined, signal: 'SIGKILL' });

		expect({
			exit: await running,
			forwarded: child.signals,
			remainingListeners: signals.listenerCount(),
			scheduledTerminations: scheduler.scheduled.map(
				({ delayMs, cancelled }) => ({ delayMs, cancelled })
			)
		}).toStrictEqual({
			exit: { status: undefined, signal: 'SIGTERM' },
			forwarded: ['SIGTERM', 'SIGKILL'],
			remainingListeners: 0,
			scheduledTerminations: [
				{ delayMs: childTerminationGracePeriodMs, cancelled: true }
			]
		});
	});

	it('forwards AbortSignal cancellation to the running child', async () => {
		const child = controlledChild();
		const controller = new AbortController();

		const running = runChild({
			command: ['sh', '-c', 'sleep 30'],
			environment: {},
			signal: controller.signal,
			spawnChild: () => child.child
		});

		controller.abort(new Error('cancel child'));
		child.exitWith({ status: undefined, signal: 'SIGTERM' });

		expect({ exit: await running, forwarded: child.signals }).toStrictEqual({
			exit: { status: undefined, signal: 'SIGTERM' },
			forwarded: ['SIGTERM']
		});
	});

	it('preserves a child-start failure while removing every signal listener', async () => {
		const child = controlledChild();
		const failure = new Error('child could not start');
		const removed: string[] = [];
		const source: SignalSource = {
			on: () => source,
			off(signal) {
				removed.push(signal);
				throw new Error(`${signal} removal failed`);
			}
		};

		const running = runChild({
			command: ['/definitely/missing/cupboard-child'],
			environment: {},
			signalSource: source,
			spawnChild: () => child.child
		});

		child.failWith(failure);

		await expect(running).rejects.toBe(failure);
		expect(removed).toStrictEqual(['SIGINT', 'SIGTERM']);
	});
});

// These cases start a real process, because what they assert belongs to Node
// and the operating system rather than to this module: how a signalled child,
// a supplied environment and a missing executable are reported back. None of
// them waits for the child to become ready, so none waits for longer than
// starting a process takes.
describe('runChild against a real process', () => {
	// The injected cases see the supervisor call `kill` and never see a real
	// process receive the signal, which is the thing the supervisor exists to
	// do. The kill goes out as soon as `spawn` returns, because Node has the
	// child's process id by then and the child does not have to have finished
	// starting to be signalled.
	it.runIf(platform === 'darwin' || platform === 'linux')(
		'signals the process it started',
		async () => {
			const child = spawnChildProcess(['sh', '-c', 'sleep 30'], {
				PATH: '/usr/bin:/bin'
			});

			child.kill('SIGTERM');

			await expect(child.exited).resolves.toStrictEqual({
				status: undefined,
				signal: 'SIGTERM'
			});
		}
	);

	it.runIf(platform === 'darwin' || platform === 'linux')(
		'reports a child killed by a signal as a signal rather than a status',
		async () => {
			const exit = await runChild({
				command: ['sh', '-c', 'kill -TERM $$'],
				environment: { PATH: '/usr/bin:/bin' }
			});

			expect(exit).toStrictEqual({ status: undefined, signal: 'SIGTERM' });
		}
	);

	it('gives the child the composed environment and nothing else', async () => {
		// `mkdtemp` rather than a name built from the clock: two runs of this
		// file that start in the same millisecond would otherwise choose the
		// same path, and the first to finish deletes the other's file.
		const directory = await runtimeDirectory();
		const outFile = path.join(directory, 'child-environment');

		try {
			const exit = await runChild({
				command: [
					'sh',
					'-c',
					'printf %s "$NIX_CONFIG/$CUPBOARD_UNSET" > "$CUPBOARD_TEST_OUT"'
				],
				environment: {
					PATH: '/usr/bin:/bin',
					CUPBOARD_TEST_OUT: outFile,
					NIX_CONFIG: 'post-build-hook = /inv/hook.sh'
				}
			});

			expect({ exit, written: await readFile(outFile, 'utf8') }).toStrictEqual({
				exit: { status: 0, signal: undefined },
				written: 'post-build-hook = /inv/hook.sh/'
			});
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it('rejects when the executable does not exist', async () => {
		await expect(
			runChild({
				command: ['/definitely/missing/cupboard-child'],
				environment: {}
			})
		).rejects.toMatchObject({ code: 'ENOENT' });
	});
});

function attemptIds(): () => string {
	let issued = 0;

	return () => {
		issued += 1;

		return `attempt-${String(issued)}`;
	};
}

function immediateDelay() {
	return {
		completed: Promise.resolve(),
		cancel() {
			return;
		}
	};
}

describe('superviseAttemptedBuild', () => {
	it('stops at the first success, sleeping a growing delay between attempts', async () => {
		const directory = await runtimeDirectory();
		const sleeps: number[] = [];
		let calls = 0;

		const result = await superviseAttemptedBuild({
			command: (logFile) => ['sh', '-c', logFile],
			attempts: 3,
			environment: { PATH: '/usr/bin:/bin' },
			runtimeDirectory: directory,
			nextAttemptId: attemptIds(),
			// The command carries the attempt's log path, so writing it here is
			// what the real child's `nix` invocation does.
			runChild: async (options) => {
				calls += 1;
				await writeFile(options.command[2] ?? '', `{"call":${String(calls)}}`);

				return calls < 2
					? { status: 1, signal: undefined }
					: { status: 0, signal: undefined };
			},
			startDelay: (delayMs) => {
				sleeps.push(delayMs);

				return immediateDelay();
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
			runChild: () => Promise.resolve({ status: 2, signal: undefined }),
			startDelay: (delayMs) => {
				sleeps.push(delayMs);

				return immediateDelay();
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

	it('does not retry a child interrupted by a forwarded signal', async () => {
		const directory = await runtimeDirectory();
		let calls = 0;

		const result = await superviseAttemptedBuild({
			command: () => ['sh', '-c', 'exit 42'],
			attempts: 3,
			environment: { PATH: '/usr/bin:/bin' },
			runtimeDirectory: directory,
			nextAttemptId: attemptIds(),
			runChild: () => {
				calls += 1;

				return Promise.resolve({ status: undefined, signal: 'SIGINT' });
			}
		});

		expect({ result, calls }).toStrictEqual({
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
	});

	it('aborts a retry delay when a signal arrives', async () => {
		const directory = await runtimeDirectory();
		const signals = recordingSignalSource();
		let calls = 0;
		let cancellations = 0;

		const result = await superviseAttemptedBuild({
			command: () => ['sh', '-c', 'exit 2'],
			attempts: 3,
			environment: { PATH: '/usr/bin:/bin' },
			runtimeDirectory: directory,
			signalSource: signals.source,
			nextAttemptId: attemptIds(),
			runChild: () => {
				calls += 1;

				return Promise.resolve({ status: 2, signal: undefined });
			},
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
			runChild: () => Promise.resolve({ status: 1, signal: undefined }),
			startDelay: immediateDelay
		});

		await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
