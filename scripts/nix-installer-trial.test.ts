import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

import { withTemporaryDirectory } from '../tests/support/filesystem.ts';

const execute = promisify(execFile);

it.each(['local-filesystem', 'daemon'] as const)(
	'checks nested cleanup for a %s store',
	async (store) => {
		await withTemporaryDirectory('cupboard-lifecycle-', async (directory) => {
			const adapterDirectory = path.join(directory, 'adapter');
			const hook = path.join(adapterDirectory, 'build-hook');
			const configuration = 'max-jobs = 2\nbuild-hook = /existing/hook\n';
			await mkdir(adapterDirectory);
			await writeFile(hook, '');
			const original = {
				NIX_CONFIG: configuration,
				NIX_USER_CONF_FILES: '/existing/config',
				NIX_SSHOPTS: 'original-options'
			};
			for (const [key, value] of Object.entries(original)) {
				await writeFile(path.join(directory, key), value);
			}
			const recorded = await execute(
				process.execPath,
				[path.resolve('tests/installer/lifecycle/record.ts'), store],
				{
					env: {
						...process.env,
						TRIAL_LIFECYCLE_DIRECTORY: directory,
						GITHUB_ENV: path.join(directory, 'environment'),
						NIX_CONFIG:
							store === 'daemon'
								? `${configuration}build-hook = ${hook}\n`
								: configuration
					}
				}
			);
			const recordedHook = await readFile(path.join(directory, 'hook'), 'utf8');
			await rm(adapterDirectory, { recursive: true });
			const cleaned = await execute(
				process.execPath,
				[path.resolve('tests/installer/lifecycle/post.ts')],
				{
					env: { ...process.env, STATE_directory: directory }
				}
			);
			expect({
				recorded: recorded.stdout,
				hook: recordedHook,
				cleaned: cleaned.stdout
			}).toStrictEqual({
				recorded: '',
				hook: store === 'daemon' ? hook : '',
				cleaned:
					store === 'daemon'
						? 'Nested builder action cleanup verified after its post step.\n'
						: 'Single-user builder preparation left the build hook unchanged.\n'
			});
		});
	}
);

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
		scenario: 'a removed required test',
		source: "it('different', () => expect(true).toBe(true));",
		expectedCode: 1
	},
	{
		scenario: 'a skipped prerequisite',
		source: "describe.skip('missing daemon', () => it('runs', () => {}));",
		expectedTests: ['missing daemon > runs'],
		expectedCode: 1
	},
	{
		scenario: 'a dynamic skip',
		source: "it('runs', (context) => context.skip());",
		expectedCode: 1
	}
])(
	'requires an executed trial for $scenario',
	async ({ source, expectedCode, ...scenario }) => {
		const expectedTests =
			'expectedTests' in scenario ? scenario.expectedTests : ['runs'];
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
					`import RequiredInstallerTestsReporter from ${JSON.stringify(reporter)};\nexport default { test: { root: ${JSON.stringify(directory)}, include: ['fixture.test.ts'], reporters: [['junit', { outputFile: ${JSON.stringify(reportPath)} }], new RequiredInstallerTestsReporter(${JSON.stringify(expectedTests)})], maxWorkers: 1 } };\n`
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
						{
							timeout: 30_000,
							env: {
								...process.env,
								NODE_OPTIONS: '--no-experimental-transform-types'
							}
						}
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
const jobsSchema = z.object({ trial: jobSchema, production: jobSchema });
const pathFilterSchema = z.object({ paths: z.array(z.string()) });
const workflowSchema = z.looseObject({
	jobs: jobsSchema,
	on: z.object({ pull_request: pathFilterSchema })
});

it.each(['actions/src/inputs.ts', 'packages/shared/src/errors.ts'])(
	'runs the installer trial when %s changes',
	async (file) => {
		const document: unknown = parse(
			await readFile(
				new URL(
					'../.github/workflows/nix-installer-trial.yml',
					import.meta.url
				),
				'utf8'
			)
		);
		const workflow = workflowSchema.parse(document);
		const shouldTrigger = workflow.on.pull_request.paths.some((pattern) =>
			path.matchesGlob(file, pattern)
		);
		expect(shouldTrigger).toBe(true);
	}
);

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
			},
			{
				name: 'Test separate builder transfers and observation',
				condition:
					"${{ !cancelled() && steps.dependencies.outcome == 'success' && runner.os == 'Linux' }}"
			}
		]
	});
});

it('exercises the production prepare action before testing the production store', async () => {
	const document: unknown = parse(
		await readFile(
			new URL('../.github/workflows/nix-installer-trial.yml', import.meta.url),
			'utf8'
		)
	);
	const { trial, production } = workflowSchema.parse(document).jobs;
	const prepare = production.steps.find(
		(step) => step.uses === '$/actions/prepare'
	);
	expect({
		matrix: production.strategy.matrix.include,
		prepare,
		stages: production.steps
			.filter(
				(step) =>
					(step.uses ?? '').startsWith('$/') ||
					/^(?:Record|Test|Verify) /u.test(step.name ?? '')
			)
			.map(({ name, uses, if: condition }) => ({ name, uses, condition }))
	}).toStrictEqual({
		matrix: trial.strategy.matrix.include,
		prepare: {
			name: 'Exercise the production prepare action',
			uses: '$/actions/prepare',
			with: {
				remote: 'true',
				builders: 'ssh-ng://unused.invalid ${{ matrix.system }} - 1 1',
				'builder-known-hosts': 'unused.invalid fixture-not-used-for-connections'
			}
		},
		stages: [
			{
				name: undefined,
				uses: '$/tests/installer/lifecycle',
				condition: undefined
			},
			{
				name: 'Exercise the production prepare action',
				uses: '$/actions/prepare',
				condition: undefined
			},
			{
				name: 'Verify single-user builder preparation and restore the test environment',
				uses: undefined,
				condition: undefined
			},
			{
				name: 'Record the production store',
				uses: undefined,
				condition: undefined
			},
			{
				name: 'Test separate builder transfers and observation',
				uses: undefined,
				condition: "runner.os == 'Linux'"
			}
		]
	});
});
