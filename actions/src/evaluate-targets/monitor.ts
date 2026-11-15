import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

import type { Environment } from '../inputs.ts';

import { EvaluationResourceMonitor } from './resources.ts';

/**
Waits for `milliseconds`. The wait rejects when `options.signal` aborts. The
signature is that of `setTimeout` from `node:timers/promises`.
*/
type SampleDelay = (
	milliseconds: number,
	value: undefined,
	options: { readonly signal: AbortSignal }
) => Promise<void>;

interface EvaluationMonitorDependencies {
	readonly sample?: (signal: AbortSignal) => Promise<void>;
	/**
	The wait between samples. Defaults to `setTimeout` from `node:timers/promises`.
	*/
	readonly delay?: SampleDelay;
}

async function monitorResources(
	sample: (signal: AbortSignal) => Promise<void>,
	delay: SampleDelay,
	signal: AbortSignal
): Promise<void> {
	try {
		while (!signal.aborted) {
			await sample(signal);
			await delay(5000, undefined, { signal });
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
		dependencies.delay ?? setTimeout,
		controller.signal
	);
	try {
		return await operation();
	} finally {
		controller.abort();
		await closed;
	}
}
