import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

import { withTemporaryDirectory } from '../tests/support/filesystem.ts';

const execute = promisify(execFile);

const stepSchema = z.looseObject({
	id: z.string().optional(),
	name: z.string().optional(),
	uses: z.string().optional(),
	with: z.record(z.string(), z.unknown()).optional(),
	run: z.string().optional(),
	if: z.string().optional()
});

it.each([
	{
		scenario: 'passing tests',
		source: "it('runs', () => expect(true).toBe(true));",
		expectedCode: 0
	},
	{
		scenario: 'a skipped prerequisite',
		source: "describe.skip('missing daemon', () => it('runs', () => {}));",
		expectedCode: 1
	},
	{
		scenario: 'a dynamic skip',
		source: "it('missing fixture', (context) => context.skip());",
		expectedCode: 1
	}
])(
	'requires an executed trial for $scenario',
	async ({ source, expectedCode }) => {
		await withTemporaryDirectory(
			'cupboard-installer-reporter-',
			async (directory) => {
				const testPath = path.join(directory, 'fixture.test.ts');
				const configPath = path.join(directory, 'vitest.config.ts');
				const vitestModule = path.resolve('node_modules/vitest/dist/index.js');
				const reporter = path.resolve(
					'tests/installer/required-tests-reporter.ts'
				);
				const reportPath = path.join(directory, 'results.xml');
				await writeFile(
					testPath,
					`import { describe, expect, it } from ${JSON.stringify(vitestModule)};\n${source}\n`
				);
				await writeFile(
					configPath,
					`export default { test: { root: ${JSON.stringify(directory)}, include: ['fixture.test.ts'], reporters: [['junit', { outputFile: ${JSON.stringify(reportPath)} }], ${JSON.stringify(reporter)}], maxWorkers: 1 } };\n`
				);
				let result = 0;
				try {
					await execute(
						process.execPath,
						[
							path.resolve('node_modules/vitest/vitest.mjs'),
							'run',
							'--config',
							configPath
						],
						{ timeout: 30_000 }
					);
				} catch (error) {
					result = z.object({ code: z.number() }).parse(error).code;
				}
				const report = await readFile(reportPath, 'utf8');
				expect({
					code: result,
					completeReport: report.includes('</testsuites>')
				}).toStrictEqual({ code: expectedCode, completeReport: true });
			}
		);
	}
);

const systemSchema = z.object({ system: z.string(), runner: z.string() });
const matrixSchema = z.object({ include: z.array(systemSchema) });
const strategySchema = z.object({
	'fail-fast': z.boolean(),
	matrix: matrixSchema
});
const jobSchema = z.looseObject({
	strategy: strategySchema,
	steps: z.array(stepSchema)
});
const jobsSchema = z.object({ trial: jobSchema });
const workflowSchema = z.looseObject({ jobs: jobsSchema });

it('trials the pinned NixOS installer independently of the production installer', async () => {
	const document: unknown = parse(
		await readFile(
			new URL('../.github/workflows/nix-installer-trial.yml', import.meta.url),
			'utf8'
		)
	);
	const { trial } = workflowSchema.parse(document).jobs;
	const installer = trial.steps.find((step) => step.id === 'install');
	const dependencies = trial.steps.findIndex(
		(step) => step.id === 'dependencies'
	);
	const installIndex = trial.steps.indexOf(installer ?? {});

	expect({
		matrix: trial.strategy.matrix.include,
		failFast: trial.strategy['fail-fast'],
		installer,
		installsBeforeDependencies:
			installIndex !== -1 && installIndex < dependencies,
		productionInstallers: trial.steps.filter((step) =>
			step.uses?.includes('/actions/install-nix')
		),
		probes: trial.steps
			.filter((step) => step.name?.startsWith('Test '))
			.map(({ name, if: condition }) => ({ name, condition }))
	}).toStrictEqual({
		matrix: [
			{ system: 'x86_64-linux', runner: 'ubuntu-24.04' },
			{ system: 'aarch64-linux', runner: 'ubuntu-24.04-arm' },
			{ system: 'aarch64-darwin', runner: 'macos-15' }
		],
		failFast: false,
		installer: {
			id: 'install',
			name: 'Install candidate Nix',
			uses: 'NixOS/nix-installer-action@62c1943b776c509394b550f3f983adc14e9212d6',
			with: { 'installer-version': '2.35.3', 'enable-kvm': 'false' }
		},
		installsBeforeDependencies: true,
		productionInstallers: [],
		probes: [
			{
				name: 'Test installation and SSH compatibility',
				condition:
					"${{ !cancelled() && steps.dependencies.outcome == 'success' }}"
			},
			{
				name: 'Test publication and build observation',
				condition:
					"${{ !cancelled() && steps.dependencies.outcome == 'success' }}"
			},
			{
				name: 'Test direct remote stores',
				condition:
					"${{ !cancelled() && steps.dependencies.outcome == 'success' && runner.os == 'Linux' }}"
			}
		]
	});
});
