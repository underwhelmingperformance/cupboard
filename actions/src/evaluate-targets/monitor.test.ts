import { execFile } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const execute = promisify(execFile);
const script = fileURLToPath(
	new URL('../../evaluate-targets/monitor.sh', import.meta.url)
);

it.each(['', '0', '1'])(
	'collects resources only in runner debug mode %j',
	async (debug) => {
		const result = await execute('bash', [script, '--once'], {
			env: { ...process.env, RUNNER_DEBUG: debug }
		});
		expect({
			stdout: result.stdout,
			resourceSample: result.stderr.includes('[evaluation resource-sample]'),
			processMemory: result.stderr.includes('RSS'),
			diskSpace: result.stderr.includes('Filesystem')
		}).toStrictEqual({
			stdout: '',
			resourceSample: debug === '1',
			processMemory: debug === '1',
			diskSpace: debug === '1'
		});
	}
);
