import { chmod, mkdir, rm } from 'node:fs/promises';
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

// The bases a run prefers for its own directory, in order, before the
// operating system's temporary directory.
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
 * system's temporary directory. A run with no socket to listen on has no path
 * length to satisfy, so every base fits.
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
 * system's temporary directory), each carrying a `cupboard/<invocation id>`
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

/** Creates one of a run's own directories, owner-only. */
export async function createRuntimeDirectory(directory: string): Promise<void> {
	await mkdir(directory, { mode: 0o700, recursive: true });
	// The process umask masks the mode `mkdir` applies, so the owner-only mode
	// is asserted explicitly.
	await chmod(directory, 0o700);
}

/** Removes the invocation directory and the socket inside it. */
export async function removeInvocationRuntimeDirectory(
	directory: string
): Promise<void> {
	await rm(directory, { recursive: true, force: true });
}
