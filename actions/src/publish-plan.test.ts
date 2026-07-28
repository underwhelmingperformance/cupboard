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
	DerivationGraphShapeError,
	DerivationRootCountError,
	DuplicateGroupKeyError,
	TargetEvaluationError,
	TargetRootUnresolvedError
} from './errors.ts';
import {
	assertDistinctGroupKeys,
	availableCachePaths,
	availableViewPaths,
	cacheProbePaths,
	derivationUses,
	evaluateTargets,
	evaluationFromJson,
	joinRoot,
	type NixEvaluator,
	planPublish,
	type PublishTarget,
	publishTargetSchema,
	publishTargetsSchema,
	type TargetEvaluation,
	viewProbePaths
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
const viewOnlyPath = storePath(
	'/nix/store/44444444444444444444444444444444-viewonly'
);
const missingPath = storePath(
	'/nix/store/55555555555555555555555555555555-missing'
);
const sharedOutPath = storePath(
	'/nix/store/66666666666666666666666666666666-shared-out'
);
const sharedDevelopmentPath = storePath(
	'/nix/store/77777777777777777777777777777777-shared-dev'
);
const manifestRootDrvPath = storePath(
	'/nix/store/00000000000000000000000000000000-manifest-root.drv'
);
const failingNixEvaluator: NixEvaluator = () =>
	Promise.reject(new Error('the recursive show failed'));

describe('planPublish', () => {
	it('skips retained targets and seeds an uncached shared output once', () => {
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
			retainedRoots: new Set(['retained']),
			availablePaths: new Set(),
			uses: derivationUses(evaluations)
		});

		expect(serialisePlan(plan)).toStrictEqual({
			retained: ['retained'],
			targets: ['first', 'second'],
			seedGroups: [
				{
					key: 'seed-x86_64-linux-ubuntu-latest-remote-e196fc1bd181007f',
					targets: ['.#first', '.#second'],
					candidates: [
						{
							drvPath: '/nix/store/shared.drv',
							output: 'out',
							path: sharedPath
						}
					]
				}
			],
			fallbackGroups: []
		});
	});

	it('does not seed an output shared with a retained target when only one target is pending', () => {
		const retained = target('retained');
		const first = target('first');
		const evaluations = [
			evaluation(
				retained,
				'retained',
				storePath('/nix/store/44444444444444444444444444444444-retained'),
				sharedPath
			),
			evaluation(first, 'first', firstPath, sharedPath)
		];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(['retained']),
			availablePaths: new Set(),
			uses: derivationUses(evaluations)
		});

		expect(serialisePlan(plan)).toStrictEqual({
			retained: ['retained'],
			targets: ['first'],
			seedGroups: [],
			fallbackGroups: []
		});
	});

	it('does not seed a shared output already held by the cache', () => {
		const first = target('first');
		const second = target('second');
		const evaluations = [
			evaluation(first, 'first', firstPath, sharedPath),
			evaluation(second, 'second', secondPath, sharedPath)
		];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths: new Set([sharedPath]),
			uses: derivationUses(evaluations)
		});

		// The omitted seed is recorded as a destination-resident intermediate so
		// grace mode can refresh its deadline before relying on it.
		expect({
			seedGroups: plan.seedGroups,
			destinationIntermediates: plan.destinationIntermediates
		}).toStrictEqual({
			seedGroups: [],
			destinationIntermediates: [sharedPath]
		});
	});

	it('records no intermediate for an available output that would never seed', () => {
		const retained = target('retained');
		const first = target('first');
		const evaluations = [
			evaluation(
				retained,
				'retained',
				storePath(`/nix/store/${'4'.repeat(32)}-retained`),
				sharedPath
			),
			evaluation(first, 'first', firstPath, sharedPath)
		];

		// Only one pending target uses the shared output, so it would not have
		// been seeded even if it were missing; its availability is incidental.
		expect(
			planPublish({
				evaluations,
				retainedRoots: new Set(['retained']),
				availablePaths: new Set([sharedPath]),
				uses: derivationUses(evaluations)
			}).destinationIntermediates
		).toStrictEqual([]);
	});

	it('classifies shared outputs three ways when a view is configured', () => {
		const first = target('first');
		const second = target('second');
		const evaluations = [
			multiSharedEvaluation(first, 'first', firstPath),
			multiSharedEvaluation(second, 'second', secondPath)
		];

		// The destination-resident output is also in the view: destination
		// availability must win, so the confirm set is never view-fed.
		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths: new Set([sharedPath]),
			viewAvailablePaths: new Set([sharedPath, viewOnlyPath]),
			uses: derivationUses(evaluations)
		});

		expect({
			plan: serialisePlan(plan),
			destinationIntermediates: plan.destinationIntermediates
		}).toStrictEqual({
			plan: {
				retained: [],
				targets: ['first', 'second'],
				seedGroups: [
					{
						key: 'adopt-x86_64-linux-ubuntu-latest-remote-e196fc1bd181007f',
						targets: ['.#first', '.#second'],
						candidates: [
							{
								drvPath: '/nix/store/shared-viewonly.drv',
								output: 'out',
								path: viewOnlyPath
							}
						]
					},
					{
						key: 'seed-x86_64-linux-ubuntu-latest-remote-e196fc1bd181007f',
						targets: ['.#first', '.#second'],
						candidates: [
							{
								drvPath: '/nix/store/shared-missing.drv',
								output: 'out',
								path: missingPath
							}
						]
					}
				],
				fallbackGroups: []
			},
			destinationIntermediates: [sharedPath]
		});
	});

	it('plans the view-only output as an ordinary seed without a view', () => {
		const first = target('first');
		const second = target('second');
		const evaluations = [
			multiSharedEvaluation(first, 'first', firstPath),
			multiSharedEvaluation(second, 'second', secondPath)
		];
		const options = {
			evaluations,
			retainedRoots: new Set<string>(),
			availablePaths: new Set([sharedPath]),
			uses: derivationUses(evaluations)
		};

		const withoutView = planPublish(options);
		const withEmptyView = planPublish({
			...options,
			viewAvailablePaths: new Set()
		});

		// An absent view and an empty view plan identically, and every
		// non-resident shared output seeds as a build.
		expect({
			withoutView: serialisePlan(withoutView),
			identical: serialisePlan(withEmptyView),
			destinationIntermediates: withoutView.destinationIntermediates
		}).toStrictEqual({
			withoutView: {
				retained: [],
				targets: ['first', 'second'],
				seedGroups: [
					{
						key: 'seed-x86_64-linux-ubuntu-latest-remote-e196fc1bd181007f',
						targets: ['.#first', '.#second'],
						candidates: [
							{
								drvPath: '/nix/store/shared-missing.drv',
								output: 'out',
								path: missingPath
							},
							{
								drvPath: '/nix/store/shared-viewonly.drv',
								output: 'out',
								path: viewOnlyPath
							}
						]
					}
				],
				fallbackGroups: []
			},
			identical: serialisePlan(withoutView),
			destinationIntermediates: [sharedPath]
		});
	});

	// The readable key parts are hyphen-joined and may themselves contain
	// hyphens, so the tuple hash must keep look-alike contexts apart: one
	// group per execution context, never a shared key.
	it('keys look-alike execution contexts distinctly', () => {
		const contextOne = { system: 'a-b', os: 'c', remote: false };
		const contextTwo = { system: 'a', os: 'b-c', remote: false };
		const evaluations = [
			evaluation(
				{ ...target('first'), ...contextOne },
				'first',
				firstPath,
				sharedPath
			),
			evaluation(
				{ ...target('second'), ...contextOne },
				'second',
				secondPath,
				sharedPath
			),
			evaluation(
				{ ...target('third'), ...contextTwo },
				'third',
				storePath('/nix/store/88888888888888888888888888888888-third'),
				sharedPath
			),
			evaluation(
				{ ...target('fourth'), ...contextTwo },
				'fourth',
				storePath('/nix/store/99999999999999999999999999999999-fourth'),
				sharedPath
			)
		];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths: new Set(),
			uses: derivationUses(evaluations)
		});

		expect(plan.seedGroups.map((group) => group.key)).toStrictEqual([
			'seed-a-b-c-local-95a1aeafcadc39aa',
			'seed-a-b-c-local-b24fcbf955fc0001'
		]);
	});

	// The digest is long but not injective, so the plan refuses outright if
	// two groups ever emit one key rather than let them merge in the matrix
	// and race one retention root.
	it('rejects a plan whose groups collide on one key', () => {
		expect(() => {
			assertDistinctGroupKeys([{ key: 'seed-a' }, { key: 'seed-a' }]);
		}).toThrow(DuplicateGroupKeyError);
	});

	it('accepts distinct group keys', () => {
		expect(() => {
			assertDistinctGroupKeys([{ key: 'seed-a' }, { key: 'seed-b' }]);
		}).not.toThrow();
	});

	// GitHub compares runner labels case-insensitively, so case-variant
	// spellings of one label are one execution context: a shared output must
	// seed once for both, under one canonical group key.
	it('seeds a shared output once for case-variant spellings of one label', () => {
		const first = target('first');
		const second = { ...target('second'), os: 'UBUNTU-LATEST' };
		const evaluations = [
			evaluation(first, 'first', firstPath, sharedPath),
			evaluation(second, 'second', secondPath, sharedPath)
		];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths: new Set(),
			uses: derivationUses(evaluations)
		});

		expect(serialisePlan(plan)).toStrictEqual({
			retained: [],
			targets: ['first', 'second'],
			seedGroups: [
				{
					key: 'seed-x86_64-linux-ubuntu-latest-remote-e196fc1bd181007f',
					targets: ['.#first', '.#second'],
					candidates: [
						{
							drvPath: '/nix/store/shared.drv',
							output: 'out',
							path: sharedPath
						}
					]
				}
			],
			fallbackGroups: []
		});
	});

	it('groups unknown shared outputs once for case-variant spellings of one label', () => {
		const first = target('first');
		const second = { ...target('second'), os: 'UBUNTU-LATEST' };
		const evaluations = [
			evaluation(first, 'first', firstPath, undefined),
			evaluation(second, 'second', secondPath, undefined)
		];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths: new Set(),
			uses: derivationUses(evaluations)
		});

		expect(serialisePlan(plan)).toStrictEqual({
			retained: [],
			targets: ['first', 'second'],
			seedGroups: [],
			fallbackGroups: [
				{
					key: 'fallback-x86_64-linux-1',
					targets: ['first', 'second']
				}
			]
		});
	});

	it('co-locates targets sharing an output whose path is unknown', () => {
		const first = target('first');
		const second = target('second');
		const evaluations = [
			evaluation(first, 'first', firstPath, undefined),
			evaluation(second, 'second', secondPath, undefined)
		];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths: new Set(),
			uses: derivationUses(evaluations)
		});

		expect(serialisePlan(plan)).toStrictEqual({
			retained: [],
			targets: ['first', 'second'],
			seedGroups: [],
			fallbackGroups: [
				{
					key: 'fallback-x86_64-linux-1',
					targets: ['first', 'second']
				}
			]
		});
	});

	it('includes unevaluated targets as direct builds', () => {
		const first = target('first');
		const evaluations = [evaluation(first, 'first', firstPath, sharedPath)];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths: new Set(),
			uses: derivationUses(evaluations),
			unevaluated: [target('broken')]
		});

		expect(serialisePlan(plan)).toStrictEqual({
			retained: [],
			targets: ['first', 'broken'],
			seedGroups: [],
			fallbackGroups: []
		});
	});

	it('does not group shared derivations across execution contexts', () => {
		const first = target('first');
		const second = { ...target('second'), remote: false };
		const evaluations = [
			evaluation(first, 'first', firstPath, undefined),
			evaluation(second, 'second', secondPath, undefined)
		];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths: new Set(),
			uses: derivationUses(evaluations)
		});

		expect(serialisePlan(plan)).toStrictEqual({
			retained: [],
			targets: ['first', 'second'],
			seedGroups: [],
			fallbackGroups: []
		});
	});
});

describe('cacheProbePaths', () => {
	it('includes target paths and shared outputs but not private prerequisites', () => {
		const first = target('first');
		const second = target('second');
		const firstEvaluation = evaluation(first, 'first', firstPath, sharedPath);
		const secondEvaluation = evaluation(
			second,
			'second',
			secondPath,
			sharedPath
		);
		const firstNodes = new Map(firstEvaluation.nodes);
		firstNodes.set('/nix/store/first-only.drv', {
			drvPath: '/nix/store/first-only.drv',
			inputs: new Map(),
			outputs: [
				{
					name: 'out',
					path: storePath(
						'/nix/store/44444444444444444444444444444444-first-only'
					)
				}
			]
		});
		const firstWithPrivatePrerequisite = {
			...firstEvaluation,
			nodes: firstNodes
		};

		const evaluations = [firstWithPrivatePrerequisite, secondEvaluation];

		expect(
			cacheProbePaths(evaluations, derivationUses(evaluations))
		).toStrictEqual([firstPath, secondPath, sharedPath]);
	});
});

describe('viewProbePaths', () => {
	it('carries only shared outputs with at least two pending users', () => {
		const first = target('first');
		const second = target('second');
		const evaluations = [
			evaluation(first, 'first', firstPath, sharedPath),
			evaluation(second, 'second', secondPath, sharedPath)
		];

		expect(viewProbePaths(derivationUses(evaluations))).toStrictEqual([
			sharedPath
		]);
	});
});

describe('derivationUses', () => {
	it('records a use only for outputs a dependent actually names', () => {
		const first = target('first');
		const second = target('second');
		const evaluations = [
			multiOutputEvaluation(first, 'first', firstPath, ['out']),
			multiOutputEvaluation(second, 'second', secondPath, ['out'])
		];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths: new Set(),
			uses: derivationUses(evaluations)
		});

		expect({
			plan: serialisePlan(plan),
			probePaths: cacheProbePaths(evaluations, derivationUses(evaluations))
		}).toStrictEqual({
			plan: {
				retained: [],
				targets: ['first', 'second'],
				seedGroups: [
					{
						key: 'seed-x86_64-linux-ubuntu-latest-remote-e196fc1bd181007f',
						targets: ['.#first', '.#second'],
						candidates: [
							{
								drvPath: '/nix/store/shared-multi.drv',
								output: 'out',
								path: sharedOutPath
							}
						]
					}
				],
				fallbackGroups: []
			},
			probePaths: [firstPath, secondPath, sharedOutPath]
		});
	});

	it('seeds every output dependents consume', () => {
		const first = target('first');
		const second = target('second');
		const evaluations = [
			multiOutputEvaluation(first, 'first', firstPath, ['out', 'dev']),
			multiOutputEvaluation(second, 'second', secondPath, ['out', 'dev'])
		];

		const plan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths: new Set(),
			uses: derivationUses(evaluations)
		});

		expect(serialisePlan(plan)).toStrictEqual({
			retained: [],
			targets: ['first', 'second'],
			seedGroups: [
				{
					key: 'seed-x86_64-linux-ubuntu-latest-remote-e196fc1bd181007f',
					targets: ['.#first', '.#second'],
					candidates: [
						{
							drvPath: '/nix/store/shared-multi.drv',
							output: 'dev',
							path: sharedDevelopmentPath
						},
						{
							drvPath: '/nix/store/shared-multi.drv',
							output: 'out',
							path: sharedOutPath
						}
					]
				}
			],
			fallbackGroups: []
		});
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

	it('queries a large reuse-view closure through the bounded availability interface', async () => {
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
					Response.json({
						missingStorePathHashes: body.storePathHashes
					})
				);
			};

			const pending = availableViewPaths({
				baseUrl: new URL('https://cupboard.example/t/acme'),
				view: 'pull-requests',
				paths,
				fetcher
			});
			await vi.advanceTimersByTimeAsync(60_000);

			await expect(pending).resolves.toStrictEqual(new Set());
		} finally {
			vi.useRealTimers();
		}
	});

	it('probes a reuse view beneath the tenant base', async () => {
		const requests: string[] = [];
		const available = await availableViewPaths({
			baseUrl: new URL('https://cupboard.example/t/acme'),
			view: 'reuse',
			paths: [firstPath, secondPath],
			fetcher: (input) => {
				const url =
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.href
							: input.url;
				requests.push(url);

				return Promise.resolve(
					Response.json({
						missingStorePathHashes: [StorePath.hash(secondPath)]
					})
				);
			}
		});

		expect({ available: available.values().toArray(), requests }).toStrictEqual(
			{
				available: [firstPath],
				requests: [
					'https://cupboard.example/t/acme/reuse/reuse/api/v1/missing-paths'
				]
			}
		);
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

// An evaluation whose target depends on three shared outputs, so one plan can
// hold a destination-resident, a view-only, and a missing intermediate at
// once.
function multiSharedEvaluation(
	target_: PublishTarget,
	name: string,
	path: StorePathString
): TargetEvaluation {
	const shared: readonly [string, StorePathString][] = [
		['/nix/store/shared-resident.drv', sharedPath],
		['/nix/store/shared-viewonly.drv', viewOnlyPath],
		['/nix/store/shared-missing.drv', missingPath]
	];

	return {
		target: target_,
		rootDrvPath: `/nix/store/${name}.drv`,
		targetPaths: [path],
		nodes: new Map([
			...shared.map(
				([drvPath, outputPath]) =>
					[
						drvPath,
						{
							drvPath,
							inputs: new Map<string, string[]>(),
							outputs: [{ name: 'out', path: outputPath }]
						}
					] as const
			),
			[
				`/nix/store/${name}.drv`,
				{
					drvPath: `/nix/store/${name}.drv`,
					inputs: new Map(shared.map(([drvPath]) => [drvPath, ['out']])),
					outputs: [{ name: 'out', path }]
				}
			]
		])
	};
}

// An evaluation whose target depends on a two-output shared derivation,
// naming only the given subset of its outputs as an input — so a dependent
// that names just `out` never turns the unreferenced `dev` output into a use.
function multiOutputEvaluation(
	target_: PublishTarget,
	name: string,
	path: StorePathString,
	consumedOutputs: readonly string[]
): TargetEvaluation {
	return {
		target: target_,
		rootDrvPath: `/nix/store/${name}.drv`,
		targetPaths: [path],
		nodes: new Map([
			[
				'/nix/store/shared-multi.drv',
				{
					drvPath: '/nix/store/shared-multi.drv',
					inputs: new Map(),
					outputs: [
						{ name: 'out', path: sharedOutPath },
						{ name: 'dev', path: sharedDevelopmentPath }
					]
				}
			],
			[
				`/nix/store/${name}.drv`,
				{
					drvPath: `/nix/store/${name}.drv`,
					inputs: new Map([['/nix/store/shared-multi.drv', consumedOutputs]]),
					outputs: [{ name: 'out', path }]
				}
			]
		])
	};
}

function serialisePlan(plan: ReturnType<typeof planPublish>): unknown {
	return {
		retained: plan.retained.map((entry) => entry.rootSuffix),
		targets: plan.targets.map((entry) => entry.rootSuffix),
		seedGroups: plan.seedGroups.map((group) => ({
			key: group.key,
			targets: group.targets,
			candidates: group.candidates
		})),
		fallbackGroups: plan.fallbackGroups.map((group) => ({
			key: group.key,
			targets: group.targets.map((entry) => entry.rootSuffix)
		}))
	};
}
