import type {
	NixBuildResult,
	NixDerivedPathString,
	NixValidPathInfo
} from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type RootName,
	rootNameSchema,
	storePathSchema,
	type StorePathString,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { derivationPathSchema } from '@cupboard/protocol/build';
import type { RootSetBody } from '@cupboard/protocol/retention';
import {
	type UploadDecision,
	uploadDecisionSchema
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import type { CommitOutcome } from '../client/commit-socket.ts';
import { UploadVerificationFailedError } from '../errors.ts';
import type { PushClient } from '../push/push.ts';

import type { BatchPathOutcome } from './batching.ts';
import {
	reconcileBuild,
	type ReconcileOptions,
	type ReconcilePartition,
	type ReconcileTarget
} from './reconcile.ts';

const pathA = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const pathB = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
);
const pathC = storePathSchema.parse(
	'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-tool'
);
const pathD = storePathSchema.parse(
	'/nix/store/5123456789abcdfghijklmnpqrsvwxyz-doc'
);
const pathG = storePathSchema.parse(
	'/nix/store/6123456789abcdfghijklmnpqrsvwxyz-gen'
);
const pathH = storePathSchema.parse(
	'/nix/store/7123456789abcdfghijklmnpqrsvwxyz-float'
);
const drvA = derivationPathSchema.parse(
	'/nix/store/8123456789abcdfghijklmnpqrsvwxyz-float.drv'
);
const rootOne = rootNameSchema.parse('github:acme/repo/one');
const rootTwo = rootNameSchema.parse('github:acme/repo/two');
const narHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 0xaa));

function target(storePath: StorePathString, root?: RootName): ReconcileTarget {
	return {
		installable: storePath,
		expectedPath: storePath,
		...(root !== undefined && { root })
	};
}

function pathInfo(storePath: StorePathString): NixValidPathInfo {
	return {
		storePath,
		narHash,
		narSize: 4,
		references: [],
		signatures: [],
		ultimate: false
	};
}

function partitionOf(
	overrides: Partial<ReconcilePartition> = {}
): ReconcilePartition {
	return {
		attachOnly: [],
		publishByReference: [],
		leftUpstream: [],
		counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
		downloadSize: 0,
		narSize: 0,
		...overrides
	};
}

function decisionFor(
	storePath: StorePathString,
	action: UploadDecision['action']
) {
	const base = {
		storePathHash: StorePath.hash(storePath),
		narHash: narHash.toString()
	};

	if (action === 'skip') {
		return uploadDecisionSchema.parse({ action, ...base });
	}

	if (action === 'commit') {
		return uploadDecisionSchema.parse({
			action,
			...base,
			uploadId: `upload-${StorePath.basename(storePath)}`
		});
	}

	return uploadDecisionSchema.parse({
		action,
		...base,
		uploadId: `upload-${StorePath.basename(storePath)}`,
		r2Key: `staging/${StorePath.basename(storePath)}`,
		expiresAt: '2026-07-31T00:00:00.000Z'
	});
}

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		}
	});
}

interface HarnessOptions {
	readonly valid?: readonly StorePathString[];
	readonly actions?: ReadonlyMap<StorePathString, UploadDecision['action']>;
	readonly failUploads?: ReadonlySet<StorePathString>;
	readonly commitBehaviour?: ReadonlyMap<
		StorePathString,
		'pending-servable' | 'pending-failed'
	>;
	readonly derivationOutputs?: ReadonlyMap<string, readonly StorePathString[]>;
}

interface Harness {
	readonly negotiatedPaths: string[][];
	readonly rootReplacements: { name: string; body: RootSetBody }[];
	readonly uploadedKeys: string[];
	readonly store: ReconcileOptions['store'];
	readonly client: PushClient;
}

function harness(options: HarnessOptions = {}): Harness {
	const negotiatedPaths: string[][] = [];
	const rootReplacements: { name: string; body: RootSetBody }[] = [];
	const uploadedKeys: string[] = [];
	const valid = new Set(options.valid);
	const pathByHash = new Map(
		[pathA, pathB, pathC, pathD, pathG, pathH].map((path) => [
			StorePath.hash(path),
			path
		])
	);

	const store: ReconcileOptions['store'] = {
		queryValidPathsInfo: (paths) =>
			Promise.resolve(
				paths
					.filter((path): path is StorePathString =>
						valid.has(storePathSchema.parse(path))
					)
					.map((path) => pathInfo(storePathSchema.parse(path)))
			),
		queryDerivationOutputPaths: (drvPaths) =>
			Promise.resolve(
				drvPaths.flatMap((drvPath) => [
					...(options.derivationOutputs?.get(drvPath) ?? [])
				])
			)
	};

	const client: PushClient = {
		negotiate: (body) => {
			negotiatedPaths.push(body.paths.map((path) => path.storePath));

			return Promise.resolve({
				uploads: body.paths.map((path) => {
					const storePath = storePathSchema.parse(path.storePath);

					return decisionFor(
						storePath,
						options.actions?.get(storePath) ?? 'skip'
					);
				})
			});
		},
		preview: () => Promise.resolve({ uploads: [] }),
		uploadNar: (r2Key) => {
			uploadedKeys.push(r2Key);
			const isFailed = [...(options.failUploads ?? [])].some(
				(path) => r2Key === `staging/${StorePath.basename(path)}`
			);

			if (isFailed) {
				return Promise.reject(new Error('upload refused'));
			}

			return Promise.resolve();
		},
		commit: (commitTarget) => {
			const storePath = pathByHash.get(commitTarget.storePathHash);
			const behaviour =
				storePath === undefined
					? undefined
					: options.commitBehaviour?.get(storePath);
			const settled =
				behaviour === 'pending-failed'
					? Promise.reject(
							new UploadVerificationFailedError(commitTarget.uploadId, 'absent')
						)
					: Promise.resolve();
			const outcome: CommitOutcome = {
				storePathHash: commitTarget.storePathHash,
				narHash: commitTarget.narHash,
				status: behaviour === undefined ? 'committed' : 'pending',
				settled
			};

			return Promise.resolve(outcome);
		},
		setRoot: (name, body) => {
			rootReplacements.push({ name, body });

			return Promise.resolve({
				name: rootNameSchema.parse(name),
				expired: false,
				createdAt: '2026-07-31T00:00:00.000Z',
				updatedAt: '2026-07-31T00:00:00.000Z',
				targets: []
			});
		}
	};

	return { negotiatedPaths, rootReplacements, uploadedKeys, store, client };
}

function reconcileWith(
	harnessed: Harness,
	overrides: Partial<ReconcileOptions>
) {
	return reconcileBuild({
		targets: [],
		outcomes: new Map<StorePathString, BatchPathOutcome>(),
		candidates: [],
		snapshot: { derivations: new Map() },
		store: harnessed.store,
		client: harnessed.client,
		createNarArchive: () => emptyStream(),
		compressNar: () => ({
			body: emptyStream(),
			digest: () => ({ narHash, narSize: 4 })
		}),
		...overrides
	});
}

describe('reconcileBuild', () => {
	interface Scenario {
		readonly name: string;
		readonly harness: HarnessOptions;
		readonly options: Partial<ReconcileOptions>;
		readonly expected: {
			readonly receipt: unknown;
			readonly roots: unknown;
			readonly rootReplacements: unknown;
			readonly negotiatedPaths: unknown;
			readonly failures: unknown;
		};
	}

	const scenarios: readonly Scenario[] = [
		{
			name: 'replaces every root when all targets confirm servable',
			harness: { valid: [pathA, pathB] },
			options: {
				targets: [target(pathA, rootOne), target(pathB, rootTwo)],
				partition: partitionOf({
					counts: { willBuild: 2, willSubstitute: 0, unknown: 0 }
				}),
				outcomes: new Map<StorePathString, BatchPathOutcome>([
					[pathA, { outcome: 'published', storePath: pathA }],
					[pathB, { outcome: 'published', storePath: pathB }]
				]),
				snapshot: { derivations: new Map(), evaluationTimeMs: 1234 },
				childExitStatus: 0
			},
			expected: {
				receipt: {
					version: 2,
					paths: [pathA, pathB],
					subjects: [],
					outcomes: [
						{ outcome: 'built', storePath: pathA },
						{ outcome: 'built', storePath: pathB }
					],
					planner: {
						willBuild: 2,
						willSubstitute: 0,
						unknown: 0,
						attached: 0,
						adopted: 0,
						leftUpstream: 0
					},
					substitutable: { downloadSize: 0, narSize: 0 },
					evaluationTimeMs: 1234,
					childExitStatus: 0,
					uploaded: [pathA, pathB],
					failed: [],
					collected: []
				},
				roots: [
					{ root: rootOne, applied: true, targets: [pathA] },
					{ root: rootTwo, applied: true, targets: [pathB] }
				],
				rootReplacements: [
					{ name: rootOne, body: { targets: [pathA] } },
					{ name: rootTwo, body: { targets: [pathB] } }
				],
				negotiatedPaths: [[pathA, pathB]],
				failures: []
			}
		},
		{
			name: 'leaves an unconfirmed root untouched and replaces the rest',
			harness: {
				valid: [pathA, pathB],
				actions: new Map<StorePathString, UploadDecision['action']>([
					[pathA, 'skip'],
					[pathB, 'upload']
				]),
				failUploads: new Set([pathB])
			},
			options: {
				targets: [target(pathA, rootOne), target(pathB, rootTwo)],
				outcomes: new Map<StorePathString, BatchPathOutcome>([
					[pathA, { outcome: 'published', storePath: pathA }]
				]),
				candidates: [pathB]
			},
			expected: {
				receipt: {
					version: 2,
					paths: [pathA],
					subjects: [],
					outcomes: [
						{ outcome: 'built', storePath: pathA },
						{ outcome: 'failed', storePath: pathB, reason: 'upload' }
					],
					uploaded: [pathA],
					failed: [pathB],
					collected: []
				},
				roots: [
					{ root: rootOne, applied: true, targets: [pathA] },
					{ root: rootTwo, applied: false, targets: [pathB] }
				],
				rootReplacements: [{ name: rootOne, body: { targets: [pathA] } }],
				negotiatedPaths: [[pathA, pathB]],
				failures: [{ storePath: pathB, reason: 'upload' }]
			}
		},
		{
			name: 'still publishes a target that was valid before the invocation',
			harness: {
				valid: [pathC],
				actions: new Map<StorePathString, UploadDecision['action']>([
					[pathC, 'upload']
				])
			},
			options: {
				targets: [target(pathC, rootOne)]
			},
			expected: {
				receipt: {
					version: 2,
					paths: [pathC],
					subjects: [],
					outcomes: [{ outcome: 'built', storePath: pathC }],
					uploaded: [pathC],
					failed: [],
					collected: []
				},
				roots: [{ root: rootOne, applied: true, targets: [pathC] }],
				rootReplacements: [{ name: rootOne, body: { targets: [pathC] } }],
				negotiatedPaths: [[pathC]],
				failures: []
			}
		},
		{
			name: 'settles a root empty when its only target is left upstream',
			harness: { valid: [pathD] },
			options: {
				targets: [target(pathD, rootTwo)],
				partition: partitionOf({
					leftUpstream: [pathD],
					counts: { willBuild: 0, willSubstitute: 1, unknown: 0 },
					downloadSize: 10,
					narSize: 40
				})
			},
			expected: {
				receipt: {
					version: 2,
					paths: [],
					subjects: [],
					outcomes: [{ outcome: 'left-upstream', storePath: pathD }],
					planner: {
						willBuild: 0,
						willSubstitute: 1,
						unknown: 0,
						attached: 0,
						adopted: 0,
						leftUpstream: 1
					},
					substitutable: { downloadSize: 10, narSize: 40 },
					uploaded: [],
					failed: [],
					collected: []
				},
				roots: [{ root: rootTwo, applied: true, targets: [] }],
				rootReplacements: [{ name: rootTwo, body: { targets: [] } }],
				negotiatedPaths: [],
				failures: []
			}
		},
		{
			name: 'settles a mixed root with only the destination-held target',
			harness: { valid: [pathA, pathD] },
			options: {
				targets: [target(pathA, rootTwo), target(pathD, rootTwo)],
				partition: partitionOf({
					leftUpstream: [pathD],
					counts: { willBuild: 1, willSubstitute: 1, unknown: 0 }
				}),
				outcomes: new Map<StorePathString, BatchPathOutcome>([
					[pathA, { outcome: 'published', storePath: pathA }]
				])
			},
			expected: {
				receipt: {
					version: 2,
					paths: [pathA],
					subjects: [],
					outcomes: [
						{ outcome: 'built', storePath: pathA },
						{ outcome: 'left-upstream', storePath: pathD }
					],
					planner: {
						willBuild: 1,
						willSubstitute: 1,
						unknown: 0,
						attached: 0,
						adopted: 0,
						leftUpstream: 1
					},
					substitutable: { downloadSize: 0, narSize: 0 },
					uploaded: [pathA],
					failed: [],
					collected: []
				},
				roots: [{ root: rootTwo, applied: true, targets: [pathA] }],
				rootReplacements: [{ name: rootTwo, body: { targets: [pathA] } }],
				negotiatedPaths: [[pathA]],
				failures: []
			}
		},
		{
			name: 'leaves a root unsettled when a failed target shares it with one left upstream',
			harness: {
				valid: [pathB, pathD],
				actions: new Map<StorePathString, UploadDecision['action']>([
					[pathB, 'upload']
				]),
				failUploads: new Set([pathB])
			},
			options: {
				targets: [target(pathB, rootOne), target(pathD, rootOne)],
				partition: partitionOf({
					leftUpstream: [pathD],
					counts: { willBuild: 1, willSubstitute: 1, unknown: 0 }
				}),
				candidates: [pathB]
			},
			expected: {
				receipt: {
					version: 2,
					paths: [],
					subjects: [],
					outcomes: [
						{ outcome: 'failed', storePath: pathB, reason: 'upload' },
						{ outcome: 'left-upstream', storePath: pathD }
					],
					planner: {
						willBuild: 1,
						willSubstitute: 1,
						unknown: 0,
						attached: 0,
						adopted: 0,
						leftUpstream: 1
					},
					substitutable: { downloadSize: 0, narSize: 0 },
					uploaded: [],
					failed: [pathB],
					collected: []
				},
				roots: [{ root: rootOne, applied: false, targets: [pathB] }],
				rootReplacements: [],
				negotiatedPaths: [[pathB]],
				failures: [{ storePath: pathB, reason: 'upload' }]
			}
		},
		{
			name: 'retries a failed streaming upload and reports it uploaded',
			harness: {
				valid: [pathB],
				actions: new Map<StorePathString, UploadDecision['action']>([
					[pathB, 'upload']
				])
			},
			options: {
				targets: [target(pathB, rootOne)],
				candidates: [pathB]
			},
			expected: {
				receipt: {
					version: 2,
					paths: [pathB],
					subjects: [],
					outcomes: [{ outcome: 'built', storePath: pathB }],
					uploaded: [pathB],
					failed: [],
					collected: []
				},
				roots: [{ root: rootOne, applied: true, targets: [pathB] }],
				rootReplacements: [{ name: rootOne, body: { targets: [pathB] } }],
				negotiatedPaths: [[pathB]],
				failures: []
			}
		},
		{
			name: 'fails a vanished target with the collected reason',
			harness: { valid: [] },
			options: {
				targets: [target(pathC, rootOne)]
			},
			expected: {
				receipt: {
					version: 2,
					paths: [],
					subjects: [],
					outcomes: [
						{ outcome: 'failed', storePath: pathC, reason: 'collected' }
					],
					uploaded: [],
					failed: [pathC],
					collected: []
				},
				roots: [{ root: rootOne, applied: false, targets: [pathC] }],
				rootReplacements: [],
				negotiatedPaths: [],
				failures: [{ storePath: pathC, reason: 'collected' }]
			}
		},
		{
			name: 'records a vanished intermediate as collected',
			harness: { valid: [pathA] },
			options: {
				targets: [target(pathA, rootOne)],
				outcomes: new Map<StorePathString, BatchPathOutcome>([
					[pathA, { outcome: 'published', storePath: pathA }]
				]),
				intermediatePaths: [pathG]
			},
			expected: {
				receipt: {
					version: 2,
					paths: [pathA],
					subjects: [],
					outcomes: [{ outcome: 'built', storePath: pathA }],
					uploaded: [pathA],
					failed: [],
					collected: [pathG]
				},
				roots: [{ root: rootOne, applied: true, targets: [pathA] }],
				rootReplacements: [{ name: rootOne, body: { targets: [pathA] } }],
				negotiatedPaths: [[pathA]],
				failures: []
			}
		}
	];

	it.each(scenarios)('$name', async ({ harness: setup, options, expected }) => {
		const harnessed = harness(setup);
		const result = await reconcileWith(harnessed, options);

		expect({
			receipt: result.receipt,
			roots: result.roots,
			rootReplacements: harnessed.rootReplacements,
			negotiatedPaths: harnessed.negotiatedPaths,
			failures: result.failures.map((failure) => ({
				storePath: failure.storePath,
				reason: failure.reason
			}))
		}).toStrictEqual(expected);
	});

	it('applies the declared TTL when it replaces a root', async () => {
		const harnessed = harness({ valid: [pathA] });
		const ttlSeconds = ttlSecondsSchema.parse(3600);

		await reconcileWith(harnessed, {
			targets: [target(pathA, rootOne)],
			ttlSeconds
		});

		expect(harnessed.rootReplacements).toStrictEqual([
			{ name: rootOne, body: { targets: [pathA], ttlSeconds } }
		]);
	});

	it('waits for a deferred verdict before applying the root', async () => {
		const harnessed = harness({
			valid: [pathA],
			actions: new Map<StorePathString, UploadDecision['action']>([
				[pathA, 'commit']
			]),
			commitBehaviour: new Map<StorePathString, 'pending-servable'>([
				[pathA, 'pending-servable']
			])
		});

		const result = await reconcileWith(harnessed, {
			targets: [target(pathA, rootOne)]
		});

		expect({
			outcomes: result.receipt.outcomes,
			roots: result.roots,
			rootReplacements: harnessed.rootReplacements.map((call) => call.name)
		}).toStrictEqual({
			outcomes: [{ outcome: 'built', storePath: pathA }],
			roots: [{ root: rootOne, applied: true, targets: [pathA] }],
			rootReplacements: [rootOne]
		});
	});

	it('withholds the root when a deferred verdict fails', async () => {
		const harnessed = harness({
			valid: [pathA],
			actions: new Map<StorePathString, UploadDecision['action']>([
				[pathA, 'commit']
			]),
			commitBehaviour: new Map<StorePathString, 'pending-failed'>([
				[pathA, 'pending-failed']
			])
		});

		const result = await reconcileWith(harnessed, {
			targets: [target(pathA, rootOne)]
		});

		const [failure] = result.failures;

		expect({
			outcomes: result.receipt.outcomes,
			failed: result.receipt.failed,
			uploaded: result.receipt.uploaded,
			roots: result.roots,
			rootReplacements: harnessed.rootReplacements
		}).toStrictEqual({
			outcomes: [
				{ outcome: 'failed', storePath: pathA, reason: 'verification' }
			],
			failed: [pathA],
			uploaded: [],
			roots: [{ root: rootOne, applied: false, targets: [pathA] }],
			rootReplacements: []
		});
		expect(failure?.cause).toBeInstanceOf(UploadVerificationFailedError);
	});

	it('reports a refused empty settlement against the target it was declared for', async () => {
		const harnessed = harness({ valid: [pathD] });
		const refusal = new Error('root write refused');

		const result = await reconcileWith(harnessed, {
			targets: [target(pathD, rootTwo)],
			partition: partitionOf({ leftUpstream: [pathD] }),
			client: { ...harnessed.client, setRoot: () => Promise.reject(refusal) }
		});

		expect({
			roots: result.roots,
			failed: result.receipt.failed,
			failures: result.failures
		}).toStrictEqual({
			roots: [{ root: rootTwo, applied: false, targets: [] }],
			failed: [pathD],
			failures: [{ storePath: pathD, reason: 'retention', cause: refusal }]
		});
	});

	it('resolves a floating target through the pre-build derivation snapshot', async () => {
		const installable: NixDerivedPathString = `${drvA}^out`;
		const harnessed = harness({
			valid: [pathH],
			actions: new Map<StorePathString, UploadDecision['action']>([
				[pathH, 'upload']
			]),
			derivationOutputs: new Map([[drvA, [pathH]]])
		});

		const result = await reconcileWith(harnessed, {
			targets: [{ installable, root: rootOne }],
			snapshot: { derivations: new Map([[installable, drvA]]) }
		});

		expect({
			outcomes: result.receipt.outcomes,
			uploaded: result.receipt.uploaded,
			roots: result.roots
		}).toStrictEqual({
			outcomes: [{ outcome: 'built', storePath: pathH }],
			uploaded: [pathH],
			roots: [{ root: rootOne, applied: true, targets: [pathH] }]
		});
	});

	it('fails a target whose build result reports a failure', async () => {
		const buildResults: NixBuildResult[] = [
			{
				target: pathC,
				outcome: { kind: 'dependency-failed', message: 'a dependency failed' },
				timesBuilt: 0,
				nonDeterministic: false,
				startTime: 0,
				stopTime: 0
			}
		];
		const harnessed = harness({ valid: [pathC] });

		const result = await reconcileWith(harnessed, {
			targets: [target(pathC, rootOne)],
			buildResults
		});

		expect({
			outcomes: result.receipt.outcomes,
			roots: result.roots,
			negotiatedPaths: harnessed.negotiatedPaths
		}).toStrictEqual({
			outcomes: [{ outcome: 'failed', storePath: pathC, reason: 'build' }],
			roots: [{ root: rootOne, applied: false, targets: [pathC] }],
			negotiatedPaths: []
		});
	});
});
