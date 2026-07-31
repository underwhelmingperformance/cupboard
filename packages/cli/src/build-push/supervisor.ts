import { type ChildProcess, spawn } from 'node:child_process';
import process from 'node:process';

import type { ChildEnvironment } from './nix-config.ts';
import { removeInvocationRuntimeDirectory } from './runtime-directory.ts';

/** An argv array with the executable first. */
export type ChildCommand = readonly [string, ...string[]];

/** How the child ended: an exit status, or the signal that killed it. */
export interface ChildExit {
	readonly status: number | undefined;
	readonly signal: NodeJS.Signals | undefined;
}

/** Where the forwarded signals arrive; `process` in production. */
export interface SignalSource {
	on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
	off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface SuperviseOptions {
	readonly command: ChildCommand;
	readonly environment: ChildEnvironment;
	/** The invocation runtime directory, removed once the run is over. */
	readonly runtimeDirectory: string;
	/**
	 * Runs after the child exits and before the runtime directory is removed:
	 * the command layer drains uploads and reconciles here, while the hook
	 * endpoint still exists.
	 */
	readonly onExit?: (exit: ChildExit) => Promise<void>;
	readonly signalSource?: SignalSource;
}

function waitForExit(child: ChildProcess): Promise<ChildExit> {
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (status, signal) => {
			resolve({ status: status ?? undefined, signal: signal ?? undefined });
		});
	});
}

/**
 * Runs the user-supplied build command to completion with the composed
 * environment and inherited stdio, so the child's output and semantics are
 * untouched: a failed build is still a failed build, and the caller reads the
 * child's own exit status or signal from the result. SIGINT and SIGTERM
 * arriving at the supervisor are forwarded to the child, and the invocation
 * runtime directory is removed once the run is over, whether the child
 * succeeded, failed, or could not start.
 */
export async function superviseBuild(
	options: SuperviseOptions
): Promise<ChildExit> {
	const signalSource = options.signalSource ?? process;
	const [executable, ...childArguments] = options.command;
	const child = spawn(executable, childArguments, {
		stdio: 'inherit',
		env: { ...options.environment }
	});

	const forwardInt = (): void => {
		child.kill('SIGINT');
	};
	const forwardTerm = (): void => {
		child.kill('SIGTERM');
	};

	signalSource.on('SIGINT', forwardInt);
	signalSource.on('SIGTERM', forwardTerm);

	try {
		const exit = await waitForExit(child);

		await options.onExit?.(exit);

		return exit;
	} finally {
		signalSource.off('SIGINT', forwardInt);
		signalSource.off('SIGTERM', forwardTerm);
		await removeInvocationRuntimeDirectory(options.runtimeDirectory);
	}
}
