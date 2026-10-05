import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

const run = promisify(execFile);
const dependencies = [
	'static',
	'unit',
	'server',
	'actions',
	'scripts',
	'e2e',
	'e2e-remote-store',
	'conformance'
];
const stepSchema = z.looseObject({
	run: z.string().optional(),
	env: z.record(z.string(), z.string()).optional()
});
const platformSchema = z.object({ system: z.string() });
const matrixSchema = z.object({ include: z.array(platformSchema) });
const strategySchema = z.looseObject({ matrix: matrixSchema });
const jobSchema = z.looseObject({
	if: z.string().optional(),
	'timeout-minutes': z.number().optional(),
	needs: z.array(z.string()).optional(),
	steps: z.array(stepSchema).optional(),
	strategy: strategySchema.optional()
});
const workflowSchema = z.object({ jobs: z.record(z.string(), jobSchema) });

async function workflow() {
	const source = await readFile(
		new URL('../.github/workflows/ci.yml', import.meta.url),
		'utf8'
	);
	const parsed: unknown = parse(source);
	return workflowSchema.parse(parsed);
}

describe('required source check', () => {
	it('requires every source tier and all conformance platforms without rerunning suites', async () => {
		const { jobs } = await workflow();
		expect({
			condition: jobs.check?.if,
			timeoutMinutes: jobs.check?.['timeout-minutes'],
			dependencies: jobs.check?.needs,
			platforms: jobs.conformance?.strategy?.matrix.include.map(
				({ system }) => system
			)
		}).toStrictEqual({
			condition: 'always()',
			timeoutMinutes: 1,
			dependencies,
			platforms: [
				'x86_64-linux',
				'aarch64-linux',
				'x86_64-darwin',
				'aarch64-darwin'
			]
		});
		expect(jobs.check?.steps).toStrictEqual([
			{
				env: { JOB_RESULTS: '${{ toJSON(needs) }}' },
				run: 'jq -e \'length > 0 and all(.[]; .result == "success")\' <<< "$JOB_RESULTS"'
			}
		]);
		for (const tier of dependencies) {
			expect(jobs[tier]).toBeDefined();
		}
		expect(
			Object.keys(jobs)
				.filter((job) =>
					[
						'binary',
						'flake',
						'pipeline-e2e',
						'action-e2e',
						'action-e2e-no-project'
					].includes(job)
				)
				.toSorted(byCodeUnit)
		).toStrictEqual([
			'action-e2e',
			'action-e2e-no-project',
			'binary',
			'flake',
			'pipeline-e2e'
		]);
	});

	it.each(['success', 'failure', 'cancelled', 'skipped'])(
		'accepts only successful prerequisites (%s)',
		async (result) => {
			const { jobs } = await workflow();
			const command = jobs.check?.steps?.[0]?.run;
			if (command === undefined) {
				throw new Error('Missing required-check aggregation command');
			}
			let outcome = 'success';
			try {
				await run('bash', ['-e', '-c', command], {
					env: {
						...process.env,
						JOB_RESULTS: JSON.stringify({
							static: { result: 'success' },
							e2e: { result }
						})
					}
				});
			} catch {
				outcome = 'failure';
			}
			expect(outcome).toBe(result === 'success' ? 'success' : 'failure');
		}
	);
});
