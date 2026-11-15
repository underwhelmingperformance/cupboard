/**
Starts a daemon on a socket that this program creates, and waits until the
daemon serves it. Run it with Node where the daemon will run, for example
inside a fixture container:

    node container-daemon-start.cjs <socket> <log> <command> [argument...]

The program creates a listening Unix socket and starts `command` in the
background with the socket as file descriptor 3, `LISTEN_FDS=1` and
`LISTEN_PID` set to the daemon's process ID. This is systemd socket
activation, which nix-daemon supports. The daemon serves the socket that it
inherits and creates none, so the program waits for no file to appear. Its
output is appended to `log`, and the daemon keeps running when the program
exits.

Once the socket is listening, a connection to it succeeds even before the
daemon accepts. The program therefore connects and sends the Nix worker
protocol greeting, and treats the daemon's reply as the sign that it serves
the socket. It exits with 0 on that reply. It exits with 1 if the daemon
exits first, and writes the exit status and the contents of `log` to standard
error. A `command` that does not exist is such an exit, with status 127. It
exits with 3 if the daemon keeps running but does not answer the greeting, for
example because it closes the connection. It stops the daemon, and writes the
reason and the contents of `log` to standard error. It exits with 2 if it
cannot start the daemon, and writes the reason to standard error. Examples
are that the directory of `socket` does not exist, that a file already exists
at `socket`, that `log` cannot be opened and that `sh` cannot be started. It
also exits with 2 when an argument is missing. After every failure, no file
that the program created remains at `socket`.

The program does not poll and has no time limit. The kernel delivers the
connection and the reply, and Node reports the exit of the daemon.
*/
import { type ChildProcess, spawn } from 'node:child_process';
import {
	closeSync,
	existsSync,
	linkSync,
	openSync,
	readFileSync,
	rmSync
} from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import process from 'node:process';

type DaemonStart =
	| { readonly kind: 'serving' }
	| { readonly kind: 'exited'; readonly status: string }
	| { readonly kind: 'unresponsive'; readonly reason: string }
	| { readonly kind: 'not-started'; readonly reason: string };

type StartedDaemon = Exclude<DaemonStart, { readonly kind: 'not-started' }>;

const daemonExited = 1;
const startFailed = 2;
const daemonUnresponsive = 3;
const workerMagicRequest = 0x6e_69_78_63n;
const workerMagicReply = 0x64_78_69_6fn;
const magicBytes = 8;

class StartFailure extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'StartFailure';
	}
}

function failureCode(error: unknown): string {
	return String(error instanceof Error && 'code' in error ? error.code : error);
}

// Runs `action`, and reports what it was doing if it throws.
function attempt<T>(description: string, action: () => T): T {
	try {
		return action();
	} catch (error) {
		throw new StartFailure(`${description}: ${failureCode(error)}`, {
			cause: error
		});
	}
}

// Listens on `stagingPath` and reports a failure for `socketPath`.
function listen(
	server: Server,
	stagingPath: string,
	socketPath: string
): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', (error) => {
			reject(
				new StartFailure(
					`Cannot listen on ${socketPath}: ${failureCode(error)}`,
					{ cause: error }
				)
			);
		});
		server.listen(
			{ path: stagingPath, readableAll: true, writableAll: true },
			resolve
		);
	});
}

// The descriptor number of a listening server. Node has no public accessor
// for it, and `spawn` can pass a descriptor to the child only by number.
function descriptorOf(server: Server): number {
	const handle: unknown = Reflect.get(server, '_handle');
	const descriptor: unknown =
		typeof handle === 'object' && handle !== null
			? Reflect.get(handle, 'fd')
			: undefined;

	if (typeof descriptor !== 'number') {
		throw new StartFailure(
			'Cannot read the descriptor of the listening socket'
		);
	}

	return descriptor;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => {
			resolve();
		});
	});
}

// Resolves when the daemon answers the worker protocol greeting on
// `socketPath`. It rejects when the connection fails or closes first.
// Aborting `signal` destroys the connection, which a worker of a daemon that
// exited could otherwise keep open.
function greetDaemon(socketPath: string, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const client = connect({ path: socketPath, signal });
		let reply = Buffer.alloc(0);

		client.once('connect', () => {
			const request = Buffer.alloc(magicBytes);
			request.writeBigUInt64LE(workerMagicRequest);
			client.write(request);
		});
		client.on('data', (chunk: Buffer) => {
			reply = Buffer.concat([reply, chunk]);

			if (reply.length < magicBytes) {
				return;
			}

			client.destroy();

			if (reply.readBigUInt64LE(0) === workerMagicReply) {
				resolve();
				return;
			}

			reject(new StartFailure(`${socketPath} did not send the Nix greeting`));
		});
		client.once('close', () => {
			reject(new StartFailure(`${socketPath} closed before it answered`));
		});
		client.once('error', (error) => {
			reject(
				new StartFailure(
					`Cannot connect to ${socketPath}: ${failureCode(error)}`,
					{ cause: error }
				)
			);
		});
	});
}

// The shell sets LISTEN_PID to its own process ID, which the daemon keeps
// because `exec` replaces the shell.
function spawnDaemon(
	command: string,
	arguments_: readonly string[],
	log: number,
	descriptor: number
): ChildProcess {
	return spawn(
		'sh',
		[
			'-c',
			'export LISTEN_PID=$$ LISTEN_FDS=1; exec "$@"',
			'sh',
			command,
			...arguments_
		],
		{ detached: true, stdio: ['ignore', log, log, descriptor] }
	);
}

async function startDaemon(
	socketPath: string,
	logPath: string,
	command: string,
	arguments_: readonly string[]
): Promise<StartedDaemon> {
	if (existsSync(socketPath)) {
		throw new StartFailure(`${socketPath} already exists`);
	}

	const log = attempt(`Cannot open ${logPath}`, () => openSync(logPath, 'a'));
	const server = createServer();
	const stagingPath = `${socketPath}.activation`;
	let hasLinked = false;

	try {
		await listen(server, stagingPath, socketPath);
		// Closing the server removes its path. The socket stays reachable
		// through this second name, which the program connects to below.
		linkSync(stagingPath, socketPath);
		hasLinked = true;

		const child = spawnDaemon(command, arguments_, log, descriptorOf(server));
		const outcome = Promise.withResolvers<DaemonStart>();
		let greetingFailure: Error | undefined;

		// The greeting ends when the outcome is decided, whichever way.
		const greeting = new AbortController();
		void outcome.promise.finally(() => {
			greeting.abort();
		});

		// Node emits a failed spawn on the next tick, so these listeners must
		// exist before the first await.
		child.once('error', (error) => {
			outcome.resolve({
				kind: 'not-started',
				reason: `Cannot start the daemon through sh: ${failureCode(error)}`
			});
		});
		child.once('exit', (code, signal) => {
			// The program stops the daemon only after a greeting failure. A
			// daemon that exits by itself can fail the greeting too, and the
			// program may see that failure before the exit, so only a stop by
			// SIGTERM or a clean exit counts as the result of the stop.
			if (
				greetingFailure !== undefined &&
				(signal === 'SIGTERM' || code === 0)
			) {
				outcome.resolve({
					kind: 'unresponsive',
					reason: greetingFailure.message
				});
				return;
			}

			outcome.resolve({
				kind: 'exited',
				status:
					code === null
						? `was stopped by ${String(signal)}`
						: `exited with code ${String(code)}`
			});
		});
		await closeServer(server);
		void (async () => {
			try {
				await greetDaemon(socketPath, greeting.signal);
				outcome.resolve({ kind: 'serving' });
			} catch (error) {
				if (greeting.signal.aborted) {
					return;
				}

				// A daemon that exited cannot answer, and its exit decides the
				// outcome. A daemon that still runs is stopped, and its exit
				// reports this failure.
				greetingFailure =
					error instanceof Error ? error : new Error(String(error));
				child.kill();
			}
		})();

		const result = await outcome.promise;

		if (result.kind === 'not-started') {
			throw new StartFailure(result.reason);
		}

		if (result.kind === 'serving') {
			child.unref();
		} else {
			rmSync(socketPath, { force: true });
		}

		return result;
	} catch (error) {
		// A failure after `listen` leaves the server open, and an open server
		// keeps the program running.
		await closeServer(server);

		// Another start can create `socketPath` after the existence check.
		if (hasLinked) {
			rmSync(socketPath, { force: true });
		}

		throw error;
	} finally {
		closeSync(log);
	}
}

async function main(): Promise<void> {
	const [socketPath, logPath, command, ...arguments_] = process.argv.slice(2);

	if (
		socketPath === undefined ||
		logPath === undefined ||
		command === undefined
	) {
		process.stderr.write(
			'Usage: container-daemon-start <socket> <log> <command> [argument...]\n'
		);
		process.exitCode = startFailed;
		return;
	}

	let start: StartedDaemon;

	try {
		start = await startDaemon(socketPath, logPath, command, arguments_);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = startFailed;
		return;
	}

	if (start.kind === 'serving') {
		return;
	}

	if (start.kind === 'unresponsive') {
		process.stderr.write(`${start.reason}\n` + readFileSync(logPath, 'utf8'));
		process.exitCode = daemonUnresponsive;
		return;
	}

	process.stderr.write(
		`${command} ${start.status}\n` + readFileSync(logPath, 'utf8')
	);
	process.exitCode = daemonExited;
}

void main();
