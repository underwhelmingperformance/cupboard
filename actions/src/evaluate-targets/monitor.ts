import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

import type { Environment } from '../inputs.ts';

import { EvaluationResourceMonitor } from './resources.ts';

interface EvaluationMonitorDependencies {
	readonly sample?: (signal: AbortSignal) => Promise<void>;
}

async function monitorResources(
	sample: (signal: AbortSignal) => Promise<void>,
	signal: AbortSignal
): Promise<void> {
	try {
		while (!signal.aborted) {
			await sample(signal);
			await setTimeout(5000, undefined, { signal });
		}
	} catch (error) {
		if (!signal.aborted) {
			process.stderr.write(
				`Evaluation monitor unavailable: ${String(error)}\n`
			);
		}
	}
}

/**
Collects debug resource samples until evaluation completes, then joins monitoring.
*/
export async function withEvaluationMonitor<T>(
	environment: Environment,
	operation: () => Promise<T>,
	dependencies: EvaluationMonitorDependencies = {}
): Promise<T> {
	if (environment.RUNNER_DEBUG !== '1') {
		return operation();
	}
	const monitor = new EvaluationResourceMonitor(environment);
	const controller = new AbortController();
	const closed = monitorResources(
		dependencies.sample ?? ((signal) => monitor.sample(signal)),
		controller.signal
	);
	try {
		return await operation();
	} finally {
		controller.abort();
		await closed;
	}
}
