import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	rootNameMaxLength,
	storedCacheSchema,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import type { ParsedBuildReceipt } from '@cupboard/protocol/build';
import { rootSetMaxTargets } from '@cupboard/protocol/retention';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	ConfirmCommandError,
	ConfirmResultInvalidError,
	ConfirmResultMissingError,
	GraceCoverageCommandError,
	GraceCoverageResultInvalidError,
	GraceCoverageResultMissingError,
	GraceDeadlineMissingError,
	GracePolicyMissingError,
	IntermediateRootInvalidError,
	InvalidInputError,
	MatrixJobLimitError,
	PublishRootTargetLimitError,
	RootEnsureCommandError,
	RootEnsureResultInvalidError,
	RootEnsureResultMissingError,
	ZeroGracePolicyError
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
	confirmDestinationIntermediates,
	ensureAvailableTargets,
	type EnsureRunner,
	fallbackMatrix,
	groupRetention,
	matrix,
	maximumMatrixJobs,
	planAction,
	type PlanInputs,
	type PlanOptions,
	resolvePlanInputs,
	seedMatrix,
	validateIntermediateRootTargetLimits,
	verifyGraceCoverage
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
				seedGroups: [],
				fallbackGroups: [],
				destinationIntermediates: [],
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
				'seed-matrix={"include":[]}\n' +
				'target-matrix={"include":[{"attr":".#packages.x86_64-linux.app","system":"x86_64-linux","os":"ubuntu-latest","remote":true,"bestEffort":false,"rootSuffix":"x86_64-linux/app","outputs":["out"],"root":"github:owner/repo/main/x86_64-linux/app","runsOn":"ubuntu-latest"}]}\n' +
				'fallback-matrix={"include":[]}\n' +
				'cohort-matrix={"include":[{"key":"cohort-x86_64-linux-ubuntu-latest-remote-5de0c136a0cc5dfe","attrs":[".#packages.x86_64-linux.app"],"installables":[".#packages.x86_64-linux.app^out"],"system":"x86_64-linux","os":"ubuntu-latest","remote":true,"runsOn":"ubuntu-latest","roots":["github:owner/repo/main/x86_64-linux/app"]}]}\n' +
				'cohort-count=1\n' +
				'retained-count=0\n' +
				'seed-count=0\n' +
				'target-count=1\n' +
				'fallback-count=0\n'
		});
	});

	it('rejects an invalid optimisation input', async () => {
		await expect(
			planAction(
				{ ...baseOptions, optimise: 'perhaps' },
				{ RUNNER_TEMP: '/tmp', GITHUB_RUN_ID: '12345' }
			)
		).rejects.toThrow(InvalidInputError);
	});

	it('rejects an unknown intermediate-retention value', async () => {
		await expect(
			planAction(
				{ ...baseOptions, intermediateRetention: 'pins' },
				{ RUNNER_TEMP: '/tmp', GITHUB_RUN_ID: '12345' }
			)
		).rejects.toThrow(InvalidInputError);
	});

	it.each([
		['read-user is supplied without read-password', { readUser: 'ci' }],
		['read-password is supplied without read-user', { readPassword: 'secret' }]
	])('rejects when %s', async (_name, overrides) => {
		await expect(
			planAction(
				{ ...baseOptions, ...overrides },
				{ RUNNER_TEMP: '/tmp', GITHUB_RUN_ID: '12345' }
			)
		).rejects.toThrow(InvalidInputError);
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
				'target',
				target.attr,
				rootSetMaxTargets + 1,
				rootSetMaxTargets
			)
		);
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

	// `isEnabled` accepts only the exact spellings `true` and `false`, so a
	// case variant is a mistyped workflow value rather than a synonym.
	it('rejects when optimise is not true or false', () => {
		expect(() =>
			resolvePlanInputs({ ...baseOptions, optimise: 'False' }, environment)
		).toThrow(InvalidInputError);
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
	] as const)('rejects when %s', (_name, options, attribute) => {
		let failure: unknown;

		try {
			resolvePlanInputs(options, environment);
		} catch (error) {
			failure = error;
		}

		expect(failure).toStrictEqual(
			new InvalidInputError(
				'root-prefix',
				`root-prefix and rootSuffix for ${attribute} must form a root name of at most ${String(rootNameMaxLength)} characters without control characters`
			)
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
		['carries a fragment', 'https://cupboard.example/t/acme#copied']
	])('rejects when url %s', (_name, url) => {
		expect(() =>
			resolvePlanInputs({ ...baseOptions, url }, environment)
		).toThrow(InvalidInputError);
	});

	it('does not reproduce a rejected URL in its diagnostic', () => {
		const secret = 'read-token';
		let failure: unknown;

		try {
			resolvePlanInputs(
				{
					...baseOptions,
					url: `https://cupboard.example/t/acme?token=${secret}`
				},
				environment
			);
		} catch (error) {
			failure = error;
		}

		expect(failure).toStrictEqual(
			new InvalidInputError(
				'url',
				'url must be an http(s) URL with nothing beyond origin and path'
			)
		);
		expect((failure as Error).message).not.toContain(secret);
	});

	it('retains intermediates by grace when asked', () => {
		expect(
			resolvePlanInputs(
				{ ...baseOptions, intermediateRetention: 'grace' },
				environment
			).intermediateRetention
		).toBe('grace');
	});

	it('rejects when intermediate-retention is not root or grace', () => {
		expect(() =>
			resolvePlanInputs(
				{ ...baseOptions, intermediateRetention: 'rootish' },
				environment
			)
		).toThrow(InvalidInputError);
	});
});

describe('intermediate root target limits', () => {
	const pathValue = storePath(
		`/nix/store/${'0'.repeat(32)}-shared-intermediate`
	);
	const seedPlan = {
		seedGroups: [
			{
				key: 'seed-x86_64-linux',
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: false,
				targets: ['.#app'],
				candidates: Array.from(
					{ length: rootSetMaxTargets + 1 },
					(_, index) => ({
						drvPath: `/nix/store/intermediate-${String(index)}.drv`,
						output: 'out',
						path: pathValue
					})
				)
			}
		],
		fallbackGroups: []
	};
	const fallbackTargets = publishTargetsSchema.parse([
		{
			...target,
			outputs: Array.from(
				{ length: Math.floor(rootSetMaxTargets / 2) + 1 },
				(_, index) => `first-${String(index)}`
			)
		},
		{
			...target,
			attr: '.#packages.x86_64-linux.other',
			rootSuffix: 'x86_64-linux/other',
			outputs: Array.from(
				{ length: Math.ceil(rootSetMaxTargets / 2) },
				(_, index) => `second-${String(index)}`
			)
		}
	]);
	const fallbackPlan = {
		seedGroups: [],
		fallbackGroups: [
			{
				key: 'fallback-x86_64-linux-1',
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: false,
				targets: fallbackTargets
			}
		]
	};

	it.each([
		{
			kind: 'seed group' as const,
			identifier: 'seed-x86_64-linux',
			plan: seedPlan
		},
		{
			kind: 'fallback group' as const,
			identifier: 'fallback-x86_64-linux-1',
			plan: fallbackPlan
		}
	])(
		'rejects an oversized root-retained $kind',
		({ kind, identifier, plan }) => {
			let failure: unknown;

			try {
				validateIntermediateRootTargetLimits(
					{ intermediateRetention: 'root' },
					plan
				);
			} catch (error) {
				failure = error;
			}

			expect(failure).toStrictEqual(
				new PublishRootTargetLimitError(
					kind,
					identifier,
					rootSetMaxTargets + 1,
					rootSetMaxTargets
				)
			);
		}
	);

	it.each([seedPlan, fallbackPlan])(
		'accepts an oversized intermediate group retained by grace',
		(plan) => {
			expect(() => {
				validateIntermediateRootTargetLimits(
					{ intermediateRetention: 'grace' },
					plan
				);
			}).not.toThrow();
		}
	);
});

describe('matrix', () => {
	const entry = { key: 'entry' };

	it.each(['seed', 'target', 'fallback'])(
		'serialises a %s matrix at the job limit',
		(name) => {
			const entries = Array.from({ length: maximumMatrixJobs }, () => entry);

			expect(JSON.parse(matrix(name, entries))).toStrictEqual({
				include: entries
			});
		}
	);

	it.each(['seed', 'target', 'fallback'])(
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

	it('maps a runner launch failure to a RootEnsureCommandError carrying its cause', async () => {
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

	it('collects only the rootSuffixes whose ensure result is retained', async () => {
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

	// A manifest may spell a suffix with a leading slash; the parse
	// canonicalises it, and the ensure call and the push matrix construct the
	// root from that one canonical suffix, so both name the identical root.
	it('ensures the exact root the push matrix carries for a slashed spelling', async () => {
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
			'a build-required result names no unavailable paths',
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

describe('confirmDestinationIntermediates', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'cupboard-confirm-'));
	});

	const intermediates = [
		storePath(`/nix/store/${'1'.repeat(32)}-shared`),
		storePath(`/nix/store/${'2'.repeat(32)}-tools`)
	];

	it('confirms every intermediate in one command and passes on deadlines', async () => {
		let recorded: string[] = [];
		const runner: EnsureRunner = async (command, arguments_) => {
			recorded = [command, ...arguments_];
			await writeFile(
				resultFileArgument(arguments_),
				confirmedPathsResultLine([
					{
						storePathHash: '1'.repeat(32),
						confirmed: true,
						grace: { retainUntil: '2026-01-02T00:00:00.000Z' }
					},
					{
						storePathHash: '2'.repeat(32),
						confirmed: true,
						grace: { retainUntil: '2026-01-02T00:00:00.000Z' }
					}
				])
			);

			return { stdout: '', stderr: '' };
		};

		await confirmDestinationIntermediates(
			planInputs({
				cache: storedCacheSchema.parse('builds'),
				intermediateRetention: 'grace',
				temporaryDirectory: directory
			}),
			intermediates,
			runner
		);

		expect(recorded).toStrictEqual([
			'/unused/cupboard',
			'--output-mode',
			'github',
			'--no-colour',
			'--result-file',
			resultFileArgument(recorded.slice(1)),
			'confirm',
			'https://cupboard.example/t/acme',
			...intermediates,
			'--github-oidc',
			'--audience',
			'https://cupboard.example/t/acme',
			'--cache',
			'builds'
		]);
	});

	it('runs no command when there is nothing to confirm', async () => {
		const calls: string[][] = [];
		const runner: EnsureRunner = (command, arguments_) => {
			calls.push([command, ...arguments_]);
			return Promise.resolve({ stdout: '', stderr: '' });
		};

		await confirmDestinationIntermediates(
			planInputs({ temporaryDirectory: directory }),
			[],
			runner
		);

		expect(calls).toStrictEqual([]);
	});

	// A confirmed path with no grace fact means the cache lost its covering
	// policy: the cache-level error names the remedy, not a per-path reason.
	it('fails closed with the cache-level error when a confirmed path has no fact', async () => {
		const runner = confirmResultRunner([
			{ storePathHash: '1'.repeat(32), confirmed: true, grace: {} }
		]);

		await expect(
			confirmDestinationIntermediates(
				planInputs({ temporaryDirectory: directory }),
				intermediates,
				runner
			)
		).rejects.toBeInstanceOf(GracePolicyMissingError);
	});

	// A confirmed path whose fact names a zero-grace policy is a different
	// condition from no policy at all, and its remedy is raising the value.
	it('fails closed with the zero-grace error when the matched policy grants nothing', async () => {
		const runner = confirmResultRunner([
			{
				storePathHash: '1'.repeat(32),
				confirmed: true,
				grace: { graceSeconds: 0 }
			}
		]);

		await expect(
			confirmDestinationIntermediates(
				planInputs({ temporaryDirectory: directory }),
				intermediates,
				runner
			)
		).rejects.toBeInstanceOf(ZeroGracePolicyError);
	});

	// The real CLI records the result and then exits non-zero for an
	// unconfirmed path, so the classification must read the recorded result
	// out of the failed run.
	it('fails closed on a path no longer committed at the destination', async () => {
		let failure: unknown;

		try {
			const runner = confirmResultRunner(
				[{ storePathHash: '1'.repeat(32), confirmed: false }],
				{ fails: true }
			);

			await confirmDestinationIntermediates(
				planInputs({ temporaryDirectory: directory }),
				intermediates,
				runner
			);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(GraceDeadlineMissingError);

		if (failure instanceof GraceDeadlineMissingError) {
			expect(failure.paths).toStrictEqual([
				{ storePathHash: '1'.repeat(32), reason: 'not-present' }
			]);
		}
	});

	it('keeps a failure whose recorded result names nothing missing as a command error', async () => {
		const runner = confirmResultRunner(
			[
				{
					storePathHash: '1'.repeat(32),
					confirmed: true,
					grace: { retainUntil: '2026-01-02T00:00:00.000Z' }
				}
			],
			{ fails: true }
		);

		await expect(
			confirmDestinationIntermediates(
				planInputs({ temporaryDirectory: directory }),
				intermediates,
				runner
			)
		).rejects.toBeInstanceOf(ConfirmCommandError);
	});

	it('maps a runner launch failure to a ConfirmCommandError carrying its cause', async () => {
		const failure = new Error('spawn /missing/cupboard ENOENT');
		const runner: EnsureRunner = () => Promise.reject(failure);
		let thrown: unknown;

		try {
			await confirmDestinationIntermediates(
				planInputs({ temporaryDirectory: directory }),
				intermediates,
				runner
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ConfirmCommandError);

		if (thrown instanceof ConfirmCommandError) {
			expect(thrown.cause).toBe(failure);
		}
	});

	it('rejects a run that records no confirmation result', async () => {
		await expect(
			confirmDestinationIntermediates(
				planInputs({ temporaryDirectory: directory }),
				intermediates,
				resultFreeRunner
			)
		).rejects.toBeInstanceOf(ConfirmResultMissingError);
	});

	it('rejects a recorded result of a different kind as missing', async () => {
		await expect(
			confirmDestinationIntermediates(
				planInputs({ temporaryDirectory: directory }),
				intermediates,
				foreignKindRunner
			)
		).rejects.toBeInstanceOf(ConfirmResultMissingError);
	});

	it.each([
		['a malformed result line', 'not json\n'],
		[
			'confirmation data the schema refuses',
			`${JSON.stringify({ kind: 'confirm-paths', data: { paths: 'all' } })}\n`
		]
	])('rejects %s as invalid', async (_name, line) => {
		const runner: EnsureRunner = async (_command, arguments_) => {
			await writeFile(resultFileArgument(arguments_), line);

			return { stdout: '', stderr: '' };
		};

		await expect(
			confirmDestinationIntermediates(
				planInputs({ temporaryDirectory: directory }),
				intermediates,
				runner
			)
		).rejects.toBeInstanceOf(ConfirmResultInvalidError);
	});
});

function planInputs(overrides: Partial<PlanInputs> = {}): PlanInputs {
	return {
		targets: [],
		url: new URL('https://cupboard.example/t/acme'),
		cache: '',
		rootPrefix: 'github:owner/repo/main',
		ttl: '',
		readUser: '',
		readPassword: '',
		audience: 'https://cupboard.example/t/acme',
		cupboardPath: '/unused/cupboard',
		planFile: '/unused/cupboard-publish-plan.json',
		optimise: true,
		intermediateRetention: 'root',
		reuseView: '',
		runId: '12345',
		temporaryDirectory: tmpdir(),
		...overrides
	};
}

function resultFreeRunner(): Promise<{ stdout: string; stderr: string }> {
	return Promise.resolve({ stdout: '', stderr: '' });
}

async function foreignKindRunner(
	_command: string,
	arguments_: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
	await writeFile(
		resultFileArgument(arguments_),
		`${JSON.stringify({ kind: 'push-summary', data: {} })}\n`
	);

	return { stdout: '', stderr: '' };
}

// The seed and fallback pushes publish with exactly what their matrix entry
// carries, so the four combinations of retention mode and reuse view are
// decided and proven here; the workflow yml interpolates these values without
// conditionals. An adoption group (a view-only shared output joining an
// `adopt-` keyed seed group) follows the same retention as any other group:
// the reuse view never affects what the destination retains.
describe('seed and fallback retention wiring', () => {
	const seedGroup = {
		key: 'x86_64-linux',
		system: 'x86_64-linux',
		os: 'ubuntu-latest',
		remote: false,
		targets: [storePath(`/nix/store/${'0'.repeat(32)}-app`)],
		candidates: []
	};
	const adoptionGroup = {
		...seedGroup,
		key: 'adopt-x86_64-linux'
	};
	const fallbackGroup = {
		key: 'fallback-x86_64-linux',
		system: 'x86_64-linux',
		os: 'ubuntu-latest',
		remote: false,
		targets: []
	};

	it.each([
		{
			retention: 'root' as const,
			reuseView: '',
			expected: {
				root: 'github:owner/repo/main/_cupboard-seed/12345/x86_64-linux',
				ttl: '24h',
				noRetain: false,
				requireGrace: false
			}
		},
		{
			retention: 'root' as const,
			reuseView: 'pr',
			expected: {
				root: 'github:owner/repo/main/_cupboard-seed/12345/x86_64-linux',
				ttl: '24h',
				noRetain: false,
				requireGrace: false
			}
		},
		{
			retention: 'grace' as const,
			reuseView: '',
			expected: { root: '', ttl: '', noRetain: true, requireGrace: true }
		},
		{
			retention: 'grace' as const,
			reuseView: 'pr',
			expected: { root: '', ttl: '', noRetain: true, requireGrace: true }
		}
	])(
		'decides $retention retention with reuse view "$reuseView"',
		({ retention, reuseView, expected }) => {
			const inputs = planInputs({
				intermediateRetention: retention,
				reuseView
			});
			const groups =
				reuseView === '' ? [seedGroup] : [seedGroup, adoptionGroup];
			const plan = {
				retained: [],
				targets: [],
				seedGroups: groups,
				fallbackGroups: [fallbackGroup],
				destinationIntermediates: []
			};
			const adoptionRoot =
				retention === 'root'
					? {
							...expected,
							root: 'github:owner/repo/main/_cupboard-seed/12345/adopt-x86_64-linux'
						}
					: expected;
			const fallbackRoot =
				retention === 'root'
					? {
							...expected,
							root: 'github:owner/repo/main/_cupboard-seed/12345/fallback-x86_64-linux'
						}
					: expected;

			expect({
				seed: seedMatrix(inputs, plan),
				fallback: fallbackMatrix(inputs, plan)
			}).toStrictEqual({
				seed:
					reuseView === ''
						? [groupEntry('x86_64-linux', expected)]
						: [
								groupEntry('x86_64-linux', expected),
								groupEntry('adopt-x86_64-linux', adoptionRoot)
							],
				fallback: [groupEntry('fallback-x86_64-linux', fallbackRoot)]
			});
		}
	);

	it.each([
		[
			'a generated root is too long',
			planInputs({
				rootPrefix: 'p'.repeat(rootNameMaxLength - 1 - target.rootSuffix.length)
			}),
			'seed-x86_64-linux-ubuntu-latest-local-1234567890123456'
		],
		[
			'a generated root contains a control character',
			planInputs(),
			'seed-x86_64-linux\nother'
		]
	] as const)('rejects when %s', (_name, inputs, key) => {
		expect(() => groupRetention(inputs, key)).toThrow(
			new IntermediateRootInvalidError(rootNameMaxLength)
		);
	});
});

function groupEntry(key: string, retentionValues: object): object {
	return {
		key,
		system: 'x86_64-linux',
		os: 'ubuntu-latest',
		remote: false,
		runsOn: 'ubuntu-latest',
		...retentionValues
	};
}

function confirmResultRunner(
	paths: readonly {
		readonly storePathHash: string;
		readonly confirmed: boolean;
		readonly grace?: {
			readonly retainUntil?: string;
			readonly graceSeconds?: number;
		};
	}[],
	options: { readonly fails?: boolean } = {}
): EnsureRunner {
	return async (_command, arguments_) => {
		await writeFile(
			resultFileArgument(arguments_),
			confirmedPathsResultLine(paths)
		);

		if (options.fails === true) {
			throw new Error('cupboard exited 1');
		}

		return { stdout: '', stderr: '' };
	};
}

function confirmedPathsResultLine(
	paths: readonly {
		readonly storePathHash: string;
		readonly confirmed: boolean;
		readonly grace?: {
			readonly retainUntil?: string;
			readonly graceSeconds?: number;
		};
	}[]
): string {
	return `${JSON.stringify({ kind: 'confirm-paths', data: { paths } })}\n`;
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
		throw new Error('the ensure command did not carry a root argument');
	}

	return root;
}

function resultFileArgument(arguments_: readonly string[]): string {
	const index = arguments_.indexOf('--result-file');
	const file = arguments_.at(index + 1);

	if (file === undefined) {
		throw new Error('the ensure command did not carry a result file argument');
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

function graceCoverageResultLine(data: unknown): string {
	return `${JSON.stringify({ kind: 'grace-coverage', data })}\n`;
}

function coverageRunner(
	data: unknown
): (
	command: string,
	arguments_: readonly string[]
) => Promise<{ stdout: string; stderr: string }> {
	return async (_command, arguments_) => {
		await writeFile(
			resultFileArgument(arguments_),
			graceCoverageResultLine(data)
		);

		return { stdout: '', stderr: '' };
	};
}

describe('verifyGraceCoverage', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'cupboard-coverage-'));
	});

	it('passes a covered destination and threads the cache flag', async () => {
		let recorded: string[] = [];
		const runner: EnsureRunner = async (command, arguments_) => {
			recorded = [command, ...arguments_];
			await writeFile(
				resultFileArgument(arguments_),
				graceCoverageResultLine({ covered: true, graceSeconds: 86_400 })
			);

			return { stdout: '', stderr: '' };
		};

		await verifyGraceCoverage(
			planInputs({
				cache: storedCacheSchema.parse('builds'),
				intermediateRetention: 'grace',
				temporaryDirectory: directory
			}),
			runner
		);

		expect(recorded).toStrictEqual([
			'/unused/cupboard',
			'--output-mode',
			'github',
			'--no-colour',
			'--result-file',
			resultFileArgument(recorded.slice(1)),
			'policy',
			'grace-coverage',
			'https://cupboard.example/t/acme',
			'--github-oidc',
			'--audience',
			'https://cupboard.example/t/acme',
			'--cache',
			'builds'
		]);
	});

	it('refuses an uncovered destination before anything is published', async () => {
		await expect(
			verifyGraceCoverage(
				planInputs({
					intermediateRetention: 'grace',
					temporaryDirectory: directory
				}),
				coverageRunner({ covered: false })
			)
		).rejects.toBeInstanceOf(GracePolicyMissingError);
	});

	it('refuses an uncovered cache before any retention root is ensured', async () => {
		const planDirectory = await mkdtemp(path.join(tmpdir(), 'cupboard-plan-'));
		const commands: string[] = [];
		const runner: EnsureRunner = async (command, arguments_) => {
			commands.push(arguments_[arguments_.indexOf('--result-file') + 3] ?? '');
			await writeFile(
				resultFileArgument(arguments_),
				graceCoverageResultLine({ covered: false })
			);

			return { stdout: '', stderr: '' };
		};
		const appNode = {
			env: { out: `/nix/store/${'1'.repeat(32)}-app` },
			inputs: { drvs: {} },
			outputs: { out: { path: `${'1'.repeat(32)}-app` } }
		};
		const evaluator: NixEvaluator = () =>
			Promise.resolve({
				stdout: JSON.stringify({
					derivations: { [targetRootDrvPath]: appNode }
				})
			});

		// Every probe answers 200, so the target counts as fully cached and a
		// reachable ensure pass would have called `root ensure` for it.
		await expect(
			planAction(
				{
					...baseOptions,
					optimise: 'true',
					intermediateRetention: 'grace'
				},
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
			)
		).rejects.toBeInstanceOf(GracePolicyMissingError);

		expect(commands).toStrictEqual(['grace-coverage']);
	});

	it('refuses a covering policy whose grace is zero', async () => {
		await expect(
			verifyGraceCoverage(
				planInputs({
					intermediateRetention: 'grace',
					temporaryDirectory: directory
				}),
				coverageRunner({ covered: true, graceSeconds: 0 })
			)
		).rejects.toBeInstanceOf(ZeroGracePolicyError);
	});

	it('wraps a failing coverage command', async () => {
		const failure = new Error('spawn /missing/cupboard ENOENT');
		let thrown: unknown;

		try {
			await verifyGraceCoverage(
				planInputs({
					intermediateRetention: 'grace',
					temporaryDirectory: directory
				}),
				() => Promise.reject(failure)
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(GraceCoverageCommandError);

		if (thrown instanceof GraceCoverageCommandError) {
			expect(thrown.cause).toBe(failure);
		}
	});

	it('rejects a run that records no coverage result', async () => {
		await expect(
			verifyGraceCoverage(
				planInputs({
					intermediateRetention: 'grace',
					temporaryDirectory: directory
				}),
				resultFreeRunner
			)
		).rejects.toBeInstanceOf(GraceCoverageResultMissingError);
	});

	it('rejects coverage data the schema refuses as invalid', async () => {
		await expect(
			verifyGraceCoverage(
				planInputs({
					intermediateRetention: 'grace',
					temporaryDirectory: directory
				}),
				coverageRunner({ covered: 'maybe' })
			)
		).rejects.toBeInstanceOf(GraceCoverageResultInvalidError);
	});
});

// Every command the pre-filter issues carries either 'targets' or 'ensure' at
// the same position `root ensure`'s own argument list already uses, so one
// index finds either one's root argument.
function rootCommandTarget(arguments_: readonly string[]): string {
	const index = arguments_.includes('targets')
		? arguments_.indexOf('targets')
		: arguments_.indexOf('ensure');
	const root = arguments_.at(index + 2);

	if (root === undefined) {
		throw new Error('the command did not carry a root argument');
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

// Drives both calls the pre-filter makes for one target's root: `root
// targets` answers with whatever reconciled list the test names for that
// root (empty when unnamed), and `root ensure` answers retained or
// build-required from a named set, refusing to answer for a root a test
// wants to fail instead.
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
			undefined,
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
			undefined,
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
			undefined,
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
			undefined,
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

	it('prunes when an absent output is covered by the previous receipt as left upstream for an unchanged manifest', async () => {
		const multiOutputTarget = {
			attr: '.#multi',
			rootDrvPath: targetRootDrvPath,
			system: 'x86_64-linux',
			os: 'ubuntu-latest',
			remote: true,
			bestEffort: false,
			rootSuffix: 'multi',
			outputs: ['out', 'dev']
		};
		const multiOutputEvaluation: TargetEvaluation = {
			target: multiOutputTarget,
			rootDrvPath: '/nix/store/multi.drv',
			nodes: new Map(),
			targetPaths: [outPath, developmentPath]
		};
		const previousReceipt: ParsedBuildReceipt = {
			version: 2,
			paths: [],
			subjects: [],
			outcomes: [{ outcome: 'left-upstream', storePath: developmentPath }]
		};
		const multiRoot = 'github:owner/repo/main/multi';

		const decisions = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [singleCohort([multiOutputEvaluation])] },
			[multiOutputEvaluation],
			previousReceipt,
			preFilterRunner({
				targetsByRoot: new Map([[multiRoot, [outPath]]]),
				ensureRetainedRoots: new Set([multiRoot])
			})
		);

		expect(decisions).toStrictEqual([{ key: 'cohort-first', pruned: true }]);
	});

	it('does not prune when the current output is a changed manifest neither the reconciled list nor the receipt covers', async () => {
		const first = evaluation('first', changedPath);
		// The receipt covers a stale path from before the manifest changed, not
		// the target's current output.
		const previousReceipt: ParsedBuildReceipt = {
			version: 2,
			paths: [],
			subjects: [],
			outcomes: [{ outcome: 'left-upstream', storePath: outPath }]
		};

		const decisions = await cohortPreFilter(
			planInputs({ temporaryDirectory: directory }),
			{ cohorts: [singleCohort([first])] },
			[first],
			previousReceipt,
			preFilterRunner({
				targetsByRoot: new Map([[firstRoot, [outPath]]]),
				ensureRetainedRoots: new Set([firstRoot])
			})
		);

		expect(decisions).toStrictEqual([{ key: 'cohort-first', pruned: false }]);
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
			undefined,
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
			undefined,
			() => Promise.reject(new Error('should not be called'))
		);

		expect(decisions).toStrictEqual([{ key: 'cohort-broken', pruned: false }]);
	});
});

describe('cohort-matrix output', () => {
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

		// The target is retained (its own output is fully cached), so the
		// ordinary target matrix already carries nothing to build; the cohort
		// matrix independently confirms the same target's cohort needs no job.
		expect(outputs).toContain('target-matrix={"include":[]}\n');
		expect(outputs).toContain('cohort-matrix={"include":[]}\n');
		expect(outputs).toContain('cohort-count=0\n');
	});
});
