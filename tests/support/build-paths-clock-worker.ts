import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { runNativeBuildWorker } from '../../actions/src/build-paths/native-worker.ts';
import { requireEnvironment } from '../../actions/src/inputs.ts';

import { ManualClock } from './manual-clock.ts';

const clock = new ManualClock();
const record = path.join(
	requireEnvironment(process.env, 'RUNNER_TEMP'),
	'retry-clock.jsonl'
);

void runNativeBuildWorker({
	sleep: async (delayMs, signal) => {
		if (signal === undefined) {
			throw new Error('The native build worker must supply its abort signal');
		}

		const waiting = clock.wait(delayMs, signal);
		await clock.advanceThroughDelay(delayMs);
		await waiting;
		await appendFile(
			record,
			`${JSON.stringify({ delayMs, afterMs: clock.now() })}\n`
		);
	}
});
