import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
	type AbortableChildProcessLifecycle,
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';

import type { Environment } from '../inputs.ts';

interface EvaluationMonitorDependencies {
	readonly start?: (environment: Environment) => AbortableChildProcessLifecycle;
}

function startMonitor(
	environment: Environment
): AbortableChildProcessLifecycle {
	const directory = path.dirname(process.argv[1] ?? process.execPath);
	const script = path.resolve(directory, '..', 'monitor.sh');
	const child = spawn('bash', [script, String(process.pid)], {
		env: environment,
		stdio: ['ignore', 'ignore', 'inherit']
	});
	return observeChildProcess(child);
}

function report(error: unknown): void {
	process.stderr.write(`Evaluation monitor unavailable: ${String(error)}\n`);
}

async function watchMonitor(
	monitor: AbortableChildProcessLifecycle,
	signal: AbortSignal
): Promise<void> {
	try {
		const result = await waitForAbortableChildProcess(monitor, signal);
		if (result.error !== undefined) {
			report(result.error);
			return;
		}
		if (result.status !== 0) {
			report(`exited with status ${String(result.status)}`);
		}
	} catch (error) {
		if (!signal.aborted) {
			report(error);
		}
	}
}

/**
 * Runs resource monitoring in debug mode and joins it before returning.
 */
export async function withEvaluationMonitor<T>(
	environment: Environment,
	operation: () => Promise<T>,
	dependencies: EvaluationMonitorDependencies = {}
): Promise<T> {
	if (environment.RUNNER_DEBUG !== '1') {
		return operation();
	}
	let monitor: AbortableChildProcessLifecycle;
	try {
		monitor = (dependencies.start ?? startMonitor)(environment);
	} catch (error) {
		report(error);
		return operation();
	}
	const controller = new AbortController();
	const closed = watchMonitor(monitor, controller.signal);
	try {
		return await operation();
	} finally {
		controller.abort();
		await closed;
	}
}
