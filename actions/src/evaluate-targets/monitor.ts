import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';

import type { Environment } from '../inputs.ts';

export async function withEvaluationMonitor<T>(
	environment: Environment,
	operation: () => Promise<T>
): Promise<T> {
	if (environment.RUNNER_DEBUG !== '1') {
		return operation();
	}
	const controller = new AbortController();
	const monitor = spawn(
		'bash',
		[
			path.resolve(
				path.dirname(process.argv[1] ?? process.execPath),
				'..',
				'monitor.sh'
			),
			String(process.pid)
		],
		{ env: environment, stdio: ['ignore', 'ignore', 'inherit'] }
	);
	const watch = async (): Promise<void> => {
		try {
			await waitForAbortableChildProcess(
				observeChildProcess(monitor),
				controller.signal
			);
		} catch (error) {
			if (!controller.signal.aborted) {
				process.stderr.write(
					`Evaluation monitor unavailable: ${String(error)}\n`
				);
			}
		}
	};
	const closed = watch();
	try {
		return await operation();
	} finally {
		controller.abort();
		await closed;
	}
}
