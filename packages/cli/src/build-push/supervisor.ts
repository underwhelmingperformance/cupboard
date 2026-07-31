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

export interface RunChildOptions {
	readonly command: ChildCommand;
	readonly environment: ChildEnvironment;
	readonly signalSource?: SignalSource;
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
 * arriving at the supervisor are forwarded to the child while it runs.
 */
export async function runChild(options: RunChildOptions): Promise<ChildExit> {
	const signalSource = options.signalSource ?? process;
	const [executable, ...childArguments] = options.command;
	const child = spawn(executable, childArguments, {
		stdio: 'inherit',
		env: { ...options.environment }
	});

	const forwardInt = (): void => {
		child.kill('SIGINT');
	};
	const forwardTerm = (): void => {
		child.kill('SIGTERM');
	};

	signalSource.on('SIGINT', forwardInt);
	signalSource.on('SIGTERM', forwardTerm);

	try {
		return await waitForExit(child);
	} finally {
		signalSource.off('SIGINT', forwardInt);
		signalSource.off('SIGTERM', forwardTerm);
	}
}

/**
 * Runs the user-supplied build command to completion with the composed
 * environment and inherited stdio, so the child's output and semantics are
 * untouched: a failed build is still a failed build, and the caller reads the
 * child's own exit status or signal from the result. SIGINT and SIGTERM
 * arriving at the supervisor are forwarded to the child, and the invocation
 * runtime directory is removed once the run is over, whether the child
 * succeeded, failed, or could not start.
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
	/** Names each attempt; injectable for tests. */
	readonly nextAttemptId?: () => string;
	/** Waits between attempts; injectable for tests. */
	readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface AttemptedBuildResult {
	/** The last attempt's ending, which is the run's build verdict. */
	readonly exit: ChildExit;
	readonly attempts: readonly SupervisedAttempt[];
}

// A failed attempt often failed on a transient (a flaky fetch, a lost remote
// builder), so the next one waits a little longer than the one before.
const attemptDelayMs = 15_000;

function delay(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

// An attempt's activity log lives in the invocation runtime directory, which
// is owner-only and removed with the run, so it is read back before the next
// attempt can overwrite the store's state it describes. A child that failed
// to start leaves no log to attribute.
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
	const sleep = options.sleep ?? delay;
	const attempts: SupervisedAttempt[] = [];
	let exit: ChildExit = { status: undefined, signal: undefined };

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
				})
			});
			attempts.push({
				attempt,
				attemptId,
				log: await readAttemptLog(logFile),
				exit
			});

			if (exit.status === 0) {
				break;
			}

			if (attempt < options.attempts) {
				await sleep(attempt * attemptDelayMs);
			}
		}

		return { exit, attempts };
	} finally {
		await removeInvocationRuntimeDirectory(options.runtimeDirectory);
	}
}
