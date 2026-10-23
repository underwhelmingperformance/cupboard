import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { resolveEvaluationConcurrency } from './concurrency.ts';

describe('evaluation concurrency', () => {
	it.each([true, false])(
		'resolves auto when the processor utility is available=%s',
		async (available) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-processors-')
			);
			onTestFinished(async () => {
				vi.unstubAllEnvs();
				await rm(directory, { recursive: true, force: true });
			});
			if (available) {
				const executable = path.join(directory, 'nproc');
				await writeFile(executable, "#!/bin/sh\nprintf '3\\n'\n");
				await chmod(executable, 0o755);
			}
			vi.stubEnv('PATH', directory);
			await expect(resolveEvaluationConcurrency('auto')).resolves.toBe(
				available ? 3 : availableParallelism()
			);
		}
	);

	it.each([
		{ input: undefined, expected: 4, probes: 0 },
		{ input: '', expected: 4, probes: 0 },
		{ input: 'auto', expected: 3, probes: 1 },
		{ input: '1', expected: 1, probes: 0 },
		{ input: '4', expected: 4, probes: 0 }
	])('resolves $input', async ({ input, expected, probes }) => {
		let calls = 0;
		const concurrency = await resolveEvaluationConcurrency(input, () => {
			calls += 1;
			return Promise.resolve('3\n');
		});

		expect({ concurrency, calls }).toStrictEqual({
			concurrency: expected,
			calls: probes
		});
	});

	it.each(['0', '-1', '1.5', 'NaN', '9007199254740992', 'four'])(
		'rejects invalid concurrency %s before probing CPUs',
		async (input) => {
			let calls = 0;
			await expect(
				resolveEvaluationConcurrency(input, () => {
					calls += 1;
					return Promise.resolve('3');
				})
			).rejects.toThrow('positive safe integer');
			expect(calls).toBe(0);
		}
	);
});
