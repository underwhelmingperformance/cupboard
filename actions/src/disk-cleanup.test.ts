import { execFile } from 'node:child_process';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
	type DiskCleanupFiles,
	diskCleanupFiles,
	joinDiskCleanup
} from './disk-cleanup.ts';
import { DiskCleanupFailedError } from './errors.ts';

type DiskCleanupReporter = Parameters<typeof joinDiskCleanup>[1];

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const log = 'df output\n';
const phaseLabel = 'Waiting for disk space to be freed';

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	);
});

async function startedCleanup(): Promise<DiskCleanupFiles> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-clean-'));
	const files = {
		status: path.join(directory, 'status.fifo'),
		log: path.join(directory, 'output.log')
	};

	directories.push(directory);
	await execFileAsync('mkfifo', [files.status]);
	await writeFile(files.log, log);

	return files;
}

function recordingReporter(): DiskCleanupReporter & {
	readonly calls: { readonly info: string[]; readonly phases: string[] };
} {
	const calls = { info: [] as string[], phases: [] as string[] };

	return {
		calls,
		info: (message) => {
			calls.info.push(message);
		},
		phase: (label, body) => {
			calls.phases.push(label);

			return body();
		}
	};
}

async function outcomeOf(joined: Promise<void>): Promise<unknown> {
	try {
		await joined;

		return 'joined';
	} catch (error) {
		return error instanceof DiskCleanupFailedError
			? {
					status: error.status,
					timeoutMilliseconds: error.timeoutMilliseconds,
					output: error.output
				}
			: error;
	}
}

// A test that opens the pipe for reading and writing lets the join's read
// start at any time, and ends that read when the test closes the pipe.
async function holdPipe(file: string) {
	return open(file, 'r+');
}

describe('joinDiskCleanup', () => {
	it.each([
		{
			name: 'succeeds',
			reported: '0\n',
			outcome: 'joined',
			info: [`The background disk cleanup finished:\n${log}`]
		},
		{
			name: 'exits with a status',
			reported: '3\n',
			outcome: { status: 3, timeoutMilliseconds: undefined, output: log },
			info: []
		},
		{
			name: 'reports no status',
			reported: '',
			outcome: {
				status: undefined,
				timeoutMilliseconds: undefined,
				output: log
			},
			info: []
		},
		{
			name: 'reports text instead of a status',
			reported: 'done\n',
			outcome: {
				status: undefined,
				timeoutMilliseconds: undefined,
				output: log
			},
			info: []
		}
	])(
		'returns when the cleanup $name, after it writes its status',
		async ({ reported, outcome, info }) => {
			const files = await startedCleanup();
			const reporter = recordingReporter();

			const joined = outcomeOf(joinDiskCleanup(files, reporter));

			// Opening the pipe for writing completes when the join reads it.
			await writeFile(files.status, reported);

			expect({ outcome: await joined, calls: reporter.calls }).toStrictEqual({
				outcome,
				calls: { info, phases: [phaseLabel] }
			});
		}
	);

	it('fails with the output so far when the deadline passes first', async () => {
		const files = await startedCleanup();
		const reporter = recordingReporter();
		const holder = await holdPipe(files.status);
		const deadline = Promise.withResolvers<undefined>();
		const timers: number[] = [];

		const joined = outcomeOf(
			joinDiskCleanup(files, reporter, {
				timeoutMilliseconds: 5000,
				timer: (milliseconds) => {
					timers.push(milliseconds);

					return deadline.promise;
				}
			})
		);

		deadline.resolve(undefined);

		expect({
			outcome: await joined,
			timers,
			calls: reporter.calls
		}).toStrictEqual({
			outcome: {
				status: undefined,
				timeoutMilliseconds: 5000,
				output: log
			},
			timers: [5000],
			calls: { info: [], phases: [phaseLabel] }
		});

		await holder.close();
	});

	it('ends the wait with the reason of an aborted signal', async () => {
		const files = await startedCleanup();
		const holder = await holdPipe(files.status);
		const controller = new AbortController();
		const reason = new Error('the job was cancelled');
		const timerStarted = Promise.withResolvers<undefined>();

		const joined = outcomeOf(
			joinDiskCleanup(files, recordingReporter(), {
				signal: controller.signal,
				timer: (_milliseconds, signal) =>
					new Promise((_resolve, reject) => {
						signal.addEventListener('abort', () => {
							reject(new Error('the timer was cancelled'));
						});
						timerStarted.resolve(undefined);
					})
			})
		);

		await timerStarted.promise;
		controller.abort(reason);

		expect(await joined).toBe(reason);

		await holder.close();
	});

	it('returns at once when no pipe exists at the status path', async () => {
		const files = await startedCleanup();
		const reporter = recordingReporter();

		await rm(files.status);
		await joinDiskCleanup(files, reporter);

		expect(reporter.calls).toStrictEqual({ info: [], phases: [] });
	});

	it('returns at once when an earlier call already joined the cleanup', async () => {
		const files = await startedCleanup();
		const reporter = recordingReporter();

		const first = joinDiskCleanup(files, reporter);
		await writeFile(files.status, '0\n');
		await first;
		await joinDiskCleanup(files, reporter);

		expect(reporter.calls).toStrictEqual({
			info: [`The background disk cleanup finished:\n${log}`],
			phases: [phaseLabel]
		});
	});
});

// The join reads the pipe while no process has it open for writing. The read
// keeps a process alive until the join releases it, so these tests run the
// join in a child process and wait for the child to exit.
describe('joinDiskCleanup in a process', () => {
	const modulePath = fileURLToPath(new URL('disk-cleanup.ts', import.meta.url));
	const childSource = `
import { joinDiskCleanup } from ${JSON.stringify(modulePath)};

const [status, log, mode] = process.argv.slice(2);
const reporter = { info: () => undefined, phase: (_label, body) => body() };
const options =
	mode === 'deadline'
		? { timeoutMilliseconds: 200 }
		: { signal: AbortSignal.timeout(200) };

try {
	await joinDiskCleanup({ status, log }, reporter, options);
} catch (error) {
	console.log(error instanceof Error ? error.name : 'unknown');
}
`;

	it.each([
		{ mode: 'deadline', failure: 'DiskCleanupFailedError' },
		{ mode: 'abort', failure: 'TimeoutError' }
	])(
		'exits after the $mode, with no writer on the pipe',
		async ({ mode, failure }) => {
			const files = await startedCleanup();
			const script = path.join(path.dirname(files.status), 'join.ts');

			await writeFile(script, childSource);

			const { stdout } = await execFileAsync(process.execPath, [
				'--experimental-transform-types',
				'--disable-warning=ExperimentalWarning',
				script,
				files.status,
				files.log,
				mode
			]);

			expect(stdout).toBe(`${failure}\n`);
		}
	);
});

describe('diskCleanupFiles', () => {
	it.each([
		{ environment: {}, files: undefined },
		{
			environment: { CUPBOARD_DISK_CLEANUP_STATUS: '' },
			files: undefined
		},
		{
			environment: {
				CUPBOARD_DISK_CLEANUP_STATUS: '/runner/status',
				CUPBOARD_DISK_CLEANUP_LOG: '/runner/log'
			},
			files: { status: '/runner/status', log: '/runner/log' }
		}
	])('reads the files from $environment', ({ environment, files }) => {
		expect(diskCleanupFiles(environment)).toStrictEqual(files);
	});
});
