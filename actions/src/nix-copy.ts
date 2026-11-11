import { spawn } from 'node:child_process';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { StorePathString } from '@cupboard/nix-store/scalars';
import {
	type AbortableChildProcessLifecycle,
	type ClosedChildProcess,
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';

import { CommandFailedError } from './errors.ts';

export interface NixCopyOptions {
	readonly paths: readonly StorePathString[];
	readonly from?: string;
	readonly to: string;
	/**
	Leave out the line that Nix prints for each copied path. Errors still
	reach the job log.
	*/
	readonly quiet?: boolean;
}

export interface NixCopyProcess extends AbortableChildProcessLifecycle {
	readonly stdin: Writable;
}

export interface NixCopyDependencies {
	readonly start?: (
		arguments_: readonly string[],
		signal: AbortSignal | undefined
	) => NixCopyProcess;
}

function startNixCopy(
	arguments_: readonly string[],
	_signal: AbortSignal | undefined
): NixCopyProcess {
	const child = spawn('nix', arguments_, {
		stdio: ['pipe', 'inherit', 'inherit']
	});
	return { ...observeChildProcess(child), stdin: child.stdin };
}

function* pathLines(paths: readonly StorePathString[]): Iterable<string> {
	for (const path of paths) {
		yield `${path}\n`;
	}
}

class CopyExecution implements AbortableChildProcessLifecycle {
	readonly #inputFailure = new AbortController();
	readonly #signal: AbortSignal;
	#closed = false;
	#status: number | null | undefined;
	#spawnError: Error | undefined;
	#inputError: Error | undefined;

	constructor(
		readonly child: NixCopyProcess,
		readonly callerSignal: AbortSignal | undefined,
		readonly description: string
	) {
		this.#signal =
			callerSignal === undefined
				? this.#inputFailure.signal
				: AbortSignal.any([callerSignal, this.#inputFailure.signal]);
		child.stdin.once('error', (error: Error) => {
			this.#failInput(error);
		});
	}

	#failInput(error: unknown): void {
		this.#inputError ??=
			error instanceof Error
				? error
				: new Error('Cannot write store paths to Nix copy', { cause: error });
		if (
			!this.#closed &&
			this.#spawnError === undefined &&
			!this.callerSignal?.aborted
		) {
			this.#inputFailure.abort(this.#inputError);
		}
	}

	async #writeInput(paths: readonly StorePathString[]): Promise<void> {
		try {
			await pipeline(Readable.from(pathLines(paths)), this.child.stdin, {
				signal: this.#signal
			});
		} catch (error) {
			this.#failInput(error);
		}
	}

	#requireSuccess(outcome: PromiseSettledResult<ClosedChildProcess>): void {
		this.callerSignal?.throwIfAborted();
		if (this.#spawnError !== undefined) {
			throw this.#spawnError;
		}
		if (
			this.#status !== undefined &&
			this.#status !== null &&
			this.#status !== 0
		) {
			throw new CommandFailedError(this.description, this.#status);
		}
		if (this.#inputError !== undefined) {
			throw this.#inputError;
		}
		if (outcome.status === 'rejected') {
			throw outcome.reason;
		}
		if (outcome.value.status !== 0) {
			throw new CommandFailedError(this.description, outcome.value.status);
		}
	}

	kill(signal: NodeJS.Signals): boolean {
		return this.child.kill(signal);
	}

	onceError(listener: (error: Error) => void): void {
		this.child.onceError((error) => {
			this.#spawnError ??= error;
			listener(error);
		});
	}

	onceClose(
		listener: (
			status: number | null,
			signal: NodeJS.Signals | undefined
		) => void
	): void {
		this.child.onceClose((status, signal) => {
			this.#closed = true;
			this.#status = status;
			listener(status, signal);
		});
	}

	async run(paths: readonly StorePathString[]): Promise<void> {
		const completion = waitForAbortableChildProcess(this, this.#signal);
		const input = this.#writeInput(paths);
		const [outcome] = await Promise.allSettled([completion, input]);
		this.#requireSuccess(outcome);
	}
}

/**
Copies paths between Nix stores without putting the path list in argv.
*/
export async function copyNixPaths(
	options: NixCopyOptions,
	signal?: AbortSignal,
	dependencies: NixCopyDependencies = {}
): Promise<void> {
	signal?.throwIfAborted();
	const child = (dependencies.start ?? startNixCopy)(
		[
			'copy',
			...(options.quiet === true ? ['--quiet'] : []),
			...(options.from === undefined ? [] : ['--from', options.from]),
			'--to',
			options.to,
			'--stdin'
		],
		signal
	);
	await new CopyExecution(child, signal, 'nix copy').run(options.paths);
}

export interface NixVerifyOptions {
	readonly paths: readonly StorePathString[];
	/**
	The store to read. Leave it out to read the default store.
	*/
	readonly store?: string;
}

/**
Runs `nix store verify` on the closure of the given paths without putting the
path list in argv. It fails unless every path in the closure has a content
address that produces its store path or a signature from a key that this
process's Nix configuration trusts. It does not read the NARs.
*/
export async function verifyNixPaths(
	options: NixVerifyOptions,
	signal?: AbortSignal,
	dependencies: NixCopyDependencies = {}
): Promise<void> {
	signal?.throwIfAborted();
	const child = (dependencies.start ?? startNixCopy)(
		[
			'store',
			'verify',
			'--quiet',
			'--no-contents',
			'--sigs-needed',
			'1',
			'--recursive',
			...(options.store === undefined ? [] : ['--store', options.store]),
			'--stdin'
		],
		signal
	);
	await new CopyExecution(child, signal, 'nix store verify').run(options.paths);
}
