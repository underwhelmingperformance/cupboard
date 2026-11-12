import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { withTemporaryDirectory } from './filesystem.ts';

interface Outcome {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

const program = path.resolve('tests/support/container-daemon-start.ts');
const daemonPidSchema = z.coerce.number().int().positive();

// Runs the program. `daemon` is the command that replaces nix-daemon.
function startDaemon(
	socketPath: string,
	logPath: string,
	daemon: readonly string[]
): Promise<Outcome> {
	const child = spawn(
		process.execPath,
		[program, socketPath, logPath, ...daemon],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	let stdout = '';
	let stderr = '';

	child.stdout.on('data', (chunk: Buffer) => {
		stdout += chunk.toString('utf8');
	});
	child.stderr.on('data', (chunk: Buffer) => {
		stderr += chunk.toString('utf8');
	});

	return new Promise((resolve) => {
		child.once('close', (code) => {
			resolve({ code, stdout, stderr });
		});
	});
}

// A daemon command that runs `script` with Node. The script receives
// `arguments_` as `process.argv[1]` onwards.
function nodeDaemon(
	script: string,
	...arguments_: readonly string[]
): readonly string[] {
	return [process.execPath, '-e', script, ...arguments_];
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);

		return true;
	} catch {
		return false;
	}
}

// The stand-in may already have exited when the test fails, so a missing
// process must not replace the failure of the assertion.
function stopProcess(pid: number): void {
	try {
		process.kill(pid);
	} catch (error) {
		if (!(
			error instanceof Error &&
			'code' in error &&
			error.code === 'ESRCH'
		)) {
			throw error;
		}
	}
}

describe('container-daemon-start', () => {
	it('exits with 0 and leaves the daemon running when it listens', async () => {
		await withTemporaryDirectory(
			'cupboard-daemon-start-',
			async (directory) => {
				const socketPath = path.join(directory, 'socket');
				const logPath = path.join(directory, 'daemon.log');
				const pidPath = path.join(directory, 'daemon.pid');

				const outcome = await startDaemon(
					socketPath,
					logPath,
					nodeDaemon(
						`
						require('node:fs').writeFileSync(process.argv[2], String(process.pid));
						require('node:net').createServer().listen(process.argv[1]);
					`,
						socketPath,
						pidPath
					)
				);
				// The stand-in writes its PID to a file, not to its output, so the
				// test finds the process even when the program loses the output. An
				// invalid PID fails here, before anything is signalled.
				const daemonPid = daemonPidSchema.parse(
					await readFile(pidPath, 'utf8')
				);

				try {
					expect({
						outcome,
						isDaemonRunning: isRunning(daemonPid)
					}).toStrictEqual({
						outcome: { code: 0, stdout: '', stderr: '' },
						isDaemonRunning: true
					});
				} finally {
					stopProcess(daemonPid);
				}
			}
		);
	});

	it('exits with 1 and reports the log when the daemon exits first', async () => {
		await withTemporaryDirectory(
			'cupboard-daemon-start-',
			async (directory) => {
				const socketPath = path.join(directory, 'socket');
				const logPath = path.join(directory, 'daemon.log');

				const outcome = await startDaemon(
					socketPath,
					logPath,
					nodeDaemon(
						`
					console.error('unknown setting');
					process.exit(3);
				`,
						socketPath
					)
				);

				expect(outcome).toStrictEqual({
					code: 1,
					stdout: '',
					stderr: `${process.execPath} exited with code 3\nunknown setting\n`
				});
			}
		);
	});

	it.each([
		{
			name: 'the directory of the socket does not exist',
			failure: (directory: string) =>
				`Cannot watch ${directory}/missing: ENOENT`,
			socket: 'missing/socket',
			log: 'daemon.log',
			command: 'node'
		},
		{
			name: 'the directory of the log does not exist',
			failure: (directory: string) =>
				`Cannot open ${directory}/missing/daemon.log: ENOENT`,
			socket: 'socket',
			log: 'missing/daemon.log',
			command: 'node'
		},
		{
			name: 'the daemon command does not exist',
			failure: () => 'Cannot start cupboard-no-such-daemon: ENOENT',
			socket: 'socket',
			log: 'daemon.log',
			command: 'cupboard-no-such-daemon'
		}
	])('exits with 2 when $name', async ({ failure, socket, log, command }) => {
		await withTemporaryDirectory(
			'cupboard-daemon-start-',
			async (directory) => {
				const outcome = await startDaemon(
					path.join(directory, socket),
					path.join(directory, log),
					[command]
				);

				expect(outcome).toStrictEqual({
					code: 2,
					stdout: '',
					stderr: `${failure(directory)}\n`
				});
			}
		);
	});

	it('exits with 2 when a file already exists at the socket path', async () => {
		await withTemporaryDirectory(
			'cupboard-daemon-start-',
			async (directory) => {
				const socketPath = path.join(directory, 'socket');
				await writeFile(socketPath, '');

				const outcome = await startDaemon(
					socketPath,
					path.join(directory, 'daemon.log'),
					[process.execPath]
				);

				expect(outcome).toStrictEqual({
					code: 2,
					stdout: '',
					stderr: `${socketPath} already exists\n`
				});
			}
		);
	});
});
