import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	rootNameMaxLength,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { rootSetMaxTargets } from '@cupboard/protocol/retention';
import type { Reporter } from '@cupboard/reporter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	BooleanInputInvalidError,
	CohortFailureToleranceError,
	ComponentRootTargetLimitError,
	MatrixJobLimitError,
	MissingInputError,
	PackCapacityInvalidError,
	PublishRootTargetLimitError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	RemoteOutputPathUnknownDuringPlanningError,
	RootEnsureCommandError,
	RootEnsureResultInvalidError,
	RootEnsureResultMissingError,
	RootNameInvalidError,
	UrlInputInvalidError
} from '../errors.ts';
import {
	type Cohort,
	joinRoot,
	type NixEvaluator,
	publishTargetsSchema,
	type TargetEvaluation
} from '../publish-plan.ts';

import {
	cohortPreFilter,
	ensureAvailableTargets,
	type EnsureRunner,
	matrix,
	maximumMatrixJobs,
	packingMeasurer,
	planAction,
	type PlanInputs,
	type PlanOptions,
	resolvePlanInputs,
	validateRemoteOutputPredictability
} from './plan.ts';

function storePath(value: string): StorePathString {
	return storePathSchema.parse(value);
}

const targetRootDrvPath = storePath(
	'/nix/store/00000000000000000000000000000000-app.drv'
);

const target = {
	attr: '.#packages.x86_64-linux.app',
	rootDrvPath: targetRootDrvPath,
	system: 'x86_64-linux',
	os: 'ubuntu-latest',
	remote: true,
	rootSuffix: 'x86_64-linux/app'
};

const secondTarget = {
	...target,
	attr: '.#packages.x86_64-linux.app-b',
	rootDrvPath: storePath(`/nix/store/${'3'.repeat(32)}-app-b.drv`),
	rootSuffix: 'x86_64-linux/app-b'
};

const cohortToleranceEntrySchema = z.object({
	attrs: z.array(z.string()),
	bestEffort: z.boolean()
});
const cohortToleranceSchema = z.object({
	include: z.array(cohortToleranceEntrySchema)
});

async function cohortMatrixTolerance(
	outputFile: string
): Promise<readonly { attrs: readonly string[]; bestEffort: boolean }[]> {
	const outputs = await readFile(outputFile, 'utf8');
	const line = outputs
		.split('\n')
		.find((candidate) => candidate.startsWith('cohort-matrix='));

	if (line === undefined) {
		throw new Error('no cohort-matrix output line was recorded');
	}

	const parsed = cohortToleranceSchema.parse(
		JSON.parse(line.slice('cohort-matrix='.length))
	);

	return parsed.include
		.map((entry) => ({ attrs: entry.attrs, bestEffort: entry.bestEffort }))
		.toSorted((left, right) =>
			left.attrs.join(',').localeCompare(right.attrs.join(','))
		);
}

const baseOptions: PlanOptions = {
	targets: JSON.stringify([target]),
	url: 'https://cupboard.example/t/acme',
	cupboardPath: '/unused/cupboard',
	rootPrefix: 'github:owner/repo/main',
	optimise: 'false'
};

describe('planAction', () => {
	it('emits every target directly when optimisation is disabled', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));
		const output = path.join(directory, 'output');

		await planAction(
			baseOptions,
			{
				RUNNER_TEMP: directory,
				GITHUB_RUN_ID: '12345',
				GITHUB_OUTPUT: output
			},
			undefined,
			{ createArtifactName: () => 'cupboard-publish-plan-test' }
		);

		const plan: unknown = JSON.parse(
			await readFile(path.join(directory, 'cupboard-publish-plan.json'), 'utf8')
		);
		const outputs = await readFile(output, 'utf8');

		expect({ plan, outputs }).toStrictEqual({
			plan: {
				retained: [],
				targets: [{ ...target, bestEffort: false, outputs: ['out'] }],
				cohorts: [
					{
						key: 'cohort-x86_64-linux-ubuntu-latest-remote-5de0c136a0cc5dfe',
						system: 'x86_64-linux',
						os: 'ubuntu-latest',
						remote: true,
						targets: [{ ...target, bestEffort: false, outputs: ['out'] }],
						installables: ['.#packages.x86_64-linux.app^out']
					}
				],
				derivationToTargets: [],
				cohortPreFilter: [
					{
						key: 'cohort-x86_64-linux-ubuntu-latest-remote-5de0c136a0cc5dfe',
						pruned: false
					}
				]
			},
			outputs:
				`plan-file=${path.join(directory, 'cupboard-publish-plan.json')}\n` +
				'plan-artifact-name=cupboard-publish-plan-test\n' +
				'target-matrix={"include":[{"attr":".#packages.x86_64-linux.app","system":"x86_64-linux","os":"ubuntu-latest","remote":true,"bestEffort":false,"rootSuffix":"x86_64-linux/app","outputs":["out"],"root":"github:owner/repo/main/x86_64-linux/app","runsOn":"ubuntu-latest"}]}\n' +
				'cohort-matrix={"include":[{"key":"cohort-x86_64-linux-ubuntu-latest-remote-5de0c136a0cc5dfe","attrs":[".#packages.x86_64-linux.app"],"installables":[".#packages.x86_64-linux.app^out"],"queryInstallables":[null],"expectedPaths":[null],"system":"x86_64-linux","os":"ubuntu-latest","remote":true,"bestEffort":false,"runsOn":"ubuntu-latest","roots":["github:owner/repo/main/x86_64-linux/app"]}]}\n' +
				'cohort-count=1\n' +
				'retained-count=0\n' +
				'target-count=1\n'
		});
	});

	it.each([
		{
			name: 'a manifest of best-effort targets',
			targets: [
				{ ...target, bestEffort: true },
				{ ...secondTarget, bestEffort: true }
			],
			expected: [
				{ attrs: [target.attr], bestEffort: true },
				{ attrs: [secondTarget.attr], bestEffort: true }
			]
		},
		{
			name: 'a manifest that declares no tolerance at all',
			targets: [target, secondTarget],
			expected: [
				{ attrs: [target.attr], bestEffort: false },
				{ attrs: [secondTarget.attr], bestEffort: false }
			]
		}
	])(
		'sets bestEffort on each cohort matrix entry for $name',
		async ({ targets, expected }) => {
			const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));
			const output = path.join(directory, 'output');

			await planAction(
				{ ...baseOptions, targets: JSON.stringify(targets) },
				{
					RUNNER_TEMP: directory,
					GITHUB_RUN_ID: '12345',
					GITHUB_OUTPUT: output
				},
				undefined,
				{ createArtifactName: () => 'cupboard-publish-plan-test' }
			);

			expect(
				await cohortMatrixTolerance(path.join(directory, 'output'))
			).toStrictEqual(expected);
		}
	);

	it('rejects a shared cohort that mixes required and best-effort targets', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));

		await expect(
			planAction(
				{
					...baseOptions,
					targets: JSON.stringify([
						{ ...target, bestEffort: true, cohort: 'group-a' },
						{ ...secondTarget, bestEffort: false, cohort: 'group-a' }
					])
				},
				{
					RUNNER_TEMP: directory,
					GITHUB_RUN_ID: '12345'
				}
			)
		).rejects.toStrictEqual(
			new CohortFailureToleranceError('group-a', target.attr, secondTarget.attr)
		);
	});

	it('rejects an invalid optimisation input', async () => {
		await expect(
			planAction(
				{ ...baseOptions, optimise: 'perhaps' },
				{ RUNNER_TEMP: '/tmp', GITHUB_RUN_ID: '12345' }
			)
		).rejects.toThrow(BooleanInputInvalidError);
	});

	it.each([
		[
			'read-user is supplied without read-password',
			{ readUser: 'ci' },
			ReadPasswordRequiredError
		],
		[
			'read-password is supplied without read-user',
			{ readPassword: 'secret' },
			ReadUserRequiredError
		]
	])('rejects when %s', async (_name, overrides, errorType) => {
		await expect(
			planAction(
				{ ...baseOptions, ...overrides },
				{ RUNNER_TEMP: '/tmp', GITHUB_RUN_ID: '12345' }
			)
		).rejects.toThrow(errorType);
	});

	it.each([
		{
			name: 'queries the cache once when a cached target may be retained',
			requireProvenance: 'false',
			expectedUrls: ['https://cupboard.example/t/acme/api/v1/missing-paths']
		},
		{
			name: 'does not query the cache when require-provenance keeps every target on the build set',
			requireProvenance: 'true',
			expectedUrls: []
		}
	])('$name', async ({ requireProvenance, expectedUrls }) => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));
		const appStorePath = `/nix/store/${'1'.repeat(32)}-app`;
		const evaluator: NixEvaluator = () =>
			Promise.resolve({
				stdout: JSON.stringify({
					derivations: {
						[targetRootDrvPath]: {
							env: { out: appStorePath },
							inputs: { drvs: {} },
							outputs: { out: { path: `${'1'.repeat(32)}-app` } }
						}
					}
				})
			});
		const probe = recordingFetcher();

		await planAction(
			{ ...baseOptions, optimise: 'true', requireProvenance },
			{
				RUNNER_TEMP: directory,
				GITHUB_RUN_ID: '12345',
				GITHUB_OUTPUT: path.join(directory, 'output')
			},
			undefined,
			{
				evaluator,
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				fetcher: probe.fetcher,
				runner: preFilterRunner({})
			}
		);

		expect(probe.requestedUrls).toStrictEqual(expectedUrls);
	});
});

describe('resolvePlanInputs', () => {
	const environment = { RUNNER_TEMP: '/tmp', GITHUB_RUN_ID: '12345' };

	it('rejects a target whose root may receive too many outputs', () => {
		const outputs = Array.from(
			{ length: rootSetMaxTargets + 1 },
			(_, index) => `output-${String(index)}`
		);
		let failure: unknown;

		try {
			resolvePlanInputs(
				{
					...baseOptions,
					targets: JSON.stringify([{ ...target, outputs }])
				},
				environment
			);
		} catch (error) {
			failure = error;
		}

		expect(failure).toStrictEqual(
			new PublishRootTargetLimitError(
				target.attr,
				rootSetMaxTargets + 1,
				rootSetMaxTargets
			)
		);
	});

	it('rejects an aggregate declaring more components than a retention root accepts', () => {
		const components = Array.from(
			{ length: rootSetMaxTargets + 1 },
			(_, index) => ({ attr: `.#component-${String(index)}` })
		);
		let failure: unknown;

		try {
			resolvePlanInputs(
				{
					...baseOptions,
					targets: JSON.stringify([{ ...target, components }])
				},
				environment
			);
		} catch (error) {
			failure = error;
		}

		expect(failure).toStrictEqual(
			new ComponentRootTargetLimitError(
				target.attr,
				rootSetMaxTargets + 1,
				rootSetMaxTargets
			)
		);
	});

	it('expands a component-publication target before validating and planning', () => {
		const inputs = resolvePlanInputs(
			{
				...baseOptions,
				targets: JSON.stringify([
					{
						...target,
						components: [{ attr: '.#component-a' }, { attr: '.#component-b' }]
					}
				])
			},
			environment
		);

		expect(inputs.targets.map((entry) => entry.attr)).toStrictEqual([
			'.#component-a',
			'.#component-b'
		]);
		expect(
			inputs.targets.every((entry) => entry.rootSuffix === target.rootSuffix)
		).toBe(true);
	});

	it('preserves significant whitespace in both read credentials', () => {
		const inputs = resolvePlanInputs(
			{ ...baseOptions, readUser: ' alice ', readPassword: ' p w ' },
			environment
		);

		expect({
			readUser: inputs.readUser,
			readPassword: inputs.readPassword
		}).toStrictEqual({ readUser: ' alice ', readPassword: ' p w ' });
	});

	it('disables optimisation for a case-exact false', () => {
		expect(
			resolvePlanInputs({ ...baseOptions, optimise: 'false' }, environment)
				.optimise
		).toBe(false);
	});

	it('rejects when optimise is not true or false', () => {
		expect(() =>
			resolvePlanInputs({ ...baseOptions, optimise: 'False' }, environment)
		).toThrow(BooleanInputInvalidError);
	});
	it.each([
		[
			'the prefix contains a control character',
			{
				...baseOptions,
				rootPrefix: 'github:owner/repo/main\nother'
			},
			target.attr
		],
		[
			'a suffix contains a control character',
			{
				...baseOptions,
				targets: JSON.stringify([
					{ ...target, rootSuffix: 'x86_64-linux/app\nother' }
				])
			},
			target.attr
		],
		[
			'a later target makes the combined root too long',
			{
				...baseOptions,
				rootPrefix: 'p'.repeat(rootNameMaxLength - 16),
				targets: JSON.stringify([
					{ ...target, rootSuffix: 'app' },
					{
						...target,
						attr: '.#packages.x86_64-linux.other',
						rootSuffix: 's'.repeat(16)
					}
				])
			},
			'.#packages.x86_64-linux.other'
		]
	] as const)('rejects when %s', (_name, options, _attribute) => {
		expect(() => resolvePlanInputs(options, environment)).toThrow(
			RootNameInvalidError
		);
	});

	it('accepts a combined root at the maximum length', () => {
		const rootPrefix = 'p'.repeat(
			rootNameMaxLength - 1 - target.rootSuffix.length
		);

		expect(
			resolvePlanInputs({ ...baseOptions, rootPrefix }, environment).rootPrefix
		).toBe(rootPrefix);
	});

	it.each([
		['is not an http(s) URL', 'cupboard.example/t/acme'],
		['contains a fragment', 'https://cupboard.example/t/acme#copied']
	])('rejects when url %s', (_name, url) => {
		expect(() =>
			resolvePlanInputs({ ...baseOptions, url }, environment)
		).toThrow(UrlInputInvalidError);
	});

	it('leaves packing disabled and its capacity at zero by default', () => {
		const { enablePacking, packCapacity } = resolvePlanInputs(
			baseOptions,
			environment
		);

		expect({ enablePacking, packCapacity }).toStrictEqual({
			enablePacking: false,
			packCapacity: 0
		});
	});

	it('resolves a positive pack-capacity when packing is enabled', () => {
		const { enablePacking, packCapacity } = resolvePlanInputs(
			{
				...baseOptions,
				enablePacking: 'true',
				packCapacity: '1073741824'
			},
			environment
		);

		expect({ enablePacking, packCapacity }).toStrictEqual({
			enablePacking: true,
			packCapacity: 1_073_741_824
		});
	});

	it('rejects enabling packing without a pack-capacity', () => {
		expect(() =>
			resolvePlanInputs({ ...baseOptions, enablePacking: 'true' }, environment)
		).toThrow(new MissingInputError('pack-capacity'));
	});

	it.each([
		['zero', '0'],
		['negative', '-1'],
		['not an integer', '1.5'],
		['not a number', 'plenty']
	])('rejects a pack-capacity that is %s', (_name, packCapacity) => {
		expect(() =>
			resolvePlanInputs(
				{ ...baseOptions, enablePacking: 'true', packCapacity },
				environment
			)
		).toThrow(PackCapacityInvalidError);
	});
});

describe('validateRemoteOutputPredictability', () => {
	it('rejects a floating selected output before remote publication starts', () => {
		const floating = {
			...evaluation('floating', storePath(`/nix/store/${'4'.repeat(32)}-out`)),
			targetPaths: []
		};

		expect(() => {
			validateRemoteOutputPredictability('ssh-ng://builds.example', [floating]);
		}).toThrow(RemoteOutputPathUnknownDuringPlanningError);
	});

	it('rejects an unevaluated target before creating a remote cohort', () => {
		expect(() => {
			validateRemoteOutputPredictability(
				'ssh-ng://builds.example',
				[],
				['.#unevaluated']
			);
		}).toThrow(RemoteOutputPathUnknownDuringPlanningError);
	});

	it('accepts local publication and remote targets whose selected output paths are known', () => {
		const predictable = {
			...evaluation('multi', storePath(`/nix/store/${'5'.repeat(32)}-out`)),
			target: {
				...evaluation('multi', storePath(`/nix/store/${'5'.repeat(32)}-out`))
					.target,
				outputs: ['out', 'dev']
			},
			targetPaths: [
				storePath(`/nix/store/${'5'.repeat(32)}-out`),
				storePath(`/nix/store/${'6'.repeat(32)}-dev`)
			]
		};

		expect(() => {
			validateRemoteOutputPredictability('ssh-ng://builds.example', [
				predictable
			]);
		}).not.toThrow();
		expect(() => {
			validateRemoteOutputPredictability('', []);
		}).not.toThrow();
	});
});

describe('matrix', () => {
	const entry = { key: 'entry' };

	it.each(['target', 'cohort'])(
		'serialises a %s matrix at the job limit',
		(name) => {
			const entries = Array.from({ length: maximumMatrixJobs }, () => entry);

			expect(JSON.parse(matrix(name, entries))).toStrictEqual({
				include: entries
			});
		}
	);

	it.each(['target', 'cohort'])(
		'refuses a %s matrix beyond the job limit',
		(name) => {
			const entries = Array.from(
				{ length: maximumMatrixJobs + 1 },
				() => entry
			);

			expect(() => matrix(name, entries)).toThrow(MatrixJobLimitError);
		}
	);
});

describe('ensureAvailableTargets', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'cupboard-ensure-'));
	});

	it('wraps a runner launch failure in RootEnsureCommandError and preserves its cause', async () => {
		const value = storePath('/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app');
		const failure = new Error('spawn /missing/cupboard ENOENT');
		const runner: EnsureRunner = () => Promise.reject(failure);
		let thrown: unknown;

		try {
			await ensureAvailableTargets(
				planInputs({ temporaryDirectory: directory }),
				[evaluation('app', value)],
				new Set([value]),
				runner
			);
		} catch (error) {
			thrown = error;
		}

		const commandError =
			thrown instanceof RootEnsureCommandError ? thrown : undefined;

		expect({
			isCommandError: thrown instanceof RootEnsureCommandError,
			wasReported: commandError?.wasReported,
			cause: commandError?.cause
		}).toStrictEqual({
			isCommandError: true,
			wasReported: false,
			cause: failure
		});
	});

	it('passes the action signal to every root ensure runner invocation', async () => {
		const value = storePath('/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app');
		const controller = new AbortController();
		const signals: (AbortSignal | undefined)[] = [];
		const runner: EnsureRunner = async (_command, arguments_, signal) => {
			signals.push(signal);
			await writeFile(
				resultFileArgument(arguments_),
				retainedResultLine('github:owner/repo/main/app')
			);

			return { stdout: '', stderr: '' };
		};

		await ensureAvailableTargets(
			planInputs({ temporaryDirectory: directory }),
			[evaluation('app', value)],
			new Set([value]),
			runner,
			controller.signal
		);

		expect(signals).toStrictEqual([controller.signal]);
	});

	it('replays a failed child command and marks its workflow error as reported', async () => {
		const value = storePath('/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app');
		const failure = Object.assign(new Error('cupboard exited 1'), {
			stdout: '::group::Exchange GitHub token\n',
			stderr: '::error title=Tenant refused token::claim mismatch\n'
		});
		const stdout: unknown[] = [];
		const stderr: unknown[] = [];
		const stdoutWrite = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation((chunk: unknown) => {
				stdout.push(chunk);

				return true;
			});
		const stderrWrite = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation((chunk: unknown) => {
				stderr.push(chunk);

				return true;
			});
		let thrown: unknown;

		try {
			await ensureAvailableTargets(
				planInputs({ temporaryDirectory: directory }),
				[evaluation('app', value)],
				new Set([value]),
				() => Promise.reject(failure)
			);
		} catch (error) {
			thrown = error;
		} finally {
			stdoutWrite.mockRestore();
			stderrWrite.mockRestore();
		}

		const commandError =
			thrown instanceof RootEnsureCommandError ? thrown : undefined;

		expect({
			stdout,
			stderr,
			wasReported: commandError?.wasReported
		}).toStrictEqual({
			stdout: ['::group::Exchange GitHub token\n'],
			stderr: ['::error title=Tenant refused token::claim mismatch\n'],
			wasReported: true
		});
	});

	it('starts every cached target ensure before any of them resolves', async () => {
		const firstPath = storePath(`/nix/store/${'1'.repeat(32)}-first`);
		const secondPath = storePath(`/nix/store/${'2'.repeat(32)}-second`);
		const started: string[] = [];
		const pending = new Map<
			string,
			{ readonly resultFile: string; readonly resolve: () => void }
		>();
		const runner: EnsureRunner = (_command, arguments_) => {
			const root = ensureRootArgument(arguments_);
			started.push(root);

			return new Promise((resolve) => {
				pending.set(root, {
					resultFile: resultFileArgument(arguments_),
					resolve: () => {
						resolve({ stdout: '', stderr: '' });
					}
				});
			});
		};

		const retainedPromise = ensureAvailableTargets(
			planInputs({ temporaryDirectory: directory }),
			[evaluation('first', firstPath), evaluation('second', secondPath)],
			new Set([firstPath, secondPath]),
			runner
		);

		expect(
			started.toSorted((left, right) => left.localeCompare(right))
		).toStrictEqual([
			'github:owner/repo/main/first',
			'github:owner/repo/main/second'
		]);

		for (const [root, entry] of pending) {
			await writeFile(entry.resultFile, retainedResultLine(root));
			entry.resolve();
		}

		await expect(retainedPromise).resolves.toStrictEqual(
			new Set(['first', 'second'])
		);
	});

	it('returns only root suffixes with a retained ensure result', async () => {
		const retainedPath = storePath(`/nix/store/${'1'.repeat(32)}-first`);
		const buildRequiredPath = storePath(`/nix/store/${'2'.repeat(32)}-second`);
		const runner: EnsureRunner = async (_command, arguments_) => {
			const root = ensureRootArgument(arguments_);

			await writeFile(
				resultFileArgument(arguments_),
				root.endsWith('/first')
					? retainedResultLine(root)
					: buildRequiredResultLine([buildRequiredPath])
			);

			return { stdout: '', stderr: '' };
		};

		const retained = await ensureAvailableTargets(
			planInputs({ temporaryDirectory: directory }),
			[
				evaluation('first', retainedPath),
				evaluation('second', buildRequiredPath)
			],
			new Set([retainedPath, buildRequiredPath]),
			runner
		);

		expect(retained).toStrictEqual(new Set(['first']));
	});

	it('uses the same canonical root for retention and the target matrix', async () => {
		const value = storePath(`/nix/store/${'3'.repeat(32)}-app`);
		const ensured: string[] = [];
		const runner: EnsureRunner = async (_command, arguments_) => {
			const root = ensureRootArgument(arguments_);

			ensured.push(root);
			await writeFile(resultFileArgument(arguments_), retainedResultLine(root));

			return { stdout: '', stderr: '' };
		};

		const [parsed] = publishTargetsSchema.parse([
			{
				attr: '.#app',
				rootDrvPath: targetRootDrvPath,
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: true,
				rootSuffix: '/app'
			}
		]);

		if (parsed === undefined) {
			throw new Error('the manifest must parse to one target');
		}

		const inputs = planInputs({ temporaryDirectory: directory });

		await ensureAvailableTargets(
			inputs,
			[
				{
					target: parsed,
					rootDrvPath: '/nix/store/app.drv',
					nodes: new Map(),
					targetPaths: [value]
				}
			],
			new Set([value]),
			runner
		);

		expect({
			ensured,
			matrixRoot: joinRoot(inputs.rootPrefix, parsed.rootSuffix)
		}).toStrictEqual({
			ensured: ['github:owner/repo/main/app'],
			matrixRoot: 'github:owner/repo/main/app'
		});
	});

	it('raises RootEnsureResultMissingError when the runner records no result file', async () => {
		const value = storePath(`/nix/store/${'1'.repeat(32)}-app`);

		await expect(
			ensureAvailableTargets(
				planInputs({ temporaryDirectory: directory }),
				[evaluation('app', value)],
				new Set([value]),
				recordsNoResultRunner
			)
		).rejects.toThrow(RootEnsureResultMissingError);
	});

	it('raises RootEnsureResultMissingError when no root-ensure result is recorded', async () => {
		const value = storePath(`/nix/store/${'1'.repeat(32)}-app`);

		await expect(
			ensureAvailableTargets(
				planInputs({ temporaryDirectory: directory }),
				[evaluation('app', value)],
				new Set([value]),
				recordsOtherKindRunner
			)
		).rejects.toThrow(RootEnsureResultMissingError);
	});

	it.each([
		['the result line is not a result event', 'not a result event'],
		[
			'a retained result omits its root summary',
			JSON.stringify({ kind: 'root-ensure', data: { status: 'retained' } })
		],
		[
			'a build-required result contains no unavailable paths',
			JSON.stringify({
				kind: 'root-ensure',
				data: { status: 'build-required', unavailable: [] }
			})
		]
	])(
		'raises RootEnsureResultInvalidError when %s',
		async (_name, resultLine) => {
			const value = storePath(`/nix/store/${'1'.repeat(32)}-app`);
			const runner: EnsureRunner = async (_command, arguments_) => {
				await writeFile(resultFileArgument(arguments_), `${resultLine}\n`);

				return { stdout: '', stderr: '' };
			};

			await expect(
				ensureAvailableTargets(
					planInputs({ temporaryDirectory: directory }),
					[evaluation('app', value)],
					new Set([value]),
					runner
				)
			).rejects.toThrow(RootEnsureResultInvalidError);
		}
	);
});

function planInputs(overrides: Partial<PlanInputs> = {}): PlanInputs {
	return {
		targets: [],
		url: new URL('https://cupboard.example/t/acme'),
		cache: { kind: 'default' },
		rootPrefix: 'github:owner/repo/main',
		ttl: '',
		readUser: '',
		readPassword: '',
		audience: 'https://cupboard.example/t/acme',
		cupboardPath: '/unused/cupboard',
		planFile: '/unused/cupboard-publish-plan.json',
		optimise: true,
		temporaryDirectory: tmpdir(),
		enablePacking: false,
		packCapacity: 0,
		store: '',
		requireProvenance: false,
		...overrides
	};
}

function evaluation(
	rootSuffix: string,
	storePathValue: StorePathString
): TargetEvaluation {
	return {
		target: {
			attr: `.#${rootSuffix}`,
			rootDrvPath: targetRootDrvPath,
			system: 'x86_64-linux',
			os: 'ubuntu-latest',
			remote: true,
			bestEffort: true,
			rootSuffix,
			outputs: ['out']
		},
		rootDrvPath: `/nix/store/${rootSuffix}.drv`,
		nodes: new Map(),
		targetPaths: [storePathValue]
	};
}

const recordsNoResultRunner: EnsureRunner = () =>
	Promise.resolve({ stdout: '', stderr: '' });

const recordsOtherKindRunner: EnsureRunner = async (_command, arguments_) => {
	await writeFile(
		resultFileArgument(arguments_),
		`${JSON.stringify({ kind: 'root', data: {} })}\n`
	);

	return { stdout: '', stderr: '' };
};

function ensureRootArgument(arguments_: readonly string[]): string {
	const index = arguments_.indexOf('ensure');
	const root = arguments_.at(index + 2);

	if (root === undefined) {
		throw new Error('the ensure command did not include a root argument');
	}

	return root;
}

function resultFileArgument(arguments_: readonly string[]): string {
	const index = arguments_.indexOf('--result-file');
	const file = arguments_.at(index + 1);

	if (file === undefined) {
		throw new Error(
			'the ensure command did not include a result file argument'
		);
	}

	return file;
}

function retainedResultLine(name: string): string {
	return `${JSON.stringify({
		kind: 'root-ensure',
		data: {
			status: 'retained',
			root: {
				name,
				expired: false,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
				targets: [
					{
						storePathHash: '1'.repeat(32),
						storePath: `/nix/store/${'1'.repeat(32)}-app`,
						present: true
					}
				]
			}
		}
	})}\n`;
}

function buildRequiredResultLine(unavailable: readonly string[]): string {
	return `${JSON.stringify({
		kind: 'root-ensure',
		data: { status: 'build-required', unavailable }
	})}\n`;
}

const alwaysAvailableFetcher: typeof fetch = () =>
	Promise.resolve(Response.json({ missingStorePathHashes: [] }));

function recordingFetcher(): {
	readonly requestedUrls: readonly string[];
	readonly fetcher: typeof fetch;
} {
	const requestedUrls: string[] = [];

	return {
		requestedUrls,
		fetcher: (input) => {
			requestedUrls.push(input instanceof Request ? input.url : String(input));

			return Promise.resolve(Response.json({ missingStorePathHashes: [] }));
		}
	};
}

function rootCommandTarget(arguments_: readonly string[]): string {
	const index = arguments_.includes('targets')
		? arguments_.indexOf('targets')
		: arguments_.indexOf('ensure');
	const root = arguments_.at(index + 2);

	if (root === undefined) {
		throw new Error('the command did not include a root argument');
	}

	return root;
}

function rootTargetsResultLine(storePaths: readonly StorePathString[]): string {
	return `${JSON.stringify({
		kind: 'root-targets',
		data: storePaths.map((storePathValue, index) => ({
			storePathHash: String(index % 10).repeat(32),
			storePath: storePathValue,
			present: true
		}))
	})}\n`;
}

function preFilterRunner(options: {
	readonly targetsByRoot?: ReadonlyMap<string, readonly StorePathString[]>;
	readonly ensureRetainedRoots?: ReadonlySet<string>;
	readonly failTargetsForRoot?: string;
	readonly failEnsureForRoot?: string;
}): EnsureRunner {
	return async (_command, arguments_) => {
		const root = rootCommandTarget(arguments_);

		if (arguments_.includes('targets')) {
			if (options.failTargetsForRoot === root) {
				throw new Error('root targets failed');
			}

			await writeFile(
				resultFileArgument(arguments_),
				rootTargetsResultLine(options.targetsByRoot?.get(root) ?? [])
			);

			return { stdout: '', stderr: '' };
		}

		if (options.failEnsureForRoot === root) {
			throw new Error('root ensure failed');
		}

		await writeFile(
			resultFileArgument(arguments_),
			options.ensureRetainedRoots?.has(root) === true
				? retainedResultLine(root)
				: buildRequiredResultLine([`/nix/store/${'9'.repeat(32)}-unavailable`])
		);

		return { stdout: '', stderr: '' };
	};
}

function singleCohort(evaluations: readonly TargetEvaluation[]): Cohort {
	const targets = evaluations.map((entry) => entry.target);

	return {
		key: 'cohort-first',
		system: 'x86_64-linux',
		os: 'ubuntu-latest',
		remote: true,
		targets,
		installables: targets.map(
			(target) => `${target.attr}^${target.outputs.join(',')}`
		)
	};
}

describe('cohortPreFilter', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-cohort-prefilter-')
		);
	});

	const outPath = storePath(`/nix/store/${'1'.repeat(32)}-out`);
	const developmentPath = storePath(`/nix/store/${'2'.repeat(32)}-dev`);
	const changedPath = storePath(`/nix/store/${'3'.repeat(32)}-changed`);
	const firstRoot = 'github:owner/repo/main/first';

	it('propagates cancellation instead of recording it as an advisory failure', async () => {
		const first = evaluation('first', outPath);
		const controller = new AbortController();
		const reason = new Error('cancel cohort pre-filter');
		const runner: EnsureRunner = (_command, _arguments, signal) => {
			expect(signal).toBe(controller.signal);
			controller.abort(reason);

			return Promise.reject(reason);
		};

		await expect(
			cohortPreFilter(
				planInputs({ temporaryDirectory: directory }),
				{ cohorts: [singleCohort([first])] },
				[first],
				runner,
				controller.signal
			)
		).rejects.toBe(reason);
	});

	it('prunes a cohort whose member is fully covered by its reconciled list, and still refreshes its root', async () => {
		const ensuredRoots: string[] = [];
		const first = evaluation('first', outPath);
		const runner: EnsureRunner = async (_command, arguments_) => {
			if (arguments_.includes('targets')) {
				await writeFile(
					resultFileArgument(arguments_),
					rootTargetsResultLine([outPath])
				);
				return { stdout: '', stderr: '' };
			}

			const root = rootCommandTarget(arguments_);
			ensuredRoots.push(root);
			await writeFile(resultFileArgument(arguments_), retainedResultLine(root));
			return { stdout: '', stderr: '' };
		};

		const decisions = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [singleCohort([first])] },
			[first],
			runner
		);

		expect({ decisions, ensuredRoots }).toStrictEqual({
			decisions: [{ key: 'cohort-first', pruned: true }],
			ensuredRoots: [firstRoot]
		});
	});

	it('does not prune when the reconciled list is no longer fully retained', async () => {
		const first = evaluation('first', outPath);

		const decisions = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [singleCohort([first])] },
			[first],
			preFilterRunner({
				targetsByRoot: new Map([[firstRoot, [outPath]]]),
				ensureRetainedRoots: new Set()
			})
		);

		expect(decisions).toStrictEqual([{ key: 'cohort-first', pruned: false }]);
	});

	it('does not prune, and records a reason, when the ensure call fails', async () => {
		const first = evaluation('first', outPath);

		const decisions = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [singleCohort([first])] },
			[first],
			preFilterRunner({
				targetsByRoot: new Map([[firstRoot, [outPath]]]),
				failEnsureForRoot: firstRoot
			})
		);

		expect(decisions).toStrictEqual([
			{
				key: 'cohort-first',
				pruned: false,
				reason:
					'.#first: Could not ensure retention root github:owner/repo/main/first'
			}
		]);
	});

	it('does not prune, and records a reason, when reading the reconciled list fails', async () => {
		const first = evaluation('first', outPath);

		const decisions = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [singleCohort([first])] },
			[first],
			preFilterRunner({ failTargetsForRoot: firstRoot })
		);

		expect(decisions).toStrictEqual([
			{
				key: 'cohort-first',
				pruned: false,
				reason:
					'.#first: Could not read the reconciled targets of github:owner/repo/main/first'
			}
		]);
	});

	it('does not prune a target whose current output the reconciled list misses', async () => {
		const first = evaluation('first', changedPath);

		const decisions = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [singleCohort([first])] },
			[first],
			preFilterRunner({
				targetsByRoot: new Map([[firstRoot, [outPath]]]),
				ensureRetainedRoots: new Set([firstRoot])
			})
		);

		expect(decisions).toStrictEqual([{ key: 'cohort-first', pruned: false }]);
	});

	it('does not prune, and never ensures, a root with an empty reconciled list', async () => {
		const ensuredRoots: string[] = [];
		const first = evaluation('first', outPath);
		const runner: EnsureRunner = async (_command, arguments_) => {
			if (!arguments_.includes('targets')) {
				ensuredRoots.push(rootCommandTarget(arguments_));
				return { stdout: '', stderr: '' };
			}

			await writeFile(
				resultFileArgument(arguments_),
				rootTargetsResultLine([])
			);

			return { stdout: '', stderr: '' };
		};

		const decisions = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [singleCohort([first])] },
			[first],
			runner
		);

		expect({ decisions, ensuredRoots }).toStrictEqual({
			decisions: [{ key: 'cohort-first', pruned: false }],
			ensuredRoots: []
		});
	});

	it('never reads or ensures a target whose outputs are not all known, and always spawns it', async () => {
		const calls: string[] = [];
		const runner: EnsureRunner = (_command, arguments_) => {
			calls.push(rootCommandTarget(arguments_));
			return Promise.reject(new Error('should not be called'));
		};
		const unknownOutputTarget = {
			attr: '.#unknown',
			rootDrvPath: targetRootDrvPath,
			system: 'x86_64-linux',
			os: 'ubuntu-latest',
			remote: true,
			bestEffort: false,
			rootSuffix: 'unknown',
			outputs: ['out', 'dev']
		};
		const partiallyResolvedEvaluation: TargetEvaluation = {
			target: unknownOutputTarget,
			rootDrvPath: '/nix/store/unknown.drv',
			nodes: new Map(),
			targetPaths: [outPath]
		};

		const decisions = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [singleCohort([partiallyResolvedEvaluation])] },
			[partiallyResolvedEvaluation],
			runner
		);

		expect({ decisions, calls }).toStrictEqual({
			decisions: [{ key: 'cohort-first', pruned: false }],
			calls: []
		});
	});

	it('always spawns an unevaluated best-effort target', async () => {
		const unevaluatedTarget = {
			attr: '.#broken',
			system: 'x86_64-linux',
			os: 'ubuntu-latest',
			remote: true,
			bestEffort: true,
			rootSuffix: 'broken',
			outputs: ['out']
		};
		const cohort: Cohort = {
			key: 'cohort-broken',
			system: 'x86_64-linux',
			os: 'ubuntu-latest',
			remote: true,
			targets: [unevaluatedTarget],
			installables: ['.#broken^out']
		};

		const decisions = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [cohort] },
			[],
			() => Promise.reject(new Error('should not be called'))
		);

		expect(decisions).toStrictEqual([{ key: 'cohort-broken', pruned: false }]);
	});

	it('prunes a component-publication cohort only once every component is covered by the shared root', async () => {
		const componentA: TargetEvaluation = {
			target: {
				attr: '.#component-a',
				rootDrvPath: targetRootDrvPath,
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: true,
				bestEffort: true,
				rootSuffix: 'system',
				outputs: ['out']
			},
			rootDrvPath: '/nix/store/component-a.drv',
			nodes: new Map(),
			targetPaths: [outPath]
		};
		const componentB: TargetEvaluation = {
			target: { ...componentA.target, attr: '.#component-b' },
			rootDrvPath: '/nix/store/component-b.drv',
			nodes: new Map(),
			targetPaths: [developmentPath]
		};
		const systemRoot = 'github:owner/repo/main/system';
		const cohort = singleCohort([componentA, componentB]);

		const partiallyCovered = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [cohort] },
			[componentA, componentB],
			preFilterRunner({
				targetsByRoot: new Map([[systemRoot, [outPath]]]),
				ensureRetainedRoots: new Set([systemRoot])
			})
		);

		expect(partiallyCovered).toStrictEqual([
			{ key: 'cohort-first', pruned: false }
		]);

		const fullyCovered = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [cohort] },
			[componentA, componentB],
			preFilterRunner({
				targetsByRoot: new Map([[systemRoot, [outPath, developmentPath]]]),
				ensureRetainedRoots: new Set([systemRoot])
			})
		);

		expect(fullyCovered).toStrictEqual([{ key: 'cohort-first', pruned: true }]);
	});
});

describe('cohort-matrix output', () => {
	it('rebuilds a cached target whose root does not prove completed provenance', async () => {
		const planDirectory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));
		const appStorePath = `/nix/store/${'1'.repeat(32)}-app`;
		const appNode = {
			env: { out: appStorePath },
			inputs: { drvs: {} },
			outputs: { out: { path: `${'1'.repeat(32)}-app` } }
		};
		const evaluator: NixEvaluator = () =>
			Promise.resolve({
				stdout: JSON.stringify({
					derivations: { [targetRootDrvPath]: appNode }
				})
			});
		const recordedCalls: string[][] = [];
		const runner: EnsureRunner = async (_command, arguments_) => {
			recordedCalls.push([...arguments_]);

			if (!arguments_.includes('targets')) {
				throw new Error(
					'an unattested cached target must not be rooted by planning'
				);
			}

			await writeFile(
				resultFileArgument(arguments_),
				rootTargetsResultLine([])
			);

			return { stdout: '', stderr: '' };
		};

		await planAction(
			{ ...baseOptions, optimise: 'true', requireProvenance: 'true' },
			{
				GITHUB_RUN_ID: '12345',
				RUNNER_TEMP: planDirectory,
				GITHUB_OUTPUT: path.join(planDirectory, 'output')
			},
			undefined,
			{
				evaluator,
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				fetcher: alwaysAvailableFetcher,
				runner
			}
		);

		const outputs = await readFile(path.join(planDirectory, 'output'), 'utf8');

		expect({
			rootCommands: recordedCalls.map((arguments_) =>
				arguments_.includes('targets') ? 'targets' : 'ensure'
			),
			targetRetained: outputs.includes('target-matrix={"include":[]}'),
			cohortCount: outputs.includes('cohort-count=1\n')
		}).toStrictEqual({
			rootCommands: [],
			targetRetained: false,
			cohortCount: true
		});
	});

	it('excludes a pruned cohort from the emitted matrix and count, but not the target matrix', async () => {
		const planDirectory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));
		const appStorePath = `/nix/store/${'1'.repeat(32)}-app`;
		const appNode = {
			env: { out: appStorePath },
			inputs: { drvs: {} },
			outputs: { out: { path: `${'1'.repeat(32)}-app` } }
		};
		const evaluator: NixEvaluator = () =>
			Promise.resolve({
				stdout: JSON.stringify({
					derivations: { [targetRootDrvPath]: appNode }
				})
			});
		const runner: EnsureRunner = async (_command, arguments_) => {
			if (arguments_.includes('targets')) {
				await writeFile(
					resultFileArgument(arguments_),
					rootTargetsResultLine([storePath(appStorePath)])
				);
				return { stdout: '', stderr: '' };
			}

			const root = rootCommandTarget(arguments_);
			await writeFile(resultFileArgument(arguments_), retainedResultLine(root));
			return { stdout: '', stderr: '' };
		};

		await planAction(
			{ ...baseOptions, optimise: 'true' },
			{
				GITHUB_RUN_ID: '12345',
				RUNNER_TEMP: planDirectory,
				GITHUB_OUTPUT: path.join(planDirectory, 'output')
			},
			undefined,
			{
				evaluator,
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				fetcher: alwaysAvailableFetcher,
				runner
			}
		);

		const outputs = await readFile(path.join(planDirectory, 'output'), 'utf8');

		expect(outputs).toContain('target-matrix={"include":[]}\n');
		expect(outputs).toContain('cohort-matrix={"include":[]}\n');
		expect(outputs).toContain('cohort-count=0\n');
	});

	it('includes the evaluated expected path and derived installable in a surviving cohort', async () => {
		const planDirectory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));
		const appStorePath = `/nix/store/${'1'.repeat(32)}-app`;
		const appNode = {
			env: { out: appStorePath },
			inputs: { drvs: {} },
			outputs: { out: { path: `${'1'.repeat(32)}-app` } }
		};
		const evaluator: NixEvaluator = () =>
			Promise.resolve({
				stdout: JSON.stringify({
					derivations: { [targetRootDrvPath]: appNode }
				})
			});
		await planAction(
			{ ...baseOptions, optimise: 'true' },
			{
				GITHUB_RUN_ID: '12345',
				RUNNER_TEMP: planDirectory,
				GITHUB_OUTPUT: path.join(planDirectory, 'output')
			},
			undefined,
			{
				evaluator,
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				fetcher: alwaysAvailableFetcher,
				runner: preFilterRunner({})
			}
		);

		const outputs = await readFile(path.join(planDirectory, 'output'), 'utf8');

		expect(outputs).toContain(
			'cohort-matrix={"include":[{"key":"cohort-x86_64-linux-ubuntu-latest-remote-5de0c136a0cc5dfe",' +
				'"attrs":[".#packages.x86_64-linux.app"],' +
				'"installables":[".#packages.x86_64-linux.app^out"],' +
				`"queryInstallables":["${targetRootDrvPath}^out"],` +
				`"expectedPaths":["${appStorePath}"],` +
				'"system":"x86_64-linux","os":"ubuntu-latest","remote":true,"bestEffort":false,"runsOn":"ubuntu-latest",' +
				'"roots":["github:owner/repo/main/x86_64-linux/app"]}]}\n'
		);
		expect(outputs).toContain('cohort-count=1\n');
	});
});

describe('cohort packing', () => {
	const appAStorePath = storePath(`/nix/store/${'1'.repeat(32)}-app`);
	const targetB = {
		...target,
		attr: '.#packages.x86_64-linux.app-b',
		rootDrvPath: storePath(`/nix/store/${'2'.repeat(32)}-app-b.drv`),
		rootSuffix: 'x86_64-linux/app-b'
	};
	const appBStorePath = storePath(`/nix/store/${'2'.repeat(32)}-app-b`);

	const twoTargetEvaluator: NixEvaluator = () =>
		Promise.resolve({
			stdout: JSON.stringify({
				derivations: {
					[targetRootDrvPath]: {
						env: { out: appAStorePath },
						inputs: { drvs: {} },
						outputs: { out: { path: `${'1'.repeat(32)}-app` } }
					},
					[targetB.rootDrvPath]: {
						env: { out: appBStorePath },
						inputs: { drvs: {} },
						outputs: { out: { path: `${'2'.repeat(32)}-app-b` } }
					}
				}
			})
		});

	async function cohortAttributeGroups(
		planDirectory: string,
		options: Partial<PlanOptions>,
		measurer?: (
			cohorts: readonly Cohort[],
			evaluations: readonly TargetEvaluation[]
		) => Promise<ReadonlyMap<string, number>>,
		runner: EnsureRunner = preFilterRunner({})
	): Promise<readonly (readonly string[])[]> {
		await planAction(
			{
				...baseOptions,
				optimise: 'true',
				targets: JSON.stringify([target, targetB]),
				...options
			},
			{
				GITHUB_RUN_ID: '12345',
				RUNNER_TEMP: planDirectory,
				GITHUB_OUTPUT: path.join(planDirectory, 'output')
			},
			undefined,
			{
				evaluator: twoTargetEvaluator,
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				fetcher: alwaysAvailableFetcher,
				runner,
				...(measurer !== undefined && { measurer })
			}
		);

		const outputs = await readFile(path.join(planDirectory, 'output'), 'utf8');
		const cohortMatrixLine = outputs
			.split('\n')
			.find((line) => line.startsWith('cohort-matrix='));

		if (cohortMatrixLine === undefined) {
			throw new Error('no cohort-matrix output line was recorded');
		}

		const parsed = JSON.parse(
			cohortMatrixLine.slice('cohort-matrix='.length)
		) as { include: { attrs: readonly string[] }[] };

		return parsed.include.map((entry) =>
			entry.attrs.toSorted((left, right) => left.localeCompare(right))
		);
	}

	it('packs both surviving cohorts into one job when enabled and measured', async () => {
		const planDirectory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));
		const packCapacity = String(6 * 1024 ** 3);

		const groups = await cohortAttributeGroups(
			planDirectory,
			{ enablePacking: 'true', packCapacity },
			() =>
				Promise.resolve(
					new Map([
						[target.attr, 100],
						[targetB.attr, 200]
					])
				)
		);

		expect(groups).toStrictEqual([
			[target.attr, targetB.attr].toSorted((left, right) =>
				left.localeCompare(right)
			)
		]);
	});

	it('keeps the cohorts from the manifest when packing has no measurements', async () => {
		const planDirectory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));

		const groups = await cohortAttributeGroups(planDirectory, {
			enablePacking: 'true',
			packCapacity: '1000'
		});

		expect(groups).toStrictEqual([[target.attr], [targetB.attr]]);
	});

	it('does not call the measurer and keeps the cohorts from the manifest when packing is disabled', async () => {
		const planDirectory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));
		const measurer = vi.fn(() => Promise.resolve(new Map<string, number>()));

		const groups = await cohortAttributeGroups(planDirectory, {}, measurer);

		expect(measurer).not.toHaveBeenCalled();
		expect(groups).toStrictEqual([[target.attr], [targetB.attr]]);
	});

	it('uses the NAR sizes from plan measure when packing cohorts', async () => {
		const planDirectory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));
		const packCapacity = String(6 * 1024 ** 3);

		const groups = await cohortAttributeGroups(
			planDirectory,
			{ enablePacking: 'true', packCapacity },
			undefined,
			packingRunner({
				measurements: {
					[target.attr]: { downloadSize: 10, narSize: 100 },
					[targetB.attr]: { downloadSize: 20, narSize: 200 }
				}
			})
		);

		expect(groups).toStrictEqual([
			[target.attr, targetB.attr].toSorted((left, right) =>
				left.localeCompare(right)
			)
		]);
	});

	it('keeps the cohorts from the manifest and succeeds when measurement fails', async () => {
		const planDirectory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));

		const groups = await cohortAttributeGroups(
			planDirectory,
			{ enablePacking: 'true', packCapacity: String(6 * 1024 ** 3) },
			undefined,
			packingRunner({ failMeasure: true })
		);

		expect(groups).toStrictEqual([[target.attr], [targetB.attr]]);
	});
});

function measureResultLine(
	measurements: Readonly<
		Record<string, { downloadSize: number; narSize: number }>
	>
): string {
	return `${JSON.stringify({ kind: 'plan-measure', data: { measurements } })}\n`;
}

function packingRunner(options: {
	readonly measurements?: Readonly<
		Record<string, { downloadSize: number; narSize: number }>
	>;
	readonly failMeasure?: boolean;
}): EnsureRunner {
	const preFilter = preFilterRunner({});

	return async (command, arguments_) => {
		if (!arguments_.includes('measure')) {
			return preFilter(command, arguments_);
		}

		if (options.failMeasure === true) {
			throw new Error('cupboard exited 1');
		}

		await writeFile(
			resultFileArgument(arguments_),
			measureResultLine(options.measurements ?? {})
		);

		return { stdout: '', stderr: '' };
	};
}

function noop(): void {
	// Intentionally empty test callback.
}

const neverMeasuresRunner: EnsureRunner = () =>
	Promise.reject(new Error('the measure command must not run here'));

function warningReporter(warnings: string[]): Reporter {
	return {
		phase: (_label, body) => Promise.resolve(body({ fact: noop, warn: noop })),
		progress: (_label, _options, body) =>
			Promise.resolve(body({ advance: noop, fact: noop, warn: noop })),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message: noop,
					group: () => ({ message: noop, success: noop, error: noop }),
					warn: noop
				})
			),
		result: noop,
		data: noop,
		warn(label) {
			warnings.push(label);
		},
		info: noop,
		success: noop,
		step: noop,
		error: noop
	};
}

function argumentAfter(arguments_: readonly string[], flag: string): string {
	const value = arguments_.at(arguments_.indexOf(flag) + 1);

	if (value === undefined) {
		throw new Error(`the command did not include a ${flag} argument`);
	}

	return value;
}

describe('packingMeasurer', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'cupboard-measure-'));
	});

	const outPath = storePath(`/nix/store/${'1'.repeat(32)}-out`);
	const developmentPath = storePath(`/nix/store/${'2'.repeat(32)}-dev`);

	it('propagates cancellation instead of treating it as a best-effort measurement failure', async () => {
		const first = evaluation('first', outPath);
		const warnings: string[] = [];
		const controller = new AbortController();
		const reason = new Error('cancel packing measurement');
		const runner: EnsureRunner = (_command, _arguments, signal) => {
			expect(signal).toBe(controller.signal);
			controller.abort(reason);

			return Promise.reject(reason);
		};
		const measurer = packingMeasurer(
			planInputs({ temporaryDirectory: directory }),
			warningReporter(warnings),
			runner,
			controller.signal
		);

		await expect(measurer([singleCohort([first])], [first])).rejects.toBe(
			reason
		);
		expect(warnings).toStrictEqual([]);
	});

	it.each([
		{ name: "this runner's own store", store: '', storeArguments: [] },
		{
			name: 'the selected build store',
			store: 'ssh-ng://builds.example',
			storeArguments: ['--store', 'ssh-ng://builds.example']
		}
	])(
		'invokes plan measure for each evaluated target against $name and returns NAR sizes keyed by attr',
		async ({ store, storeArguments }) => {
			const first = evaluation('first', outPath);
			const second = evaluation('second', developmentPath);
			let recorded: string[] = [];
			const runner: EnsureRunner = async (command, arguments_) => {
				recorded = [command, ...arguments_];
				await writeFile(
					resultFileArgument(arguments_),
					measureResultLine({
						'.#first': { downloadSize: 10, narSize: 100 },
						'.#second': { downloadSize: 20, narSize: 200 }
					})
				);

				return { stdout: '', stderr: '' };
			};
			const measurer = packingMeasurer(
				planInputs({ temporaryDirectory: directory, store }),
				warningReporter([]),
				runner
			);

			const measurements = await measurer(
				[singleCohort([first]), singleCohort([second])],
				[first, second]
			);

			expect(measurements).toStrictEqual(
				new Map([
					['.#first', 100],
					['.#second', 200]
				])
			);
			expect(recorded).toStrictEqual([
				'/unused/cupboard',
				'--output-mode',
				'github',
				'--no-colour',
				'--result-file',
				resultFileArgument(recorded.slice(1)),
				'plan',
				'measure',
				'--targets-file',
				argumentAfter(recorded, '--targets-file'),
				'--measure-file',
				argumentAfter(recorded, '--measure-file'),
				...storeArguments
			]);
			const writtenTargets = await readFile(
				argumentAfter(recorded, '--targets-file'),
				'utf8'
			);

			expect(JSON.parse(writtenTargets)).toStrictEqual({
				targets: [
					{ attr: '.#first', installable: '/nix/store/first.drv^out' },
					{ attr: '.#second', installable: '/nix/store/second.drv^out' }
				]
			});
		}
	);

	it('never runs the command when no cohort target has an evaluated installable', async () => {
		const first = evaluation('first', outPath);
		const measurer = packingMeasurer(
			planInputs({ temporaryDirectory: directory }),
			warningReporter([]),
			neverMeasuresRunner
		);

		const measurements = await measurer([singleCohort([first])], []);

		expect(measurements).toStrictEqual(new Map());
	});

	it.each([
		[
			'the command fails',
			(() =>
				Promise.reject(new Error('cupboard exited 1'))) satisfies EnsureRunner
		],
		[
			'the run records no result',
			((_command: string, _arguments: readonly string[]) =>
				Promise.resolve({ stdout: '', stderr: '' })) satisfies EnsureRunner
		],
		[
			'the recorded result is invalid',
			(async (_command: string, arguments_: readonly string[]) => {
				await writeFile(resultFileArgument(arguments_), 'not a result event\n');

				return { stdout: '', stderr: '' };
			}) satisfies EnsureRunner
		]
	])('yields no sizes, and warns, when %s', async (_name, runner) => {
		const first = evaluation('first', outPath);
		const warnings: string[] = [];
		const measurer = packingMeasurer(
			planInputs({ temporaryDirectory: directory }),
			warningReporter(warnings),
			runner
		);

		const measurements = await measurer([singleCohort([first])], [first]);

		expect({ measurements, warningCount: warnings.length }).toStrictEqual({
			measurements: new Map(),
			warningCount: 1
		});
	});
});
