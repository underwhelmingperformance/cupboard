import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NixDaemonStoreClient } from '../packages/nix/src/nix-daemon.ts';
import type { NixDaemonTrust } from '../packages/nix/src/nix-store.ts';
import { waitForDaemonSocket } from '../tests/support/nix.ts';

const daemonSocketPath = '/nix/var/nix/daemon-socket/socket';

export interface CiEndToEndDaemon {
	readonly trust: (signal: AbortSignal) => Promise<NixDaemonTrust>;
	readonly stop: () => Promise<void>;
	readonly diagnostics: () => string;
}

export interface CiEndToEndDependencies {
	readonly platform: NodeJS.Platform;
	readonly userId: number;
	readonly userName: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly socketExists: () => boolean;
	readonly assertTools: (signal: AbortSignal) => Promise<void>;
	readonly startDaemon: (
		environment: NodeJS.ProcessEnv,
		signal: AbortSignal
	) => Promise<CiEndToEndDaemon>;
	readonly runTests: (
		command: readonly string[],
		environment: NodeJS.ProcessEnv,
		signal: AbortSignal
	) => Promise<number>;
	readonly reportFailure: (diagnostics: string) => void;
}

type DaemonSocketWait = (
	child: ChildProcess,
	socketPath: string,
	diagnostics: () => string,
	signal: AbortSignal
) => Promise<void>;

export class CiEndToEndPrerequisiteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CiEndToEndPrerequisiteError';
	}
}

export class OwnedNixDaemonSocket {
	static capture(socketPath: string): OwnedNixDaemonSocket | undefined {
		try {
			const info = lstatSync(socketPath, { bigint: true });

			if (!info.isSocket()) {
				return undefined;
			}

			return new OwnedNixDaemonSocket(socketPath, info.dev, info.ino);
		} catch (error) {
			if (
				error instanceof Error &&
				'code' in error &&
				error.code === 'ENOENT'
			) {
				return undefined;
			}

			throw error;
		}
	}

	private constructor(
		private readonly socketPath: string,
		private readonly device: bigint,
		private readonly inode: bigint
	) {}

	async remove(): Promise<void> {
		const current = OwnedNixDaemonSocket.capture(this.socketPath);

		if (current?.device !== this.device || current.inode !== this.inode) {
			return;
		}

		try {
			await unlink(this.socketPath);
		} catch (error) {
			if (
				error instanceof Error &&
				'code' in error &&
				error.code === 'ENOENT'
			) {
				return;
			}

			throw error;
		}
	}
}

export async function runCiEndToEnd(
	command: readonly string[],
	signal: AbortSignal,
	dependencies: CiEndToEndDependencies = systemDependencies()
): Promise<number> {
	if (
		dependencies.platform !== 'linux' ||
		dependencies.environment.CI === undefined
	) {
		throw new CiEndToEndPrerequisiteError(
			'The CI end-to-end runner requires Linux and CI=true'
		);
	}

	if (dependencies.userId === 0) {
		throw new CiEndToEndPrerequisiteError(
			'The CI end-to-end runner must use a non-root account'
		);
	}

	if (dependencies.socketExists()) {
		throw new CiEndToEndPrerequisiteError(
			`Another Nix daemon already uses ${daemonSocketPath}`
		);
	}

	if (command.length === 0) {
		throw new CiEndToEndPrerequisiteError(
			'The CI end-to-end runner requires a test command'
		);
	}

	signal.throwIfAborted();
	await dependencies.assertTools(signal);
	signal.throwIfAborted();
	const environment = {
		...dependencies.environment,
		NIX_CONFIG: `${dependencies.environment.NIX_CONFIG ?? ''}\ntrusted-users = ${dependencies.userName}\nbuild-users-group =\nsandbox = false\n`,
		NIX_DAEMON_SOCKET_PATH: daemonSocketPath,
		NIX_REMOTE: 'daemon'
	};
	const daemon = await dependencies.startDaemon(environment, signal);

	try {
		signal.throwIfAborted();

		if ((await daemon.trust(signal)) !== 'trusted') {
			throw new CiEndToEndPrerequisiteError(
				'The CI Nix daemon must trust its test client'
			);
		}

		signal.throwIfAborted();
		const code = await dependencies.runTests(command, environment, signal);

		if (code !== 0) {
			dependencies.reportFailure(daemon.diagnostics());
		}

		return code;
	} catch (error) {
		dependencies.reportFailure(daemon.diagnostics());
		throw error;
	} finally {
		await daemon.stop();
	}
}

export class RunningCiNixDaemon implements CiEndToEndDaemon {
	static async start(
		environment: NodeJS.ProcessEnv,
		signal: AbortSignal
	): Promise<RunningCiNixDaemon> {
		await mkdir(path.dirname(daemonSocketPath), { recursive: true });
		const child = spawn('nix-daemon', ['--store', 'local'], {
			env: environment,
			stdio: ['ignore', 'ignore', 'pipe'],
			detached: true
		});
		const daemon = this.observe(child, daemonSocketPath);
		await daemon.waitUntilReady(signal);
		return daemon;
	}

	static observe(
		child: ChildProcess,
		socketPath: string,
		waitForSocket: DaemonSocketWait = waitForDaemonSocket
	): RunningCiNixDaemon {
		return new RunningCiNixDaemon(child, socketPath, waitForSocket);
	}

	readonly #stderr: Buffer[] = [];
	readonly #closed: Promise<void>;
	#socket: OwnedNixDaemonSocket | undefined;
	#stopping: Promise<void> | undefined;
	#hasEscalated = false;
	#processError: Error | undefined;
	readonly diagnostics = (): string => {
		const stderr = Buffer.concat(this.#stderr).toString('utf8');
		return stderr === '' ? (this.#processError?.message ?? '') : stderr;
	};

	private constructor(
		private readonly child: ChildProcess,
		private readonly socketPath: string,
		private readonly waitForSocket: DaemonSocketWait
	) {
		const onError = (error: Error): void => {
			this.#processError = error;
		};
		child.on('error', onError);
		child.stderr?.on('data', (chunk: Buffer) => {
			this.#stderr.push(chunk);
		});
		this.#closed = new Promise((resolve) => {
			child.once('close', () => {
				child.removeListener('error', onError);
				resolve();
			});
		});
	}

	private rememberSocket(): void {
		this.#socket ??= OwnedNixDaemonSocket.capture(this.socketPath);
	}

	private async stopProcess(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) {
			terminateProcessGroup(this.child, 'SIGKILL');
			await this.#closed;
			return;
		}

		terminateProcessGroup(this.child, 'SIGTERM');
		const escalationFailure = Promise.withResolvers<never>();
		const deadline = setTimeout(() => {
			try {
				terminateProcessGroup(this.child, 'SIGKILL');
				this.#hasEscalated = true;
			} catch (error) {
				escalationFailure.reject(error);
			}
		}, 5000);
		deadline.unref();

		try {
			await Promise.race([this.#closed, escalationFailure.promise]);

			if (!this.#hasEscalated) {
				terminateProcessGroup(this.child, 'SIGKILL');
			}
		} finally {
			clearTimeout(deadline);
		}
	}

	private async stopAndRemoveSocket(): Promise<void> {
		try {
			await this.stopProcess();
		} finally {
			await this.#socket?.remove();
		}
	}
	async trust(signal: AbortSignal): Promise<NixDaemonTrust> {
		return new NixDaemonStoreClient({
			socketPath: this.socketPath,
			signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
		}).daemonTrust();
	}

	async waitUntilReady(signal: AbortSignal): Promise<void> {
		const startupSignal = AbortSignal.any([
			signal,
			AbortSignal.timeout(10_000)
		]);
		let startupFailure: unknown;
		const onAbort = (): void => {
			try {
				this.rememberSocket();
			} catch (error) {
				startupFailure = error;
			}
			void this.stop().catch((error: unknown) => {
				startupFailure = error;
			});
		};
		startupSignal.addEventListener('abort', onAbort, { once: true });

		if (startupSignal.aborted) {
			onAbort();
		}

		try {
			await this.waitForSocket(
				this.child,
				this.socketPath,
				this.diagnostics,
				startupSignal
			);
			this.rememberSocket();
			startupSignal.throwIfAborted();

			if (this.#socket === undefined) {
				throw new CiEndToEndPrerequisiteError(
					'The Nix daemon readiness path is not a Unix socket'
				);
			}
		} catch (error) {
			try {
				this.rememberSocket();
			} finally {
				await this.stop();
			}
			await this.#socket?.remove();
			startupSignal.throwIfAborted();
			throw startupFailure ?? error;
		} finally {
			startupSignal.removeEventListener('abort', onAbort);
		}
	}

	stop(): Promise<void> {
		this.#stopping ??= this.stopAndRemoveSocket();
		return this.#stopping;
	}
}

function systemDependencies(): CiEndToEndDependencies {
	return {
		platform: process.platform,
		userId: process.getuid?.() ?? 0,
		userName: userInfo().username,
		environment: process.env,
		socketExists: () => existsSync(daemonSocketPath),
		async assertTools(signal) {
			for (const command of [
				['nix', '--version'],
				['nix-daemon', '--version'],
				['cc', '--version'],
				['docker', 'info', '--format', '{{json .ServerVersion}}']
			]) {
				const code = await runTestCommand(
					command,
					process.env,
					AbortSignal.any([signal, AbortSignal.timeout(30_000)])
				);

				if (code !== 0) {
					throw new CiEndToEndPrerequisiteError(
						`End-to-end prerequisite failed: ${command.join(' ')}`
					);
				}
			}
		},
		startDaemon: (environment, signal) =>
			RunningCiNixDaemon.start(environment, signal),
		runTests: runTestCommand,
		reportFailure: (diagnostics) => {
			if (diagnostics !== '') {
				console.error(`Nix daemon diagnostics:\n${diagnostics}`);
			}
		}
	};
}

export async function runTestCommand(
	command: readonly string[],
	environment: NodeJS.ProcessEnv,
	signal: AbortSignal
): Promise<number> {
	signal.throwIfAborted();
	const [executable, ...arguments_] = command;

	if (executable === undefined) {
		throw new CiEndToEndPrerequisiteError(
			'The CI end-to-end runner requires a test command'
		);
	}

	const child = spawn(executable, arguments_, {
		env: environment,
		stdio: 'inherit',
		detached: true
	});

	return new Promise((resolve, reject) => {
		let failure: unknown;
		let deadline: NodeJS.Timeout | undefined;
		const terminate = (terminationSignal: NodeJS.Signals): void => {
			try {
				terminateProcessGroup(child, terminationSignal);
			} catch (error) {
				failure = error;
			}
		};
		const onAbort = (): void => {
			terminate('SIGTERM');
			deadline = setTimeout(() => {
				terminate('SIGKILL');
			}, 5000);
			deadline.unref();
		};
		child.once('error', (error) => {
			failure = error;
		});
		child.once('close', (code) => {
			signal.removeEventListener('abort', onAbort);
			clearTimeout(deadline);

			terminate('SIGKILL');

			if (failure !== undefined) {
				reject(
					failure instanceof Error
						? failure
						: new Error('Could not stop the test command', { cause: failure })
				);
				return;
			}

			if (signal.aborted) {
				reject(
					signal.reason instanceof Error
						? signal.reason
						: new Error('The test command was cancelled', {
								cause: signal.reason
							})
				);
				return;
			}

			resolve(code ?? 1);
		});
		signal.addEventListener('abort', onAbort, { once: true });

		if (signal.aborted) {
			onAbort();
		}
	});
}

function terminateProcessGroup(
	child: ChildProcess,
	signal: NodeJS.Signals
): void {
	if (child.pid === undefined) {
		return;
	}

	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
			return;
		}

		throw error;
	}
}

async function main(): Promise<void> {
	const controller = new AbortController();
	const onInterrupt = (): void => {
		controller.abort(new Error('CI end-to-end execution was interrupted'));
	};
	process.once('SIGINT', onInterrupt);
	process.once('SIGTERM', onInterrupt);

	try {
		const command = process.argv.slice(2);
		process.exitCode = await runCiEndToEnd(
			command.length === 0 ? ['pnpm', 'check:e2e'] : command,
			controller.signal
		);
	} finally {
		process.removeListener('SIGINT', onInterrupt);
		process.removeListener('SIGTERM', onInterrupt);
	}
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		await main();
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
