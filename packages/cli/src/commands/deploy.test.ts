import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../cli.ts';
import { executeDeploy } from '../deploy/command.ts';
import { createDeployUi } from '../deploy/ui.ts';
import { OwnerLoginRequiredError } from '../errors.ts';

vi.mock('../deploy/command.ts', () => ({ executeDeploy: vi.fn() }));

describe('init result file', () => {
	it.each(['init', 'deploy'])(
		'keeps the completed deployment result when %s onboarding fails',
		async (command) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-deploy-results-')
			);
			const resultFile = path.join(directory, 'results.jsonl');
			const failure = new OwnerLoginRequiredError();
			const result = {
				kind: 'deployment',
				data: { controlWorker: 'cupboard' }
			};
			vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
			vi.mocked(executeDeploy).mockImplementation(
				(_options, runtimeOptions) => {
					createDeployUi(runtimeOptions)
						.reporter()
						.result({ ...result, rows: [] });
					return Promise.reject(failure);
				}
			);

			try {
				await expect(
					buildProgram().parseAsync(
						['--result-file', resultFile, command, '--yes'],
						{ from: 'user' }
					)
				).rejects.toBe(failure);
				expect(await readFile(resultFile, 'utf8')).toBe(
					`${JSON.stringify(result)}\n`
				);
			} finally {
				vi.restoreAllMocks();
				await rm(directory, { recursive: true, force: true });
			}
		}
	);
});
