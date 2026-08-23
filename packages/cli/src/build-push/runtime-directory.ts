import { chmod, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { InvocationId } from '@cupboard/protocol/build';

import { SocketPathTooLongError } from '../errors.ts';

// `sun_path` is a fixed buffer holding the socket path and its terminator, so
// a usable path is strictly shorter than the platform's buffer size. The limit
// is real: a nested runner-style temporary directory overruns it and `listen`
// fails with EINVAL.
export const darwinSunPathBytes = 104;
export const linuxSunPathBytes = 108;

export const socketFileName = 'hook.sock';
const rootOwnerFileSuffix = '.cupboard-owner';

export function sunPathBytes(platform: NodeJS.Platform): number {
	return platform === 'darwin' ? darwinSunPathBytes : linuxSunPathBytes;
}

export interface InvocationRuntimeEnvironment {
	readonly XDG_RUNTIME_DIR?: string;
	readonly RUNNER_TEMP?: string;
}

export interface InvocationRuntimeOptions {
	readonly invocationId: InvocationId;
	readonly environment?: InvocationRuntimeEnvironment;
	readonly platform?: NodeJS.Platform;
	readonly temporaryDirectory?: string;
}

export interface InvocationRuntimePlan {
	readonly directory: string;
	readonly socketPath: string;
}

function isWithinSunPath(socketPath: string, limitBytes: number): boolean {
	return Buffer.byteLength(socketPath, 'utf8') < limitBytes;
}

function environmentBases(
	options: InvocationRuntimeOptions
): readonly string[] {
	const environment = options.environment ?? process.env;

	return [environment.XDG_RUNTIME_DIR, environment.RUNNER_TEMP].flatMap(
		(base) => (base === undefined || base === '' ? [] : [base])
	);
}

/**
 * Where one invocation's own directory lives when it hosts no hook endpoint:
 * the first preferred base's `cupboard/<invocation id>`, or the operating
 * system's temporary directory. A run with no socket to listen on is not bound
 * by the `sun_path` limit, so the first base is always used.
 */
export function planInvocationDirectory(
	options: InvocationRuntimeOptions
): string {
	const [base = options.temporaryDirectory ?? tmpdir()] =
		environmentBases(options);

	return path.join(base, 'cupboard', options.invocationId);
}

/**
 * Where one invocation's hook endpoint lives: an owner-only directory holding
 * the listening socket, chosen so the socket path fits `sun_path`. Candidate
 * bases are tried in order (`$XDG_RUNTIME_DIR`, `$RUNNER_TEMP`, the operating
 * system's temporary directory), each with a `cupboard/<invocation id>`
 * suffix, and the first whose socket path fits wins.
 */
export function planInvocationRuntime(
	options: InvocationRuntimeOptions
): InvocationRuntimePlan {
	const limitBytes = sunPathBytes(options.platform ?? process.platform);

	const candidateFor = (base: string): InvocationRuntimePlan => {
		const directory = path.join(base, 'cupboard', options.invocationId);

		return { directory, socketPath: path.join(directory, socketFileName) };
	};

	const fallback = candidateFor(options.temporaryDirectory ?? tmpdir());
	const candidates = [
		...environmentBases(options).map((base) => candidateFor(base)),
		fallback
	];

	const plan = candidates.find((candidate) =>
		isWithinSunPath(candidate.socketPath, limitBytes)
	);

	if (plan === undefined) {
		throw new SocketPathTooLongError(fallback.socketPath, limitBytes);
	}

	return plan;
}

/**
 * Creates the planned invocation directory, owner-only. The daemon connects
 * through it as root; the mode excludes every other user.
 */
export async function createInvocationRuntimeDirectory(
	options: InvocationRuntimeOptions
): Promise<InvocationRuntimePlan> {
	const plan = planInvocationRuntime(options);

	await createRuntimeDirectory(plan.directory);

	return plan;
}

export async function createRuntimeDirectory(directory: string): Promise<void> {
	await mkdir(directory, { mode: 0o700, recursive: true });
	// The process umask masks the mode `mkdir` applies, so the owner-only mode
	// is asserted explicitly.
	await chmod(directory, 0o700);
}

export interface RootLinkDirectory {
	readonly directory: string;
	close(): Promise<void>;
}

function rootOwnerFile(directory: string): string {
	return path.join(
		path.dirname(directory),
		`.${path.basename(directory)}${rootOwnerFileSuffix}`
	);
}

async function rootOwnerSocket(directory: string): Promise<string | undefined> {
	try {
		return await readlink(rootOwnerFile(directory));
	} catch {
		return undefined;
	}
}

function socketAcceptsConnection(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		let isFinished = false;
		const finish = (isActive: boolean): void => {
			if (isFinished) {
				return;
			}

			isFinished = true;
			socket.destroy();
			resolve(isActive);
		};

		socket.once('connect', () => {
			finish(true);
		});
		socket.once('error', () => {
			finish(false);
		});
		socket.setTimeout(250, () => {
			finish(false);
		});
	});
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
}

/**
 * Creates a daemonless run's GC-root directory and records the private socket
 * that identifies its owner. A later invocation removes a directory that has no
 * owner record or whose recorded socket no longer accepts connections. This
 * releases roots left by a process that could not clean up. The socket itself
 * stays in the short invocation runtime directory so a long Nix state directory
 * cannot exceed `sun_path`.
 */
export async function createRootLinkDirectory(
	directory: string,
	ownerSocket: string
): Promise<RootLinkDirectory> {
	const parent = path.dirname(directory);

	await createRuntimeDirectory(parent);
	const entries = await readdir(parent, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		const candidate = path.join(parent, entry.name);
		const candidateOwner = await rootOwnerSocket(candidate);

		if (
			candidateOwner !== undefined &&
			(await socketAcceptsConnection(candidateOwner))
		) {
			continue;
		}

		await Promise.all([
			removeInvocationRuntimeDirectory(candidate),
			rm(rootOwnerFile(candidate), { force: true })
		]);
	}

	const directoryNames = new Set(
		entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	);
	for (const entry of entries) {
		if (
			!entry.name.startsWith('.') ||
			!entry.name.endsWith(rootOwnerFileSuffix)
		) {
			continue;
		}

		const directoryName = entry.name.slice(1, -rootOwnerFileSuffix.length);
		if (directoryName === '' || directoryNames.has(directoryName)) {
			continue;
		}

		const ownerFile = path.join(parent, entry.name);
		let recordedSocket: string | undefined;
		try {
			recordedSocket = await readlink(ownerFile);
		} catch {
			recordedSocket = undefined;
		}

		if (
			recordedSocket !== undefined &&
			(await socketAcceptsConnection(recordedSocket))
		) {
			continue;
		}

		await rm(ownerFile, { force: true });
	}

	const server = createServer((socket) => {
		socket.end();
	});

	await listen(server, ownerSocket);
	await chmod(ownerSocket, 0o600);

	const ownerFile = rootOwnerFile(directory);

	try {
		await symlink(ownerSocket, ownerFile);
		await createRuntimeDirectory(directory);
	} catch (error) {
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
		await Promise.all([
			removeInvocationRuntimeDirectory(directory),
			rm(ownerFile, { force: true })
		]);
		throw error;
	}

	let isClosed = false;

	return {
		directory,
		async close() {
			if (isClosed) {
				return;
			}

			isClosed = true;
			try {
				await new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error === undefined) {
							resolve();
							return;
						}

						reject(error);
					});
				});
			} finally {
				await Promise.all([
					removeInvocationRuntimeDirectory(directory),
					rm(ownerFile, { force: true })
				]);
			}
		}
	};
}

export async function removeInvocationRuntimeDirectory(
	directory: string
): Promise<void> {
	await rm(directory, { recursive: true, force: true });
}
