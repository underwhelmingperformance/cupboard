/**
Starts a daemon and waits until it creates its socket. Run it with Node
where the daemon will run, for example inside a fixture container:

    node container-daemon-start.cjs <socket> <log> <command> [argument...]

The program starts `command` in the background with its output appended
to `log`, and it leaves the daemon running when it exits. It exits with 0
once `socket` exists. It exits with 1 if the daemon exits first, and
writes the exit status and the contents of `log` to standard error. The
program can see the exit before it sees the socket, even when the daemon
created the socket and then failed, so the message does not say whether
the socket exists. It exits with 2 if it cannot start the daemon, and
writes the reason to standard error. Examples are that the directory of
`socket` does not exist, that a file already exists at `socket`, that
`log` cannot be opened and that `command` cannot be started. It also
exits with 2 when an argument is missing.

The program does not poll. The kernel reports the creation of the socket
through `fs.watch`, and Node reports the exit of the daemon.
*/
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, watch } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

type DaemonStart =
	| { readonly kind: 'listening' }
	| { readonly kind: 'exited'; readonly status: string };

const daemonExited = 1;
const startFailed = 2;

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

async function startDaemon(
	socketPath: string,
	logPath: string,
	command: string,
	arguments_: readonly string[]
): Promise<DaemonStart> {
	const outcome = Promise.withResolvers<DaemonStart>();
	// The watch exists before the daemon starts, so the daemon cannot create
	// the socket without producing an event.
	const watcher = attempt(`Cannot watch ${path.dirname(socketPath)}`, () =>
		watch(path.dirname(socketPath), () => {
			if (existsSync(socketPath)) {
				outcome.resolve({ kind: 'listening' });
			}
		})
	);

	try {
		if (existsSync(socketPath)) {
			throw new StartFailure(`${socketPath} already exists`);
		}

		const log = attempt(`Cannot open ${logPath}`, () => openSync(logPath, 'a'));
		let child: ChildProcess;

		try {
			child = attempt(`Cannot start ${command}`, () =>
				spawn(command, arguments_, {
					detached: true,
					stdio: ['ignore', log, log]
				})
			);
		} finally {
			closeSync(log);
		}

		child.once('error', (error) => {
			outcome.reject(
				new StartFailure(`Cannot start ${command}: ${failureCode(error)}`, {
					cause: error
				})
			);
		});
		child.once('exit', (code, signal) => {
			outcome.resolve({
				kind: 'exited',
				status:
					code === null
						? `was stopped by ${String(signal)}`
						: `exited with code ${String(code)}`
			});
		});

		const result = await outcome.promise;

		if (result.kind === 'listening') {
			child.unref();
		}

		return result;
	} finally {
		watcher.close();
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

	let start: DaemonStart;

	try {
		start = await startDaemon(socketPath, logPath, command, arguments_);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = startFailed;
		return;
	}

	if (start.kind === 'listening') {
		return;
	}

	process.stderr.write(
		`${command} ${start.status}\n` + readFileSync(logPath, 'utf8')
	);
	process.exitCode = daemonExited;
}

void main();
