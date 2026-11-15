import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';

import { withTemporaryDirectory } from './filesystem.ts';

interface Outcome {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

const program = path.resolve('tests/support/container-daemon-start.ts');
const activationSchema = z.object({
	pid: z.number().int().positive(),
	listenPid: z.coerce.number().int().positive(),
	listenFds: z.string()
});

// Runs the program. `daemon` is the command that replaces nix-daemon.
function startDaemon(
	socketPath: string,
	logPath: string,
	daemon: readonly string[],
	environment: NodeJS.ProcessEnv = process.env
): Promise<Outcome> {
	const child = spawn(
		process.execPath,
		[program, socketPath, logPath, ...daemon],
		{ stdio: ['ignore', 'pipe', 'pipe'], env: environment }
	);
	// A program that does not exit must not outlive the test.
	onTestFinished(() => {
		child.kill();
	});
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

// A stand-in for nix-daemon. Like nix-daemon, it serves the socket that it
// inherits as descriptor 3 (socket activation) and answers the worker protocol
// handshake with its magic number. It never creates a socket path. It writes
// the activation variables to the file that `process.argv[1]` names.
const activatedDaemon = `
	const fs = require('node:fs');
	const net = require('node:net');
	fs.writeFileSync(process.argv[1], JSON.stringify({
		pid: process.pid,
		listenPid: process.env.LISTEN_PID,
		listenFds: process.env.LISTEN_FDS
	}));
	net.createServer((connection) => {
		connection.once('data', () => {
			const reply = Buffer.alloc(16);
			reply.writeBigUInt64LE(0x6478696fn, 0);
			connection.write(reply);
		});
	}).listen({ fd: 3 });
`;

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
	it('exits with 0 once the daemon serves the socket that it inherited', async () => {
		await withTemporaryDirectory(
			'cupboard-daemon-start-',
			async (directory) => {
				const socketPath = path.join(directory, 'socket');
				const logPath = path.join(directory, 'daemon.log');
				const activationPath = path.join(directory, 'activation.json');

				const outcome = await startDaemon(
					socketPath,
					logPath,
					nodeDaemon(activatedDaemon, activationPath)
				);
				// The stand-in writes its PID to a file, so the test finds the
				// process even when the program loses the output.
				const activation = activationSchema.parse(
					JSON.parse(await readFile(activationPath, 'utf8'))
				);

				try {
					expect({
						outcome,
						activation: {
							listenPidIsDaemon: activation.listenPid === activation.pid,
							listenFds: activation.listenFds
						},
						isDaemonRunning: isRunning(activation.pid)
					}).toStrictEqual({
						outcome: { code: 0, stdout: '', stderr: '' },
						activation: { listenPidIsDaemon: true, listenFds: '1' },
						isDaemonRunning: true
					});
				} finally {
					stopProcess(activation.pid);
				}
			}
		);
	});

	it('exits with 1 when the daemon exits while a worker still holds the connection', async () => {
		await withTemporaryDirectory(
			'cupboard-daemon-start-',
			async (directory) => {
				const socketPath = path.join(directory, 'socket');
				const logPath = path.join(directory, 'daemon.log');
				const workerPath = path.join(directory, 'worker.pid');

				// Like a nix-daemon connection worker, the stand-in passes the
				// accepted connection to a process that outlives it, and exits.
				const outcome = await startDaemon(
					socketPath,
					logPath,
					nodeDaemon(
						`
						const { spawn } = require('node:child_process');
						const fs = require('node:fs');
						const net = require('node:net');
						net.createServer((connection) => {
							const worker = spawn(
								process.execPath,
								['-e', 'setInterval(() => {}, 1000)'],
								{ stdio: ['ignore', 'ignore', 'ignore', connection._handle.fd] }
							);
							fs.writeFileSync(process.argv[1], String(worker.pid));
							process.exit(3);
						}).listen({ fd: 3 });
					`,
						workerPath
					)
				);
				const worker = activationSchema.shape.pid.parse(
					Number(await readFile(workerPath, 'utf8'))
				);

				try {
					expect(outcome).toStrictEqual({
						code: 1,
						stdout: '',
						stderr: `${process.execPath} exited with code 3\n`
					});
				} finally {
					stopProcess(worker);
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
			name: 'sends something other than the Nix greeting',
			reply: "connection.write(Buffer.alloc(16, 'x'));",
			onTerminate: '',
			reason: 'did not send the Nix greeting'
		},
		{
			name: 'closes the connection',
			reply: 'connection.end();',
			onTerminate: '',
			reason: 'closed before it answered'
		},
		{
			name: 'closes the connection and exits with status 0 on SIGTERM',
			reply: 'connection.end();',
			onTerminate: "process.on('SIGTERM', () => { process.exit(0); });",
			reason: 'closed before it answered'
		}
	])(
		'exits with 3, stops the daemon and reports the log when the daemon $name',
		async ({ reply, onTerminate, reason }) => {
			await withTemporaryDirectory(
				'cupboard-daemon-start-',
				async (directory) => {
					const socketPath = path.join(directory, 'socket');
					const logPath = path.join(directory, 'daemon.log');
					const activationPath = path.join(directory, 'activation.json');

					const outcome = await startDaemon(
						socketPath,
						logPath,
						nodeDaemon(
							`
							const fs = require('node:fs');
							const net = require('node:net');
							fs.writeFileSync(process.argv[1], JSON.stringify({
								pid: process.pid,
								listenPid: process.env.LISTEN_PID,
								listenFds: process.env.LISTEN_FDS
							}));
							console.error('not allowed to connect');
							${onTerminate}
							net.createServer((connection) => {
								connection.once('data', () => {
									${reply}
								});
							}).listen({ fd: 3 });
						`,
							activationPath
						)
					);
					const activation = activationSchema.parse(
						JSON.parse(await readFile(activationPath, 'utf8'))
					);

					try {
						expect({
							outcome,
							isDaemonRunning: isRunning(activation.pid)
						}).toStrictEqual({
							outcome: {
								code: 3,
								stdout: '',
								stderr: `${socketPath} ${reason}\nnot allowed to connect\n`
							},
							isDaemonRunning: false
						});
					} finally {
						stopProcess(activation.pid);
					}
				}
			);
		}
	);

	it('exits with 2 and leaves no socket when the shell cannot start', async () => {
		await withTemporaryDirectory(
			'cupboard-daemon-start-',
			async (directory) => {
				const emptyPath = path.join(directory, 'empty');
				await mkdir(emptyPath);

				const outcome = await startDaemon(
					path.join(directory, 'socket'),
					path.join(directory, 'daemon.log'),
					[process.execPath],
					{ ...process.env, PATH: emptyPath }
				);

				const files = await readdir(directory);

				expect({
					outcome,
					files: files.toSorted((left, right) => left.localeCompare(right))
				}).toStrictEqual({
					outcome: {
						code: 2,
						stdout: '',
						stderr: 'Cannot start the daemon through sh: ENOENT\n'
					},
					files: ['daemon.log', 'empty']
				});
			}
		);
	});

	it('exits with 1 when the daemon command does not exist', async () => {
		await withTemporaryDirectory(
			'cupboard-daemon-start-',
			async (directory) => {
				const outcome = await startDaemon(
					path.join(directory, 'socket'),
					path.join(directory, 'daemon.log'),
					['cupboard-no-such-daemon']
				);

				expect({
					code: outcome.code,
					stdout: outcome.stdout,
					status: outcome.stderr.split('\n', 1)[0]
				}).toStrictEqual({
					code: 1,
					stdout: '',
					status: 'cupboard-no-such-daemon exited with code 127'
				});
			}
		);
	});

	// The error code that follows the reason depends on the platform: binding
	// in a missing directory gives ENOENT on Linux and EACCES on macOS.
	it.each([
		{
			name: 'the directory of the socket does not exist',
			reason: (directory: string) =>
				`Cannot listen on ${directory}/missing/socket: `,
			socket: 'missing/socket',
			log: 'daemon.log'
		},
		{
			name: 'the directory of the log does not exist',
			reason: (directory: string) =>
				`Cannot open ${directory}/missing/daemon.log: `,
			socket: 'socket',
			log: 'missing/daemon.log'
		}
	])('exits with 2 when $name', async ({ reason, socket, log }) => {
		await withTemporaryDirectory(
			'cupboard-daemon-start-',
			async (directory) => {
				const outcome = await startDaemon(
					path.join(directory, socket),
					path.join(directory, log),
					[process.execPath]
				);
				const expected = reason(directory);

				expect({
					code: outcome.code,
					stdout: outcome.stdout,
					reason: outcome.stderr.slice(0, expected.length)
				}).toStrictEqual({ code: 2, stdout: '', reason: expected });
			}
		);
	});

	// The existence check follows a symbolic link, so a dangling link passes it
	// and the program fails only when it links the socket to the path. Another
	// start can create the path after the check, so the program must leave an
	// entry that it did not create.
	it('exits with 2 and keeps the entry when it fails after the socket is listening', async () => {
		await withTemporaryDirectory(
			'cupboard-daemon-start-',
			async (directory) => {
				const socketPath = path.join(directory, 'socket');
				await symlink(path.join(directory, 'missing'), socketPath);

				const outcome = await startDaemon(
					socketPath,
					path.join(directory, 'daemon.log'),
					[process.execPath]
				);
				const entries = await readdir(directory);

				expect({
					code: outcome.code,
					stdout: outcome.stdout,
					entries: entries.toSorted((a, b) => a.localeCompare(b))
				}).toStrictEqual({
					code: 2,
					stdout: '',
					entries: ['daemon.log', 'socket']
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

	// Another start can be using the staging path, so a start that cannot
	// listen there must leave the entry in place.
	it('exits with 2 and keeps an entry that already exists at the staging path', async () => {
		await withTemporaryDirectory(
			'cupboard-daemon-start-',
			async (directory) => {
				const socketPath = path.join(directory, 'socket');
				await writeFile(`${socketPath}.activation`, '');

				const outcome = await startDaemon(
					socketPath,
					path.join(directory, 'daemon.log'),
					[process.execPath]
				);

				const entries = await readdir(directory);

				expect({
					outcome,
					entries: entries.toSorted((a, b) => a.localeCompare(b))
				}).toStrictEqual({
					outcome: {
						code: 2,
						stdout: '',
						stderr: `Cannot listen on ${socketPath}: EADDRINUSE\n`
					},
					entries: ['daemon.log', 'socket.activation']
				});
			}
		);
	});
});
