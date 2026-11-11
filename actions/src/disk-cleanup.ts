import { constants } from 'node:fs';
import { lstat, open, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { isFileNotFound } from './cupboard-run.ts';
import { DiskCleanupFailedError } from './errors.ts';
import type { Environment } from './inputs.ts';

/**
The files that connect the prepare action's background cleanup to the step
that waits for it.
*/
export interface DiskCleanupFiles {
	/**
	A named pipe. The cleanup opens it for writing only when it has finished,
	and writes its exit status. The open blocks until a reader exists, so a
	reader that opens the pipe later cannot miss the status.
	*/
	readonly status: string;
	/**
	The combined output of the cleanup and of the command that started it.
	*/
	readonly log: string;
}

/**
Reads the files from the variables that the prepare action exports. Returns
undefined when the prepare action started no cleanup.
*/
export function diskCleanupFiles(
	environment: Environment
): DiskCleanupFiles | undefined {
	const status = environment.CUPBOARD_DISK_CLEANUP_STATUS;
	const log = environment.CUPBOARD_DISK_CLEANUP_LOG;

	if (status === undefined || status === '' || log === undefined) {
		return undefined;
	}

	return { status, log };
}

/**
How long the join waits for the cleanup. The removal takes about four to
five minutes on a hosted macOS runner.
*/
const diskCleanupTimeoutMilliseconds = 20 * 60 * 1000;

/**
Resolves after `milliseconds`, and rejects when `signal` aborts.
*/
type DiskCleanupTimer = (
	milliseconds: number,
	signal: AbortSignal
) => Promise<void>;

const timeoutTimer: DiskCleanupTimer = (milliseconds, signal) =>
	delay(milliseconds, undefined, { signal });

interface DiskCleanupJoinOptions {
	readonly timeoutMilliseconds?: number;
	readonly timer?: DiskCleanupTimer;
	/**
	Ends the wait with the signal's reason when it aborts.
	*/
	readonly signal?: AbortSignal;
}

interface DiskCleanupReporter {
	info(message: string): void;
	phase<T>(label: string, body: () => Promise<T>): Promise<T>;
}

export type JoinDiskCleanup = (
	files: DiskCleanupFiles,
	reporter: DiskCleanupReporter,
	options?: DiskCleanupJoinOptions
) => Promise<void>;

const statusPattern = /^(?<status>\d+)\n$/u;

/**
Waits for the background disk cleanup that the prepare action started, and
fails with its output when it did not succeed. Returns at once when the
prepare action started no cleanup, or when an earlier call already joined it.

The wait ends when the cleanup writes its status to the pipe. The cleanup
script writes the status from an EXIT trap, so a failure reaches the pipe as
well as a success. A status that is not a number also fails the join. When
the cleanup has not reported by the deadline, the join fails with the output
that the cleanup wrote until then.
*/
export const joinDiskCleanup: JoinDiskCleanup = async (
	files,
	reporter,
	options = {}
) => {
	if (!(await isPipe(files.status))) {
		return;
	}

	const reported = await reporter.phase(
		'Waiting for disk space to be freed',
		() => waitForStatus(files, options)
	);
	const log = await readLog(files.log);

	await rm(files.status, { force: true });

	const status = statusPattern.exec(reported)?.groups?.status;

	if (status !== '0') {
		throw new DiskCleanupFailedError({
			...(status !== undefined && { status: Number(status) }),
			output: log
		});
	}

	reporter.info(`The background disk cleanup finished:\n${log}`);
};

type WaitResult =
	| { readonly kind: 'status'; readonly text: string }
	| { readonly kind: 'deadline' }
	| { readonly kind: 'aborted' };

async function waitForStatus(
	files: DiskCleanupFiles,
	options: DiskCleanupJoinOptions
): Promise<string> {
	const timeoutMilliseconds =
		options.timeoutMilliseconds ?? diskCleanupTimeoutMilliseconds;
	const timer = options.timer ?? timeoutTimer;
	const ended = new AbortController();
	const timerSignal =
		options.signal === undefined
			? ended.signal
			: AbortSignal.any([ended.signal, options.signal]);
	let result: WaitResult;

	try {
		result = await Promise.race([
			readStatus(files.status),
			waitForDeadline(timer, timeoutMilliseconds, timerSignal)
		]);
	} finally {
		ended.abort();
	}

	if (result.kind === 'status') {
		return result.text;
	}

	// The read of the pipe is still pending, and it keeps the process alive.
	await releaseReader(files.status);
	options.signal?.throwIfAborted();

	throw new DiskCleanupFailedError({
		timeoutMilliseconds,
		output: await readLog(files.log)
	});
}

async function readStatus(file: string): Promise<WaitResult> {
	return { kind: 'status', text: await readFile(file, 'utf8') };
}

// The timer rejects when the signal aborts. Report that as its own result, so
// the rejection is handled whichever promise settles first.
async function waitForDeadline(
	timer: DiskCleanupTimer,
	milliseconds: number,
	signal: AbortSignal
): Promise<WaitResult> {
	try {
		await timer(milliseconds, signal);

		return { kind: 'deadline' };
	} catch {
		return { kind: 'aborted' };
	}
}

// A write-only open without blocking succeeds while a reader is waiting to
// open the pipe, and closing it gives that reader end-of-file. When no reader
// exists, the open fails with ENXIO and the function returns.
async function releaseReader(file: string): Promise<void> {
	try {
		const writer = await open(file, constants.O_WRONLY | constants.O_NONBLOCK);

		await writer.close();
	} catch (error) {
		if (!(
			error instanceof Error &&
			'code' in error &&
			error.code === 'ENXIO'
		)) {
			throw error;
		}
	}
}

async function isPipe(file: string): Promise<boolean> {
	try {
		const stats = await lstat(file);

		return stats.isFIFO();
	} catch (error) {
		if (isFileNotFound(error)) {
			return false;
		}

		throw error;
	}
}

async function readLog(file: string): Promise<string> {
	try {
		return await readFile(file, 'utf8');
	} catch (error) {
		if (isFileNotFound(error)) {
			return '';
		}

		throw error;
	}
}
