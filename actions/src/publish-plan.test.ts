import {
	storedCacheSchema,
	type StoreDirectory,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { cacheAvailabilityRequestSchema } from '@cupboard/protocol/cache-availability';
import { readUserInputSchema } from '@cupboard/shared/http';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import {
	CacheAvailabilityQueryError,
	CacheAvailabilityResponseMalformedError,
	CacheAvailabilityResponseSchemaError,
	CacheAvailabilityResponseUnexpectedHashError,
	CohortExecutionContextError,
	CohortFailureToleranceError,
	DerivationGraphShapeError,
	DerivationRootCountError,
	DuplicateGroupKeyError,
	TargetEvaluationError,
	TargetRootUnresolvedError
} from './errors.ts';
import {
	assertDistinctGroupKeys,
	availableCachePaths,
	cacheProbePaths,
	type Cohort,
	cohortLabelMaxLength,
	cohortPreFilterDecision,
	cohortsFor,
	derivationToTargetsFor,
	evaluateTargetCoverage,
	evaluateTargets,
	evaluationFromJson,
	expandComponents,
	isBestEffortCohort,
	joinRoot,
	type NixEvaluator,
	planPublish,
	type PublishComponent,
	publishComponentSchema,
	type PublishTarget,
	publishTargetSchema,
	publishTargetsSchema,
	type TargetCoverage,
	type TargetEvaluation
} from './publish-plan.ts';

function storePath(value: string): StorePathString {
	return storePathSchema.parse(value);
}

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
}

function storePathIn(
	storeDirectory: StoreDirectory,
	basename: string
): StorePathString {
	return storePath(`${storeDirectory}/${basename}`);
}

const defaultStoreDirectory = storeDirectorySchema.parse('/nix/store');
// A runner whose Nix is configured with another `store-dir`: the same
// derivation graph names its paths relative to that directory.
const alternativeStoreDirectory = storeDirectorySchema.parse('/data/nix/store');

const sharedBasename = '11111111111111111111111111111111-shared';
const firstBasename = '22222222222222222222222222222222-first';

const sharedPath = storePathIn(defaultStoreDirectory, sharedBasename);
const firstPath = storePathIn(defaultStoreDirectory, firstBasename);
const secondPath = storePath(
	'/nix/store/33333333333333333333333333333333-second'
);
const manifestRootDrvPath = storePath(
	'/nix/store/00000000000000000000000000000000-manifest-root.drv'
);
const failingNixEvaluator: NixEvaluator = () =>
	Promise.reject(new Error('the recursive show failed'));

describe('planPublish', () => {
	it('splits retained targets from the ones still pending', () => {
		const retained = target('retained');
		const first = target('first');
		const second = target('second');
		const evaluations = [
			evaluation(
				retained,
				'retained',
				storePath('/nix/store/44444444444444444444444444444444-retained'),
				sharedPath
			),
			evaluation(first, 'first', firstPath, sharedPath),
			evaluation(second, 'second', secondPath, sharedPath)
		];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(['retained'])
		});

		expect(serialisePlan(plan)).toStrictEqual({
			retained: ['retained'],
			targets: ['first', 'second']
		});
	});

	// Cohort identity partitions the whole manifest, so a target the plan
	// already retains keeps its place in its cohort: a future cohort job
	// still needs to see it, since the central plan's retained check is
	// advisory rather than authoritative for that job's own build.
	it('keeps a retained target in its cohort alongside pending members', () => {
		const retained = { ...target('retained'), cohort: 'shared-cohort' };
		const first = { ...target('first'), cohort: 'shared-cohort' };
		const evaluations = [
			evaluation(
				retained,
				'retained',
				storePath('/nix/store/44444444444444444444444444444444-retained'),
				undefined
			),
			evaluation(first, 'first', firstPath, undefined)
		];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(['retained'])
		});

		expect(
			plan.cohorts.map((cohort) => ({
				key: cohort.key,
				targets: cohort.targets.map((entry) => entry.rootSuffix),
				installables: cohort.installables
			}))
		).toStrictEqual([
			{
				key: 'cohort-x86_64-linux-ubuntu-latest-remote-878e3921d9b0584a',
				targets: ['retained', 'first'],
				installables: ['.#retained^out', '.#first^out']
			}
		]);
	});

	// The digest is long but not injective, so the plan refuses outright if
	// two groups ever emit one key rather than let them merge in the matrix
	// and race one retention root.
	it('rejects a plan whose groups collide on one key', () => {
		expect(() => {
			assertDistinctGroupKeys([{ key: 'cohort-a' }, { key: 'cohort-a' }]);
		}).toThrow(DuplicateGroupKeyError);
	});

	it('accepts distinct group keys', () => {
		expect(() => {
			assertDistinctGroupKeys([{ key: 'cohort-a' }, { key: 'cohort-b' }]);
		}).not.toThrow();
	});

	it('includes unevaluated targets as direct builds', () => {
		const first = target('first');
		const evaluations = [evaluation(first, 'first', firstPath, sharedPath)];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			unevaluated: [target('broken')]
		});

		expect(serialisePlan(plan)).toStrictEqual({
			retained: [],
			targets: ['first', 'broken']
		});
	});
});

describe('isBestEffortCohort', () => {
	it.each([
		{
			name: 'every member is best-effort',
			members: [target('first'), target('second')],
			tolerated: true
		},
		{
			name: 'one member is required',
			members: [target('first'), { ...target('second'), bestEffort: false }],
			tolerated: false
		},
		{
			name: 'every member is required',
			members: [
				{ ...target('first'), bestEffort: false },
				{ ...target('second'), bestEffort: false }
			],
			tolerated: false
		},
		{
			name: 'the cohort holds one best-effort target',
			members: [target('first')],
			tolerated: true
		},
		{
			name: 'the cohort holds one required target',
			members: [{ ...target('first'), bestEffort: false }],
			tolerated: false
		}
	])('tolerates a failure when $name: $tolerated', ({ members, tolerated }) => {
		expect(isBestEffortCohort(members)).toBe(tolerated);
	});
});

describe('cohortsFor', () => {
	it.each([
		{
			name: 'gives each target its own cohort when no label is declared',
			targets: [target('first'), target('second')],
			// cohortsFor sorts by key, so the lower digest sorts first
			// regardless of manifest order.
			expected: [
				{
					key: 'cohort-x86_64-linux-ubuntu-latest-remote-2c2db096c3b05512',
					targets: ['.#second'],
					installables: ['.#second^out']
				},
				{
					key: 'cohort-x86_64-linux-ubuntu-latest-remote-641f63bc0d1c9f54',
					targets: ['.#first'],
					installables: ['.#first^out']
				}
			]
		},
		{
			name: 'groups targets sharing one cohort label into one cohort',
			targets: [
				{ ...target('first'), cohort: 'group-a' },
				{ ...target('second'), cohort: 'group-a' }
			],
			expected: [
				{
					key: 'cohort-x86_64-linux-ubuntu-latest-remote-19d359dca18f4835',
					targets: ['.#first', '.#second'],
					installables: ['.#first^out', '.#second^out']
				}
			]
		}
	])('$name', ({ targets, expected }) => {
		expect(
			cohortsFor(targets).map((cohort) => ({
				key: cohort.key,
				targets: cohort.targets.map((entry) => entry.attr),
				installables: cohort.installables
			}))
		).toStrictEqual(expected);
	});

	it('is deterministic across repeated calls over the same manifest', () => {
		const targets = [
			{ ...target('first'), cohort: 'group-a' },
			{ ...target('second'), cohort: 'group-a' },
			target('third')
		];

		expect(cohortsFor(targets).map((cohort) => cohort.key)).toStrictEqual(
			cohortsFor(targets).map((cohort) => cohort.key)
		);
	});

	it('carries every member of a multi-target cohort in the build request, output lists included', () => {
		const targets = [
			{ ...target('first'), cohort: 'group-a', outputs: ['out', 'dev'] },
			{ ...target('second'), cohort: 'group-a' }
		];

		expect(
			cohortsFor(targets).map((cohort) => cohort.installables)
		).toStrictEqual([['.#first^out,dev', '.#second^out']]);
	});

	// A cohort is one job, so its members must share where that job runs; a
	// manifest asking for one cohort across two execution contexts cannot be
	// satisfied and is refused rather than silently split or merged.
	it('refuses a cohort whose members span execution contexts', () => {
		const targets = [
			{ ...target('first'), cohort: 'group-a' },
			{ ...target('second'), cohort: 'group-a', remote: false }
		];

		expect(() => cohortsFor(targets)).toThrow(
			new CohortExecutionContextError('group-a', '.#first', '.#second')
		);
	});

	it('refuses an explicitly labelled cohort with mixed failure tolerance', () => {
		const targets = [
			{ ...target('first'), cohort: 'group-a' },
			{
				...target('second'),
				cohort: 'group-a',
				bestEffort: false
			}
		];

		expect(() => cohortsFor(targets)).toThrow(
			new CohortFailureToleranceError('group-a', '.#first', '.#second')
		);
	});
});

function component(
	overrides: Partial<PublishComponent> = {}
): PublishComponent {
	return { attr: '.#component-a', outputs: ['out'], ...overrides };
}

describe('expandComponents', () => {
	it('passes a target with no components through unchanged', () => {
		const targets = [target('app')];

		expect(expandComponents(targets)).toStrictEqual(targets);
	});

	it("replaces an aggregate with its components, inheriting the aggregate's execution context, best-effort flag and cohort", () => {
		const aggregate: PublishTarget = {
			...target('system'),
			cohort: 'group-a',
			components: [
				component({ attr: '.#component-a', rootDrvPath: manifestRootDrvPath }),
				component({ attr: '.#component-b' })
			]
		};

		expect(expandComponents([aggregate])).toStrictEqual([
			{
				attr: '.#component-a',
				rootDrvPath: manifestRootDrvPath,
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: true,
				bestEffort: true,
				rootSuffix: 'system',
				outputs: ['out'],
				cohort: 'group-a'
			},
			{
				attr: '.#component-b',
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: true,
				bestEffort: true,
				rootSuffix: 'system',
				outputs: ['out'],
				cohort: 'group-a'
			}
		]);
	});

	it('never carries the aggregate itself into the result', () => {
		const aggregate: PublishTarget = {
			...target('system'),
			components: [component()]
		};

		expect(
			expandComponents([aggregate]).map((entry) => entry.attr)
		).toStrictEqual(['.#component-a']);
	});

	it('leaves an aggregate with no explicit cohort label uninherited, so each component keeps its own attr as its default label', () => {
		const aggregate: PublishTarget = {
			...target('system'),
			components: [component({ attr: '.#component-a' })]
		};

		expect(expandComponents([aggregate])[0]).not.toHaveProperty('cohort');
	});

	it('expands components alongside ordinary targets in one manifest', () => {
		const aggregate: PublishTarget = {
			...target('system'),
			components: [component()]
		};
		const ordinary = target('app');

		expect(
			expandComponents([aggregate, ordinary]).map((entry) => entry.attr)
		).toStrictEqual(['.#component-a', '.#app']);
	});
});

describe('expandComponents cohort interaction', () => {
	it("gives each component its own cohort by default, sharing the aggregate's execution context", () => {
		const aggregate: PublishTarget = {
			...target('system'),
			components: [
				component({ attr: '.#component-a' }),
				component({ attr: '.#component-b' })
			]
		};

		const cohorts = cohortsFor(expandComponents([aggregate]));

		expect(
			cohorts
				.map((cohort) => ({
					attrs: cohort.targets.map((entry) => entry.attr),
					system: cohort.system,
					os: cohort.os,
					remote: cohort.remote
				}))
				.toSorted((left, right) =>
					left.attrs.join(',').localeCompare(right.attrs.join(','))
				)
		).toStrictEqual([
			{
				attrs: ['.#component-a'],
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: true
			},
			{
				attrs: ['.#component-b'],
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: true
			}
		]);
	});

	it('shares one cohort across every component when the aggregate declares a label', () => {
		const aggregate: PublishTarget = {
			...target('system'),
			cohort: 'group-a',
			components: [
				component({ attr: '.#component-a' }),
				component({ attr: '.#component-b' })
			]
		};

		const cohorts = cohortsFor(expandComponents([aggregate]));

		expect(
			cohorts.map((cohort) => cohort.targets.map((entry) => entry.attr))
		).toStrictEqual([['.#component-a', '.#component-b']]);
	});
});

describe('publishComponentSchema', () => {
	it('defaults outputs to out', () => {
		expect(
			publishComponentSchema.parse({ attr: '.#component-a' })
		).toStrictEqual({ attr: '.#component-a', outputs: ['out'] });
	});

	it.each([
		{ field: 'attr', value: '--refresh' },
		{ field: 'outputs', value: ['--refresh'] }
	])('rejects an unsafe $field value', ({ field, value }) => {
		expect(
			publishComponentSchema.safeParse({ ...component(), [field]: value })
				.success
		).toBe(false);
	});
});

describe('derivationToTargetsFor', () => {
	it('inverts a shared derivation to every target whose graph contains it', () => {
		const first = target('first');
		const second = target('second');
		const evaluations = [
			evaluation(first, 'first', firstPath, sharedPath),
			evaluation(second, 'second', secondPath, sharedPath)
		];

		expect(derivationToTargetsFor(evaluations)).toStrictEqual([
			{ drvPath: '/nix/store/first.drv', targets: ['.#first'] },
			{ drvPath: '/nix/store/second.drv', targets: ['.#second'] },
			{ drvPath: '/nix/store/shared.drv', targets: ['.#first', '.#second'] }
		]);
	});

	it('returns nothing for an empty evaluation set', () => {
		expect(derivationToTargetsFor([])).toStrictEqual([]);
	});
});

describe('evaluateTargetCoverage', () => {
	const first = target('first');

	it.each([
		{
			name: 'every current output is in the reconciled list',
			targetPaths: [firstPath],
			check: { retained: true, reconciledPaths: new Set([firstPath]) },
			status: 'covered' as const
		},
		{
			name: 'an output the reconciled list does not carry',
			targetPaths: [firstPath, secondPath],
			check: { retained: true, reconciledPaths: new Set([firstPath]) },
			status: 'not-covered' as const
		},
		{
			name: 'the reconciled list is empty',
			targetPaths: [firstPath],
			check: {
				retained: true,
				reconciledPaths: new Set<StorePathString>()
			},
			status: 'not-covered' as const
		},
		{
			name: 'the reconciled list is no longer retained',
			targetPaths: [firstPath],
			check: { retained: false, reconciledPaths: new Set([firstPath]) },
			status: 'not-covered' as const
		},
		{
			name: 'a changed output the reconciled list misses',
			targetPaths: [secondPath],
			check: { retained: true, reconciledPaths: new Set([firstPath]) },
			status: 'not-covered' as const
		}
	])('$name', ({ targetPaths, check, status }) => {
		expect(evaluateTargetCoverage(first, targetPaths, check)).toStrictEqual({
			attr: first.attr,
			status
		});
	});
});

describe('cohortPreFilterDecision', () => {
	const cohort: Cohort = {
		key: 'cohort-key',
		system: 'x86_64-linux',
		os: 'ubuntu-latest',
		remote: true,
		targets: [target('first'), target('second')],
		installables: ['.#first^out', '.#second^out']
	};

	it('prunes only when every member is covered', () => {
		expect(
			cohortPreFilterDecision(
				cohort,
				coverageMap([
					{ attr: '.#first', status: 'covered' },
					{ attr: '.#second', status: 'covered' }
				])
			)
		).toStrictEqual({ key: 'cohort-key', pruned: true });
	});

	it.each([
		{ name: 'not-covered', status: 'not-covered' as const },
		{ name: 'unknown-output', status: 'unknown-output' as const }
	])('does not prune when one member is $name', ({ status }) => {
		expect(
			cohortPreFilterDecision(
				cohort,
				coverageMap([
					{ attr: '.#first', status: 'covered' },
					{ attr: '.#second', status }
				])
			)
		).toStrictEqual({ key: 'cohort-key', pruned: false });
	});

	it('does not prune, and records a reason, when a member failed', () => {
		expect(
			cohortPreFilterDecision(
				cohort,
				coverageMap([
					{ attr: '.#first', status: 'covered' },
					{ attr: '.#second', status: 'failed', reason: 'network error' }
				])
			)
		).toStrictEqual({
			key: 'cohort-key',
			pruned: false,
			reason: '.#second: network error'
		});
	});

	it('treats a member missing from the coverage map as not covered', () => {
		expect(cohortPreFilterDecision(cohort, new Map())).toStrictEqual({
			key: 'cohort-key',
			pruned: false
		});
	});
});

describe('cacheProbePaths', () => {
	it('carries each evaluated target output once, deduplicated', () => {
		const first = target('first');
		const second = target('second');
		const evaluations = [
			evaluation(first, 'first', firstPath, sharedPath),
			evaluation(second, 'second', secondPath, sharedPath),
			evaluation(target('third'), 'third', firstPath, undefined)
		];

		expect(cacheProbePaths(evaluations)).toStrictEqual([firstPath, secondPath]);
	});
});

describe('evaluateTargets', () => {
	const appRootDrvPath = storePath(
		'/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app.drv'
	);
	const homeRootDrvPath = storePath(
		'/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-home.drv'
	);
	const dependencyDrvPath = storePath(
		'/nix/store/cccccccccccccccccccccccccccccccc-dependency.drv'
	);
	const app = {
		...target('app'),
		bestEffort: false,
		rootDrvPath: appRootDrvPath
	};
	const home = withoutRootDrvPath(target('home'));
	const resolvedHome = { ...home, rootDrvPath: homeRootDrvPath };
	const appNode = {
		env: { out: firstPath },
		inputs: {
			drvs: {
				[dependencyDrvPath]: { dynamicOutputs: {}, outputs: ['out'] }
			}
		},
		outputs: { out: { path: firstBasename } }
	};
	const homeNode = {
		env: { out: secondPath },
		inputs: { drvs: {} },
		outputs: { out: { path: secondPath.replace('/nix/store/', '') } }
	};
	const dependencyNode = {
		env: { out: sharedPath },
		inputs: { drvs: {} },
		outputs: { out: { path: sharedBasename } }
	};
	const recursiveGraph = {
		derivations: {
			[appRootDrvPath]: appNode,
			[dependencyDrvPath]: dependencyNode
		}
	};

	function graphEvaluator(calls: string[][]): NixEvaluator {
		return (arguments_) => {
			calls.push([...arguments_]);

			return Promise.resolve({ stdout: JSON.stringify(recursiveGraph) });
		};
	}

	it('uses a manifest evaluation failure as a direct best-effort build', async () => {
		const calls: string[][] = [];

		const result = await evaluateTargets(
			[app, home],
			defaultStoreDirectory,
			graphEvaluator(calls)
		);

		expect({
			evaluated: result.evaluations.map(
				(entry) => `${entry.target.attr} from ${entry.rootDrvPath}`
			),
			unevaluated: result.unevaluated.map((entry) => ({
				attr: entry.target.attr,
				reason: entry.reason
			})),
			calls
		}).toStrictEqual({
			evaluated: [`.#app from ${appRootDrvPath}`],
			unevaluated: [
				{
					attr: '.#home',
					reason: 'Target manifest did not resolve a derivation path for .#home'
				}
			],
			calls: [['derivation', 'show', '-r', '--', appRootDrvPath]]
		});
	});

	it('evaluates all manifest derivation paths in one recursive query', async () => {
		const calls: string[][] = [];
		const appRootNode = {
			...appNode,
			inputs: { drvs: {} }
		};
		const evaluator: NixEvaluator = (arguments_) => {
			calls.push([...arguments_]);

			return Promise.resolve({
				stdout: JSON.stringify({
					derivations: {
						[appRootDrvPath]: appRootNode,
						[homeRootDrvPath]: homeNode
					}
				})
			});
		};

		const result = await evaluateTargets(
			[app, resolvedHome],
			defaultStoreDirectory,
			evaluator
		);

		expect({
			evaluated: result.evaluations.map((entry) => entry.target.attr),
			unevaluated: result.unevaluated,
			calls
		}).toStrictEqual({
			evaluated: ['.#app', '.#home'],
			unevaluated: [],
			calls: [
				['derivation', 'show', '-r', '--', appRootDrvPath, homeRootDrvPath]
			]
		});
	});

	it('fails when a strict target has no manifest derivation path', async () => {
		const broken = {
			...withoutRootDrvPath(target('home')),
			bestEffort: false
		};

		await expect(
			evaluateTargets([broken], defaultStoreDirectory, graphEvaluator([]))
		).rejects.toThrow(TargetRootUnresolvedError);
	});

	const recursiveFailureEvaluator: NixEvaluator = (arguments_) => {
		if (arguments_.includes(homeRootDrvPath)) {
			return Promise.reject(new Error('cannot fetch the private input'));
		}

		return Promise.resolve({
			stdout: JSON.stringify(recursiveGraph)
		});
	};

	it('confines a recursive evaluation failure to the best-effort target', async () => {
		const result = await evaluateTargets(
			[app, resolvedHome],
			defaultStoreDirectory,
			recursiveFailureEvaluator
		);

		expect({
			evaluated: result.evaluations.map((entry) => entry.target.attr),
			unevaluated: result.unevaluated.map((entry) => ({
				attr: entry.target.attr,
				reason: entry.reason
			}))
		}).toStrictEqual({
			evaluated: ['.#app'],
			unevaluated: [
				{
					attr: '.#home',
					reason: 'Could not evaluate .#home: cannot fetch the private input'
				}
			]
		});
	});

	it('fails when a strict target cannot be recursively evaluated', async () => {
		await expect(
			evaluateTargets([app], defaultStoreDirectory, failingNixEvaluator)
		).rejects.toThrow(TargetEvaluationError);
	});

	it('skips the recursive pass when every target fails to evaluate', async () => {
		const calls: string[][] = [];

		const result = await evaluateTargets(
			[home],
			defaultStoreDirectory,
			graphEvaluator(calls)
		);

		expect({
			evaluations: result.evaluations,
			unevaluated: result.unevaluated.map((entry) => entry.target.attr),
			calls: calls.length
		}).toStrictEqual({
			evaluations: [],
			unevaluated: ['.#home'],
			calls: 0
		});
	});
});

describe('evaluationFromJson', () => {
	it.each([
		{ storeDirectory: defaultStoreDirectory },
		{ storeDirectory: alternativeStoreDirectory }
	])(
		'parses Determinate derivation JSON under $storeDirectory and identifies the graph root',
		({ storeDirectory }) => {
			const appPath = storePathIn(storeDirectory, firstBasename);
			const dependencyPath = storePathIn(storeDirectory, sharedBasename);
			const parsed = evaluationFromJson(
				target('app'),
				{
					derivations: {
						'dep.drv': {
							env: { out: dependencyPath },
							inputs: { drvs: {} },
							outputs: { out: { path: sharedBasename } }
						},
						'app.drv': {
							env: { out: appPath },
							inputs: {
								drvs: { 'dep.drv': { dynamicOutputs: {}, outputs: ['out'] } }
							},
							outputs: { out: {} }
						}
					}
				},
				storeDirectory
			);

			expect({
				rootDrvPath: parsed.rootDrvPath,
				targetPaths: parsed.targetPaths,
				nodes: parsed.nodes
					.values()
					.map((node) => ({
						drvPath: node.drvPath,
						inputs: node.inputs.entries().toArray(),
						outputs: node.outputs
					}))
					.toArray()
			}).toStrictEqual({
				rootDrvPath: `${storeDirectory}/app.drv`,
				targetPaths: [appPath],
				nodes: [
					{
						drvPath: `${storeDirectory}/app.drv`,
						inputs: [[`${storeDirectory}/dep.drv`, ['out']]],
						outputs: [{ name: 'out', path: appPath }]
					},
					{
						drvPath: `${storeDirectory}/dep.drv`,
						inputs: [],
						outputs: [{ name: 'out', path: dependencyPath }]
					}
				]
			});
		}
	);

	it('leaves a content-addressed placeholder output without a path', () => {
		const parsed = evaluationFromJson(
			target('app'),
			{
				derivations: {
					'app.drv': {
						env: {
							out: '/1rz4g4znpzjwh1xymhjpm42vipw92pr73vdgl6xs1hycac8kf2n9'
						},
						inputs: { drvs: {} },
						outputs: { out: {} }
					}
				}
			},
			defaultStoreDirectory
		);

		expect({
			targetPaths: parsed.targetPaths,
			nodes: parsed.nodes
				.values()
				.map((node) => ({
					drvPath: node.drvPath,
					inputs: node.inputs.entries().toArray(),
					outputs: node.outputs
				}))
				.toArray()
		}).toStrictEqual({
			targetPaths: [],
			nodes: [
				{
					drvPath: '/nix/store/app.drv',
					inputs: [],
					outputs: [{ name: 'out' }]
				}
			]
		});
	});

	it('accepts the bare drvPath map layout', () => {
		const parsed = evaluationFromJson(
			target('app'),
			{
				'app.drv': {
					env: { out: firstPath },
					inputs: { drvs: {} },
					outputs: { out: {} }
				}
			},
			defaultStoreDirectory
		);

		expect({
			rootDrvPath: parsed.rootDrvPath,
			targetPaths: parsed.targetPaths
		}).toStrictEqual({
			rootDrvPath: '/nix/store/app.drv',
			targetPaths: [firstPath]
		});
	});

	it.each([
		{ name: 'a graph that is not an object', value: 'not a derivation graph' },
		{
			name: 'a malformed derivation node',
			value: { derivations: { 'app.drv': 'not a node' } }
		}
	])('rejects $name', ({ value }) => {
		expect(() =>
			evaluationFromJson(target('app'), value, defaultStoreDirectory)
		).toThrow(DerivationGraphShapeError);
	});

	it.each([
		{ name: 'no derivations', value: { derivations: {} } },
		{
			name: 'more than one root derivation',
			value: {
				derivations: {
					'a.drv': { env: {}, inputs: { drvs: {} }, outputs: { out: {} } },
					'b.drv': { env: {}, inputs: { drvs: {} }, outputs: { out: {} } }
				}
			}
		}
	])('rejects a graph with $name', ({ value }) => {
		expect(() =>
			evaluationFromJson(target('app'), value, defaultStoreDirectory)
		).toThrow(DerivationRootCountError);
	});
});

describe('publishTargetSchema', () => {
	it.each([
		{ field: 'attr', value: '--refresh' },
		{ field: 'attr', value: '.#app\n--refresh' },
		{ field: 'outputs', value: ['--refresh'] },
		{ field: 'outputs', value: ['out\nEOF'] }
	])('rejects an unsafe $field value', ({ field, value }) => {
		const result = publishTargetSchema.safeParse({
			...target('app'),
			[field]: value
		});

		expect(result.success).toBe(false);
	});

	it('deduplicates repeated output names, keeping first occurrence order', () => {
		expect(
			publishTargetSchema.parse({
				attr: '.#app',
				rootDrvPath: manifestRootDrvPath,
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: true,
				bestEffort: true,
				rootSuffix: 'app',
				outputs: ['out', 'out']
			})
		).toStrictEqual({
			attr: '.#app',
			rootDrvPath: manifestRootDrvPath,
			system: 'x86_64-linux',
			os: 'ubuntu-latest',
			remote: true,
			bestEffort: true,
			rootSuffix: 'app',
			outputs: ['out']
		});
	});

	it('treats targets as strict unless the manifest opts them out', () => {
		expect(
			publishTargetSchema.parse({
				attr: '.#app',
				rootDrvPath: manifestRootDrvPath,
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: true,
				rootSuffix: 'app'
			})
		).toStrictEqual({
			attr: '.#app',
			rootDrvPath: manifestRootDrvPath,
			system: 'x86_64-linux',
			os: 'ubuntu-latest',
			remote: true,
			bestEffort: false,
			rootSuffix: 'app',
			outputs: ['out']
		});
	});

	it.each([
		{ name: 'a non-store path', rootDrvPath: '/tmp/app.drv' },
		{
			name: 'an output path',
			rootDrvPath: '/nix/store/00000000000000000000000000000000-app'
		}
	])('rejects $name as rootDrvPath', ({ rootDrvPath }) => {
		expect(
			publishTargetSchema.safeParse({
				...target('app'),
				rootDrvPath
			}).success
		).toBe(false);
	});

	it('accepts an omitted best-effort root derivation result', () => {
		const unresolved = withoutRootDrvPath(target('app'));

		expect(publishTargetSchema.parse(unresolved)).toStrictEqual(unresolved);
	});

	it('parses a component-publication target', () => {
		const withComponents = {
			...target('system'),
			components: [{ attr: '.#component-a' }, { attr: '.#component-b' }]
		};

		expect(publishTargetSchema.parse(withComponents)).toStrictEqual({
			...target('system'),
			components: [
				{ attr: '.#component-a', outputs: ['out'] },
				{ attr: '.#component-b', outputs: ['out'] }
			]
		});
	});

	it('rejects an empty components list', () => {
		expect(
			publishTargetSchema.safeParse({ ...target('system'), components: [] })
				.success
		).toBe(false);
	});
});

// GitHub compares labels with .NET ordinal case folding, which JavaScript
// cannot reproduce outside ASCII, so non-ASCII labels are refused outright.
describe('runner label validation', () => {
	it('rejects a non-ASCII os label in the manifest', () => {
		const result = publishTargetSchema.safeParse({
			...target('app'),
			os: '\u{3A3}-runner'
		});

		expect(result.success).toBe(false);
	});
});

describe('cohort label validation', () => {
	it('omits the field by default, leaving the target its own cohort', () => {
		expect(publishTargetSchema.parse(target('app'))).toStrictEqual(
			target('app')
		);
	});

	it('accepts a valid cohort label', () => {
		const result = publishTargetSchema.safeParse({
			...target('app'),
			cohort: 'linux-primary'
		});

		expect(result).toMatchObject({
			success: true,
			data: { cohort: 'linux-primary' }
		});
	});

	it.each([
		{ name: 'an empty label', cohort: '' },
		{
			name: 'a label over the length limit',
			cohort: 'a'.repeat(cohortLabelMaxLength + 1)
		},
		{ name: 'a label containing a space', cohort: 'linux primary' },
		{ name: 'a non-ASCII label', cohort: '\u{3A3}-cohort' }
	])('rejects $name', ({ cohort }) => {
		const result = publishTargetSchema.safeParse({
			...target('app'),
			cohort
		});

		expect(result.success).toBe(false);
	});

	it('accepts a cohort label at the length limit', () => {
		const cohort = 'a'.repeat(cohortLabelMaxLength);

		expect(
			publishTargetSchema.safeParse({ ...target('app'), cohort }).success
		).toBe(true);
	});
});

describe('publishTargetsSchema', () => {
	it('accepts targets with distinct root suffixes', () => {
		const targets = [target('first'), target('second')];

		expect(publishTargetsSchema.parse(targets)).toStrictEqual(targets);
	});

	it('rejects a duplicate rootSuffix, naming it on the offending entry', () => {
		const targets = [
			target('first'),
			{ ...target('second'), rootSuffix: 'first' }
		];
		const result = publishTargetsSchema.safeParse(targets);

		expect(result.success).toBe(false);

		if (result.success) {
			return;
		}

		expect(
			result.error.issues.map((issue) => ({
				path: issue.path,
				code: issue.code
			}))
		).toStrictEqual([{ path: [1, 'rootSuffix'], code: 'custom' }]);
	});

	// `app`, `/app` and `app/` all join to the same root, so a manifest
	// spelling one suffix two ways would let one target's ensured root stand
	// in for the other's while only one of them is actually rooted.
	it.each([
		{ spelling: '/app', canonical: 'app' },
		{ spelling: 'app/', canonical: 'app' }
	])(
		'rejects a suffix equivalent to an earlier one ($spelling)',
		({ spelling, canonical }) => {
			const targets = [
				target(canonical),
				{ ...target('second'), rootSuffix: spelling }
			];
			const result = publishTargetsSchema.safeParse(targets);

			expect(result.success).toBe(false);

			if (result.success) {
				return;
			}

			expect(
				result.error.issues.map((issue) => ({
					path: issue.path,
					code: issue.code
				}))
			).toStrictEqual([{ path: [1, 'rootSuffix'], code: 'custom' }]);
		}
	);

	it('parses suffixes to their canonical form', () => {
		const targets = [
			{ ...target('first'), rootSuffix: '/first' },
			{ ...target('second'), rootSuffix: 'second/' }
		];

		expect(publishTargetsSchema.parse(targets)).toStrictEqual([
			target('first'),
			target('second')
		]);
	});

	it('rejects a suffix that is nothing but slashes', () => {
		const targets = [{ ...target('first'), rootSuffix: '//' }];

		expect(publishTargetsSchema.safeParse(targets).success).toBe(false);
	});
});

// The manifest is pull-request-controlled, so its runner labels must never
// reach `runs-on` unchecked: every permitted label comes from the
// operator-controlled allow-list, with nothing built in.
describe('joinRoot', () => {
	// The ensure calls and the push matrix both construct target roots through
	// this one function, so every equivalent spelling of a prefix and suffix
	// must produce one byte-identical root.
	it.each([
		{ prefix: 'github:owner/repo/main', suffix: 'app' },
		{ prefix: 'github:owner/repo/main', suffix: '/app' },
		{ prefix: 'github:owner/repo/main', suffix: 'app/' },
		{ prefix: 'github:owner/repo/main/', suffix: 'app' }
	])('joins $prefix and $suffix to one root', ({ prefix, suffix }) => {
		expect(joinRoot(prefix, suffix)).toBe('github:owner/repo/main/app');
	});
});

describe('availableCachePaths', () => {
	it('queries a large closure without issuing one narinfo request per path', async () => {
		vi.useFakeTimers();

		try {
			const paths = Array.from({ length: 18_662 }, (_, index) =>
				numberedStorePath(index)
			);
			const fetcher: typeof fetch = (input, init) => {
				const url =
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.href
							: input.url;

				if (!url.endsWith('/api/v1/missing-paths')) {
					throw new TypeError('fetch failed');
				}

				if (typeof init?.body !== 'string') {
					throw new TypeError('availability query body is not a string');
				}

				const body = cacheAvailabilityRequestSchema.parse(
					JSON.parse(init.body)
				);

				return Promise.resolve(
					Response.json(
						{
							missingStorePathHashes: body.storePathHashes
						},
						{
							headers: { 'content-type': 'application/json' },
							status: 200
						}
					)
				);
			};

			const pending = availableCachePaths({
				baseUrl: new URL('https://cupboard.example/t/acme'),
				cache: storedCacheSchema.parse('pr-1'),
				paths,
				fetcher
			});
			await vi.advanceTimersByTimeAsync(60_000);
			const available = await pending;

			expect(available).toStrictEqual(new Set());
		} finally {
			vi.useRealTimers();
		}
	});

	it('returns only paths whose narinfo is available', async () => {
		const requests: string[] = [];
		const headers: (HeadersInit | undefined)[] = [];
		const available = await availableCachePaths({
			baseUrl: new URL('https://cupboard.example/t/acme'),
			cache: storedCacheSchema.parse('pr-1'),
			paths: [firstPath, secondPath],
			fetcher: (input, init) => {
				const url =
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.href
							: input.url;
				requests.push(url);
				headers.push(init?.headers);

				if (url.endsWith('/api/v1/missing-paths')) {
					return Promise.resolve(
						Response.json(
							{
								missingStorePathHashes: [StorePath.hash(secondPath)]
							},
							{ status: 200 }
						)
					);
				}

				return Promise.resolve(
					new Response(undefined, {
						status: url.includes('22222222222222222222222222222222') ? 200 : 404
					})
				);
			}
		});

		expect({
			available: available.values().toArray(),
			requests,
			headers
		}).toStrictEqual({
			available: [firstPath],
			requests: [
				'https://cupboard.example/t/acme/cache/pr-1/api/v1/missing-paths'
			],
			headers: [{ 'content-type': 'application/json' }]
		});
	});

	// A query answer other than 200 is not evidence of absence:
	// treating it as a miss would replan an available path as a fresh build
	// and publish over it, so the query fails closed and the plan never
	// constructs. A transient refusal is retried before that; a deterministic
	// one fails on its first response.
	it.each([
		{ name: 'a deterministic 500 without retrying', status: 500, attempts: 1 },
		{ name: 'a deterministic 403 without retrying', status: 403, attempts: 1 },
		{
			name: 'a persistent transient 503 after retries',
			status: 503,
			attempts: 5
		}
	])(
		'fails closed on $name, naming the status',
		async ({ status, attempts }) => {
			let observedAttempts = 0;
			let thrown: unknown;

			try {
				await availableCachePaths({
					baseUrl: new URL('https://cupboard.example/t/acme'),
					cache: storedCacheSchema.parse('pr-1'),
					paths: [firstPath],
					fetcher: () => {
						observedAttempts += 1;

						return Promise.resolve(new Response(undefined, { status }));
					}
				});
			} catch (error) {
				thrown = error;
			}

			const queryError =
				thrown instanceof CacheAvailabilityQueryError ? thrown : undefined;

			expect({
				status: queryError?.status,
				observedAttempts
			}).toStrictEqual({
				status,
				observedAttempts: attempts
			});
		}
	);

	it('retries a transient probe refusal and keeps the plan alive', async () => {
		let attempts = 0;

		const available = await availableCachePaths({
			baseUrl: new URL('https://cupboard.example/t/acme'),
			cache: storedCacheSchema.parse('pr-1'),
			paths: [firstPath],
			fetcher: () => {
				attempts += 1;

				return Promise.resolve(
					new Response(
						attempts === 1
							? undefined
							: JSON.stringify({ missingStorePathHashes: [] }),
						{ status: attempts === 1 ? 503 : 200 }
					)
				);
			}
		});

		expect({ available: available.values().toArray(), attempts }).toStrictEqual(
			{ available: [firstPath], attempts: 2 }
		);
	});

	it('distinguishes malformed JSON from a schema-invalid response', async () => {
		const malformed = await rejectedBy(() =>
			availableCachePaths({
				baseUrl: new URL('https://cupboard.example/t/acme'),
				cache: storedCacheSchema.parse('pr-1'),
				paths: [firstPath],
				fetcher: () =>
					Promise.resolve(new Response('{', { status: StatusCodes.OK }))
			})
		);
		const invalid = await rejectedBy(() =>
			availableCachePaths({
				baseUrl: new URL('https://cupboard.example/t/acme'),
				cache: storedCacheSchema.parse('pr-1'),
				paths: [firstPath],
				fetcher: () =>
					Promise.resolve(
						Response.json(
							{ missingStorePathHashes: ['not-a-hash'] },
							{ status: StatusCodes.OK }
						)
					)
			})
		);

		expect({
			malformed: malformed instanceof CacheAvailabilityResponseMalformedError,
			malformedCause:
				malformed instanceof CacheAvailabilityResponseMalformedError &&
				malformed.cause instanceof SyntaxError,
			invalid: invalid instanceof CacheAvailabilityResponseSchemaError,
			invalidCause:
				invalid instanceof CacheAvailabilityResponseSchemaError &&
				invalid.cause.name
		}).toStrictEqual({
			malformed: true,
			malformedCause: true,
			invalid: true,
			invalidCause: 'ZodError'
		});
	});

	it('rejects an unrequested hash as a logically invalid response', async () => {
		const unexpectedHash = StorePath.hash(secondPath);
		const error = await rejectedBy(() =>
			availableCachePaths({
				baseUrl: new URL('https://cupboard.example/t/acme'),
				cache: storedCacheSchema.parse('pr-1'),
				paths: [firstPath],
				fetcher: () =>
					Promise.resolve(
						Response.json(
							{
								missingStorePathHashes: [unexpectedHash]
							},
							{ status: StatusCodes.OK }
						)
					)
			})
		);

		expect({
			isUnexpectedHash:
				error instanceof CacheAvailabilityResponseUnexpectedHashError,
			storePathHash:
				error instanceof CacheAvailabilityResponseUnexpectedHashError
					? error.storePathHash
					: undefined
		}).toStrictEqual({
			isUnexpectedHash: true,
			storePathHash: unexpectedHash
		});
	});

	it('sends a basic-auth Authorization header on every probe when read credentials are supplied', async () => {
		const headers: (HeadersInit | undefined)[] = [];

		await availableCachePaths({
			baseUrl: new URL('https://cupboard.example/t/acme'),
			cache: storedCacheSchema.parse('pr-1'),
			paths: [firstPath, secondPath],
			credentials: {
				user: readUserInputSchema.parse('reader'),
				password: 'secret'
			},
			fetcher: (_input, init) => {
				headers.push(init?.headers);

				return Promise.resolve(
					Response.json(
						{
							missingStorePathHashes: [
								StorePath.hash(firstPath),
								StorePath.hash(secondPath)
							]
						},
						{ status: 200 }
					)
				);
			}
		});

		expect(headers).toStrictEqual([
			{
				authorization: `Basic ${Buffer.from('reader:secret').toString('base64')}`,
				'content-type': 'application/json'
			}
		]);
	});
});

function numberedStorePath(index: number): StorePathString {
	const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
	let remaining = index;
	let hash = '';

	do {
		hash = `${alphabet.charAt(remaining % alphabet.length)}${hash}`;
		remaining = Math.floor(remaining / alphabet.length);
	} while (remaining > 0);

	return storePath(
		`/nix/store/${hash.padStart(32, '0')}-planner-path-${String(index)}`
	);
}

function target(rootSuffix: string): PublishTarget {
	return {
		attr: `.#${rootSuffix}`,
		rootDrvPath: manifestRootDrvPath,
		system: 'x86_64-linux',
		os: 'ubuntu-latest',
		remote: true,
		bestEffort: true,
		rootSuffix,
		outputs: ['out']
	};
}

function withoutRootDrvPath(target_: PublishTarget): PublishTarget {
	const unresolved = { ...target_ };
	Reflect.deleteProperty(unresolved, 'rootDrvPath');

	return unresolved;
}

function evaluation(
	target_: PublishTarget,
	name: string,
	path: StorePathString,
	shared: StorePathString | undefined
): TargetEvaluation {
	return {
		target: target_,
		rootDrvPath: `/nix/store/${name}.drv`,
		targetPaths: [path],
		nodes: new Map([
			[
				'/nix/store/shared.drv',
				{
					drvPath: '/nix/store/shared.drv',
					inputs: new Map(),
					outputs: [
						{ name: 'out', ...(shared !== undefined && { path: shared }) }
					]
				}
			],
			[
				`/nix/store/${name}.drv`,
				{
					drvPath: `/nix/store/${name}.drv`,
					inputs: new Map([['/nix/store/shared.drv', ['out']]]),
					outputs: [{ name: 'out', path }]
				}
			]
		])
	};
}

function coverageMap(
	entries: readonly TargetCoverage[]
): Map<string, TargetCoverage> {
	return new Map(entries.map((entry) => [entry.attr, entry]));
}

function serialisePlan(plan: ReturnType<typeof planPublish>): unknown {
	return {
		retained: plan.retained.map((entry) => entry.rootSuffix),
		targets: plan.targets.map((entry) => entry.rootSuffix)
	};
}
