import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import type { ChildEnvironment } from './nix-config.ts';
import { removeInvocationRuntimeDirectory } from './runtime-directory.ts';

/** An argv array with the executable first. */
export type ChildCommand = readonly [string, ...string[]];

/** How the child ended: an exit status, or the signal that killed it. */
export interface ChildExit {
	readonly status: number | undefined;
	readonly signal: NodeJS.Signals | undefined;
}

/** Where the forwarded signals arrive; `process` in production. */
export interface SignalSource {
	on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
	off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** A pending forced child termination that can be cancelled after child exit. */
export interface ScheduledChildTermination {
	cancel(): void;
}

/** Schedules forced child termination after the graceful shutdown window. */
export interface ChildTerminationScheduler {
	schedule(run: () => void, delayMs: number): ScheduledChildTermination;
}

/** Time allowed for an interrupted child to exit before SIGKILL. */
export const childTerminationGracePeriodMs = 10_000;

const defaultChildTerminationScheduler: ChildTerminationScheduler = {
	schedule(run, delayMs) {
		const timeout = setTimeout(run, delayMs);
		timeout.unref();

		return {
			cancel() {
				clearTimeout(timeout);
			}
		};
	}
};

export interface RunChildOptions {
	readonly command: ChildCommand;
	readonly environment: ChildEnvironment;
	readonly signal?: AbortSignal;
	readonly signalSource?: SignalSource;
	readonly terminationScheduler?: ChildTerminationScheduler;
}

export interface SuperviseOptions {
	readonly command: ChildCommand;
	readonly environment: ChildEnvironment;
	/** The invocation runtime directory, removed once the run is over. */
	readonly runtimeDirectory: string;
	/**
	 * Runs after the child exits and before the runtime directory is removed:
	 * the command layer drains uploads and reconciles here, while the hook
	 * endpoint still exists.
	 */
	readonly onExit?: (exit: ChildExit) => Promise<void>;
	readonly signalSource?: SignalSource;
	readonly terminationScheduler?: ChildTerminationScheduler;
}

function waitForExit(child: ChildProcess): Promise<ChildExit> {
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (status, signal) => {
			resolve({ status: status ?? undefined, signal: signal ?? undefined });
		});
	});
}

/**
 * Runs one child to completion with the given environment and inherited
 * stdio, so its output and semantics are untouched. SIGINT and SIGTERM
 * arriving at the supervisor are forwarded to the child while it runs, as is
 * an explicit AbortSignal cancellation. A child that does not exit within the
 * graceful shutdown window is killed. The first forwarded signal remains the
 * run's result even when the child traps it.
 */
export async function runChild(options: RunChildOptions): Promise<ChildExit> {
	options.signal?.throwIfAborted();

	const signalSource = options.signalSource ?? process;
	const [executable, ...childArguments] = options.command;
	const child = spawn(executable, childArguments, {
		stdio: 'inherit',
		env: { ...options.environment }
	});
	const terminationScheduler =
		options.terminationScheduler ?? defaultChildTerminationScheduler;
	let interrupted: NodeJS.Signals | undefined;
	let isChildExited = false;
	let scheduledTermination: ScheduledChildTermination | undefined;

	const interruptWith = (signal: 'SIGINT' | 'SIGTERM'): void => {
		if (interrupted !== undefined) {
			return;
		}

		interrupted = signal;
		child.kill(signal);
		scheduledTermination = terminationScheduler.schedule(() => {
			if (!isChildExited) {
				child.kill('SIGKILL');
			}
		}, childTerminationGracePeriodMs);
	};
	const forwardInt = (): void => {
		interruptWith('SIGINT');
	};
	const forwardTerm = (): void => {
		interruptWith('SIGTERM');
	};
	const abort = (): void => {
		forwardTerm();
	};

	signalSource.on('SIGINT', forwardInt);
	signalSource.on('SIGTERM', forwardTerm);
	options.signal?.addEventListener('abort', abort, { once: true });

	if (options.signal?.aborted === true) {
		abort();
	}

	try {
		const exit = await waitForExit(child);
		isChildExited = true;
		const signal = interrupted ?? exit.signal;

		return signal === undefined ? exit : { status: undefined, signal };
	} finally {
		isChildExited = true;
		scheduledTermination?.cancel();
		options.signal?.removeEventListener('abort', abort);
		signalSource.off('SIGINT', forwardInt);
		signalSource.off('SIGTERM', forwardTerm);
	}
}

/**
 * Runs the user-supplied build command to completion with the composed
 * environment and inherited stdio, so the child's output and semantics are
 * untouched: a failed build is still a failed build, and the caller reads the
 * child's own exit status or signal from the result unless the supervisor was
 * interrupted. SIGINT and SIGTERM arriving at the supervisor are forwarded to
 * the child and escalate to SIGKILL after the graceful shutdown window. The
 * first signal remains the run's result, and the invocation runtime directory
 * is removed once the run is over, whether the child succeeded, failed, or
 * could not start.
 */
export async function superviseBuild(
	options: SuperviseOptions
): Promise<ChildExit> {
	try {
		const exit = await runChild({
			command: options.command,
			environment: options.environment,
			...(options.signalSource !== undefined && {
				signalSource: options.signalSource
			}),
			...(options.terminationScheduler !== undefined && {
				terminationScheduler: options.terminationScheduler
			})
		});

		await options.onExit?.(exit);

		return exit;
	} finally {
		await removeInvocationRuntimeDirectory(options.runtimeDirectory);
	}
}

/**
 * One constructed build attempt: its ordinal within the run, the identifier
 * the receipt names it by, the JSON activity log it left, and how its child
 * ended.
 */
export interface SupervisedAttempt {
	readonly attempt: number;
	readonly attemptId: string;
	readonly log: string;
	readonly exit: ChildExit;
}

export interface AttemptedBuildOptions {
	/** Composes one attempt's argv around its JSON activity log file. */
	readonly command: (logFile: string) => ChildCommand;
	/** Maximum attempts; the loop stops at the first success. */
	readonly attempts: number;
	readonly environment: ChildEnvironment;
	/** The invocation runtime directory, removed once the run is over. */
	readonly runtimeDirectory: string;
	readonly signalSource?: SignalSource;
	readonly terminationScheduler?: ChildTerminationScheduler;
	/** Names each attempt; injectable for tests. */
	readonly nextAttemptId?: () => string;
	/** Starts the cancellable wait between attempts; injectable for tests. */
	readonly startDelay?: StartDelay;
}

export interface AttemptedBuildResult {
	/** The last attempt's ending, which is the run's build verdict. */
	readonly exit: ChildExit;
	readonly attempts: readonly SupervisedAttempt[];
}

// A failed attempt often failed on a transient (a flaky fetch, a lost remote
// builder), so the next one waits a little longer than the one before.
const attemptDelayMs = 15_000;

/** A retry wait whose event-loop resource can be released immediately. */
export interface CancellableDelay {
	readonly completed: Promise<void>;
	cancel(): void;
}

export type StartDelay = (delayMs: number) => CancellableDelay;

export function startTimerDelay(delayMs: number): CancellableDelay {
	const completed = Promise.withResolvers<undefined>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	timer = setTimeout(() => {
		timer = undefined;
		completed.resolve(undefined);
	}, delayMs);

	return {
		completed: completed.promise,
		cancel() {
			if (timer === undefined) {
				return;
			}

			clearTimeout(timer);
			timer = undefined;
			completed.resolve(undefined);
		}
	};
}

// An attempt's activity log lives in the invocation runtime directory, which
// is owner-only and removed with the run. The log is read back as soon as the
// attempt's child has exited, before the next attempt can change the store
// state it describes. A child that failed to start leaves no log to attribute.
async function readAttemptLog(logFile: string): Promise<string> {
	try {
		return await readFile(logFile, 'utf8');
	} catch {
		return '';
	}
}

/**
 * Runs a constructed build invocation under the bounded attempt loop: each
 * attempt gets its own identifier and JSON activity log, a failed attempt
 * waits a growing delay before the next, and the loop stops at the first
 * success or once the attempts are spent. The invocation runtime directory is
 * removed once the run is over, the way {@link superviseBuild} removes it.
 */
export async function superviseAttemptedBuild(
	options: AttemptedBuildOptions
): Promise<AttemptedBuildResult> {
	const nextAttemptId = options.nextAttemptId ?? randomUUID;
	const startDelay = options.startDelay ?? startTimerDelay;
	const signalSource = options.signalSource ?? process;
	const attempts: SupervisedAttempt[] = [];
	let exit: ChildExit = { status: undefined, signal: undefined };
	let interrupted: NodeJS.Signals | undefined;
	let wakeDelay: (() => void) | undefined;
	const interruptWith = (signal: NodeJS.Signals): void => {
		interrupted ??= signal;
		wakeDelay?.();
	};
	const interruptInt = (): void => {
		interruptWith('SIGINT');
	};
	const interruptTerm = (): void => {
		interruptWith('SIGTERM');
	};
	const interruptedSignal = (): NodeJS.Signals | undefined => interrupted;

	signalSource.on('SIGINT', interruptInt);
	signalSource.on('SIGTERM', interruptTerm);

	try {
		for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
			const attemptId = nextAttemptId();
			const logFile = path.join(
				options.runtimeDirectory,
				`nix-log-${attemptId}.jsonl`
			);

			exit = await runChild({
				command: options.command(logFile),
				environment: options.environment,
				...(options.signalSource !== undefined && {
					signalSource: options.signalSource
				}),
				...(options.terminationScheduler !== undefined && {
					terminationScheduler: options.terminationScheduler
				})
			});
			attempts.push({
				attempt,
				attemptId,
				log: await readAttemptLog(logFile),
				exit
			});

			if (interruptedSignal() !== undefined || exit.signal !== undefined) {
				exit = {
					status: undefined,
					signal: exit.signal ?? interruptedSignal()
				};
				break;
			}

			if (exit.status === 0) {
				break;
			}

			if (attempt < options.attempts) {
				const delayInterruption = Promise.withResolvers<undefined>();
				const delay = startDelay(attempt * attemptDelayMs);
				wakeDelay = () => {
					delayInterruption.resolve(undefined);
				};

				try {
					await Promise.race([delay.completed, delayInterruption.promise]);
				} finally {
					delay.cancel();
					wakeDelay = undefined;
				}

				const signal = interruptedSignal();

				if (signal !== undefined) {
					exit = { status: undefined, signal };
					break;
				}
			}
		}

		return { exit, attempts };
	} finally {
		signalSource.off('SIGINT', interruptInt);
		signalSource.off('SIGTERM', interruptTerm);
		await removeInvocationRuntimeDirectory(options.runtimeDirectory);
	}
}
