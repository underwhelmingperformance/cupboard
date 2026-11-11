import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { StorePathString } from '@cupboard/nix-store/scalars';
import {
	type AbortableChildProcessLifecycle,
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';

import {
	CommandFailedError,
	DerivationClosureImportError,
	DerivationClosureUntrustedError
} from './errors.ts';
import {
	copyNixPaths,
	type NixCopyDependencies,
	verifyNixPaths
} from './nix-copy.ts';

/**
The file name of the archive in the derivation artifact. The plan job writes
the archive under this name, and the flake publish workflow passes the same
name to the cohort job after the download.
*/
export const derivationArchiveName = 'cupboard-derivations.tar';

/**
Starts `tar` with the given arguments. Its output goes to the job log.
*/
export type TarStarter = (
	arguments_: readonly string[],
	signal: AbortSignal | undefined
) => AbortableChildProcessLifecycle;

export interface DerivationClosureDependencies {
	readonly startTar?: TarStarter;
	readonly copy?: NixCopyDependencies;
	readonly verify?: NixCopyDependencies;
	/**
	Returns the current time in milliseconds, for the recorded durations.
	*/
	readonly now?: () => number;
}

export interface DerivationClosureExport {
	readonly archive: string;
	readonly archiveBytes: number;
	/**
	The number of store paths in the archive.
	*/
	readonly paths: number;
	/**
	The time Nix took to check that a cohort job can import the closure.
	*/
	readonly checkMs: number;
	readonly copyMs: number;
	readonly packMs: number;
}

export interface DerivationClosureImport {
	/**
	The number of store paths in the archive, which contains the closures of
	every cohort's derivations.
	*/
	readonly archivePaths: number;
	readonly unpackMs: number;
	/**
	The time Nix took to check the closure that the import copies.
	*/
	readonly verifyMs: number;
	readonly copyMs: number;
}

const startLoggedTar: TarStarter = (arguments_) =>
	observeChildProcess(
		spawn('tar', [...arguments_], { stdio: ['ignore', 'inherit', 'inherit'] })
	);

async function runTar(
	arguments_: readonly string[],
	signal: AbortSignal | undefined,
	start: TarStarter
): Promise<void> {
	const result = await waitForAbortableChildProcess(
		start(arguments_, signal),
		signal
	);

	if (result.error !== undefined) {
		throw result.error;
	}

	if (result.status !== 0) {
		throw new CommandFailedError('tar', result.status);
	}
}

async function narInfoCount(cache: string): Promise<number> {
	const entries = await readdir(cache);

	return entries.filter((entry) => entry.endsWith('.narinfo')).length;
}

/**
Writes the closure of `derivations` from the runner's store to a `file://`
binary cache under `directory`, and packs the cache into one archive. An
artifact of one file uploads and downloads much faster than one with a file
for every path.

Before the copy, `nix store verify` checks the closure in the runner's store
with the rule that the cohort jobs apply to the archive. The export refuses a
closure that a cohort would refuse, so the plan job fails once and no cohort
job fails on it.
*/
export async function exportDerivationClosure(
	derivations: readonly StorePathString[],
	directory: string,
	signal?: AbortSignal,
	dependencies: DerivationClosureDependencies = {}
): Promise<DerivationClosureExport> {
	const now = dependencies.now ?? (() => Date.now());
	const start = dependencies.startTar ?? startLoggedTar;
	const cache = path.join(directory, 'cache');
	const archive = path.join(directory, derivationArchiveName);
	const checkStartedAt = now();

	try {
		await verifyNixPaths({ paths: derivations }, signal, dependencies.verify);
	} catch (error) {
		signal?.throwIfAborted();

		throw new DerivationClosureUntrustedError({ cause: error });
	}

	await mkdir(cache, { recursive: true });

	const copyStartedAt = now();
	await copyNixPaths(
		{
			paths: derivations,
			to: `${pathToFileURL(cache).href}?compression=zstd`,
			quiet: true
		},
		signal,
		dependencies.copy
	);
	const packStartedAt = now();
	await runTar(['-cf', archive, '-C', cache, '.'], signal, start);
	const packedAt = now();
	const archiveStatus = await stat(archive);
	const paths = await narInfoCount(cache);

	await rm(cache, { recursive: true, force: true });

	return {
		archive,
		archiveBytes: archiveStatus.size,
		paths,
		checkMs: copyStartedAt - checkStartedAt,
		copyMs: packStartedAt - copyStartedAt,
		packMs: packedAt - packStartedAt
	};
}

/**
Unpacks the plan job's archive under `directory` and copies the closure of
`derivations` into the runner's store. The caller takes the derivation paths
from the plan job's outputs, never from the archive.

Before the copy, `nix store verify` reads the closure from the unpacked
archive, as Nix reads it, and requires every path to have a content address
that produces its store path or a signature from a key that this runner's Nix
configuration trusts. A Nix daemon whose own configuration turns
`require-sigs` off would not make this check for an untrusted client. Nix
then checks each copied NAR against its hash and its content address, so the
copy fails when the archive lacks a path or contains a changed one. The
archive and its unpacked copy are removed afterwards, whether the copy
succeeded or not, to give the disk space back to the build.
*/
export async function importDerivationClosure(
	archive: string,
	derivations: readonly StorePathString[],
	directory: string,
	signal?: AbortSignal,
	dependencies: DerivationClosureDependencies = {}
): Promise<DerivationClosureImport> {
	const now = dependencies.now ?? (() => Date.now());
	const start = dependencies.startTar ?? startLoggedTar;
	const cache = path.join(directory, 'cache');
	const cacheUrl = pathToFileURL(cache).href;

	try {
		await mkdir(cache, { recursive: true });

		const unpackStartedAt = now();
		await runTar(['-xf', archive, '-C', cache], signal, start);
		const archivePaths = await narInfoCount(cache);
		const verifyStartedAt = now();
		await verifyNixPaths(
			{ paths: derivations, store: cacheUrl },
			signal,
			dependencies.verify
		);
		const copyStartedAt = now();
		await copyNixPaths(
			{ paths: derivations, from: cacheUrl, to: 'auto', quiet: true },
			signal,
			dependencies.copy
		);
		const copiedAt = now();

		return {
			archivePaths,
			unpackMs: verifyStartedAt - unpackStartedAt,
			verifyMs: copyStartedAt - verifyStartedAt,
			copyMs: copiedAt - copyStartedAt
		};
	} catch (error) {
		signal?.throwIfAborted();

		throw new DerivationClosureImportError(archive, { cause: error });
	} finally {
		await rm(directory, { recursive: true, force: true });
		await rm(archive, { force: true });
	}
}
