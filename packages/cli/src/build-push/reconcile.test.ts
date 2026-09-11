import type {
	NixBuildResult,
	NixDerivedPathString,
	NixValidPathInfo
} from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type RootName,
	rootNameSchema,
	type StorePathHash,
	storePathSchema,
	type StorePathString,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	autoBuildStore,
	type BuildSubjectV3Input,
	derivationPathSchema
} from '@cupboard/protocol/build';
import type { RootSetBodyInput } from '@cupboard/protocol/retention';
import {
	commitBatchMaxEntries,
	type UploadDecisionInput,
	uploadDecisionSchema,
	uploadNegotiateMaxPaths,
	type UploadNegotiateResponse
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import type {
	CommitOutcome,
	CommitSession,
	CommitSessionTarget
} from '../client/commit-socket.ts';
import {
	UploadNegotiationMismatchError,
	UploadVerificationFailedError
} from '../errors.ts';
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
const divergentNarHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 0xbb));
const substituterSignature = 'cache.example.org-1:c2ln';

function target(storePath: StorePathString, root?: RootName): ReconcileTarget {
	return {
		installable: storePath,
		expectedPath: storePath,
		...(root !== undefined && { root })
	};
}

// Default metadata represents a local build. Substituted metadata includes a
// signature and sets `ultimate` to false.
function pathInfo(
	storePath: StorePathString,
	isSubstituted = false
): NixValidPathInfo {
	return {
		storePath,
		narHash,
		narSize: 4,
		references: [],
		signatures: isSubstituted ? [substituterSignature] : [],
		ultimate: !isSubstituted
	};
}

function heldSubjects(
	storePaths: readonly StorePathString[]
): readonly BuildSubjectV3Input[] {
	return storePaths.map((storePath) => ({
		origin: 'store-held' as const,
		storePath,
		narHash: narHash.digestHex(),
		buildStore: autoBuildStore
	}));
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
	action: UploadDecisionInput['action']
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
	readonly substituted?: readonly StorePathString[];
	readonly actions?: ReadonlyMap<
		StorePathString,
		UploadDecisionInput['action']
	>;
	readonly failUploads?: ReadonlySet<StorePathString>;
	readonly commitBehaviour?: ReadonlyMap<
		StorePathString,
		'pending-servable' | 'pending-failed'
	>;
	readonly derivationOutputs?: ReadonlyMap<string, readonly StorePathString[]>;
	readonly decisions?: (
		paths: readonly { readonly storePath: string }[]
	) => UploadNegotiateResponse['uploads'];
	readonly failNegotiationFor?: ReadonlySet<StorePathString>;
}

class NegotiationTestError extends Error {}

interface Harness {
	readonly negotiatedPaths: string[][];
	readonly rootReplacements: { name: string; body: RootSetBodyInput }[];
	readonly uploadedKeys: string[];
	readonly clientCommits: StorePathHash[];
	readonly store: ReconcileOptions['store'];
	readonly client: PushClient;
}

function harness(options: HarnessOptions = {}): Harness {
	const negotiatedPaths: string[][] = [];
	const rootReplacements: { name: string; body: RootSetBodyInput }[] = [];
	const uploadedKeys: string[] = [];
	const clientCommits: StorePathHash[] = [];
	const valid = new Set(options.valid);
	const substituted = new Set(options.substituted);
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
					.map((path) =>
						pathInfo(
							storePathSchema.parse(path),
							substituted.has(storePathSchema.parse(path))
						)
					)
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

			if (
				body.paths.some((path) =>
					options.failNegotiationFor?.has(storePathSchema.parse(path.storePath))
				)
			) {
				return Promise.reject(new NegotiationTestError());
			}

			return Promise.resolve({
				uploads:
					options.decisions?.(body.paths) ??
					body.paths.map((path) => {
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
			clientCommits.push(commitTarget.storePathHash);
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

	return {
		negotiatedPaths,
		rootReplacements,
		uploadedKeys,
		clientCommits,
		store,
		client
	};
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
	it('refuses a destination copy whose NAR differs from the build output', async () => {
		const fixture = harness({
			valid: [pathA],
			decisions: (paths) =>
				paths.map((path) =>
					uploadDecisionSchema.parse({
						action: 'skip',
						storePathHash: StorePath.hash(
							storePathSchema.parse(path.storePath)
						),
						narHash: divergentNarHash.toString()
					})
				)
		});
		const result = await reconcileWith(fixture, {
			targets: [target(pathA, rootOne)]
		});

		expect({
			receipt: result.receipt,
			roots: result.roots,
			rootReplacements: fixture.rootReplacements,
			failures: result.failures.map((failure) => ({
				storePath: failure.storePath,
				reason: failure.reason,
				name: failure.cause instanceof Error ? failure.cause.name : undefined
			}))
		}).toStrictEqual({
			receipt: {
				version: 3,
				paths: [],
				subjects: [],
				outcomes: [
					{ outcome: 'failed', storePath: pathA, reason: 'verification' }
				],
				uploaded: [],
				failed: [pathA],
				collected: []
			},
			roots: [{ root: rootOne, applied: false, targets: [pathA] }],
			rootReplacements: [],
			failures: [
				{
					storePath: pathA,
					reason: 'verification',
					name: 'BuildOutputDivergedError'
				}
			]
		});
	});

	it.each([
		{
			name: 'empty',
			valid: [pathA],
			decisions: () => [],
			expectedMismatch: 'missing'
		},
		{
			name: 'partial',
			valid: [pathA, pathB],
			decisions: () => [decisionFor(pathA, 'skip')],
			expectedMismatch: 'missing'
		},
		{
			name: 'duplicate',
			valid: [pathA],
			decisions: () => [decisionFor(pathA, 'skip'), decisionFor(pathA, 'skip')],
			expectedMismatch: 'duplicate'
		},
		{
			name: 'unexpected',
			valid: [pathA],
			decisions: () => [decisionFor(pathB, 'skip')],
			expectedMismatch: 'unexpected'
		}
	])(
		'records every target failed for an $name negotiation response',
		async ({ valid, decisions, expectedMismatch }) => {
			const fixture = harness({ valid, decisions });
			const targets = valid.map((storePath) => target(storePath, rootOne));
			const result = await reconcileWith(fixture, { targets });

			expect({
				outcomes: result.receipt.outcomes,
				failed: result.receipt.failed,
				roots: result.roots,
				failureCauses: result.failures.map((failure) => ({
					name: failure.cause instanceof Error ? failure.cause.name : undefined,
					mismatch:
						failure.cause instanceof UploadNegotiationMismatchError
							? failure.cause.mismatch
							: undefined
				}))
			}).toStrictEqual({
				outcomes: valid.map((storePath) => ({
					outcome: 'failed',
					storePath,
					reason: 'upload'
				})),
				failed: valid,
				roots: [{ root: rootOne, applied: false, targets: valid }],
				failureCauses: valid.map(() => ({
					name: UploadNegotiationMismatchError.name,
					mismatch: expectedMismatch
				}))
			});
		}
	);

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
					version: 3,
					paths: [pathA, pathB],
					subjects: heldSubjects([pathA, pathB]),
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
					{
						name: rootOne,
						body: { retention: { kind: 'inherit' }, targets: [pathA] }
					},
					{
						name: rootTwo,
						body: { retention: { kind: 'inherit' }, targets: [pathB] }
					}
				],
				negotiatedPaths: [[pathA, pathB]],
				failures: []
			}
		},
		{
			name: 'leaves an unconfirmed root untouched and replaces the rest',
			harness: {
				valid: [pathA, pathB],
				actions: new Map<StorePathString, UploadDecisionInput['action']>([
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
					version: 3,
					paths: [pathA],
					subjects: heldSubjects([pathA]),
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
				rootReplacements: [
					{
						name: rootOne,
						body: { retention: { kind: 'inherit' }, targets: [pathA] }
					}
				],
				negotiatedPaths: [[pathA, pathB]],
				failures: [{ storePath: pathB, reason: 'upload' }]
			}
		},
		{
			name: 'still publishes a target that was valid before the invocation',
			harness: {
				valid: [pathC],
				actions: new Map<StorePathString, UploadDecisionInput['action']>([
					[pathC, 'upload']
				])
			},
			options: {
				targets: [target(pathC, rootOne)]
			},
			expected: {
				receipt: {
					version: 3,
					paths: [pathC],
					subjects: heldSubjects([pathC]),
					outcomes: [{ outcome: 'built', storePath: pathC }],
					uploaded: [pathC],
					failed: [],
					collected: []
				},
				roots: [{ root: rootOne, applied: true, targets: [pathC] }],
				rootReplacements: [
					{
						name: rootOne,
						body: { retention: { kind: 'inherit' }, targets: [pathC] }
					}
				],
				negotiatedPaths: [[pathC]],
				failures: []
			}
		},
		{
			name: 'replaces a root with no targets when its only path is left upstream',
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
					version: 3,
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
				rootReplacements: [
					{
						name: rootTwo,
						body: { retention: { kind: 'inherit' }, targets: [] }
					}
				],
				negotiatedPaths: [],
				failures: []
			}
		},
		{
			name: 'replaces a mixed root with only its destination-held target',
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
					version: 3,
					paths: [pathA],
					subjects: heldSubjects([pathA]),
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
				rootReplacements: [
					{
						name: rootTwo,
						body: { retention: { kind: 'inherit' }, targets: [pathA] }
					}
				],
				negotiatedPaths: [[pathA]],
				failures: []
			}
		},
		{
			name: 'leaves a root unchanged when it contains a failed target',
			harness: {
				valid: [pathB, pathD],
				actions: new Map<StorePathString, UploadDecisionInput['action']>([
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
					version: 3,
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
				actions: new Map<StorePathString, UploadDecisionInput['action']>([
					[pathB, 'upload']
				])
			},
			options: {
				targets: [target(pathB, rootOne)],
				candidates: [pathB]
			},
			expected: {
				receipt: {
					version: 3,
					paths: [pathB],
					subjects: heldSubjects([pathB]),
					outcomes: [{ outcome: 'built', storePath: pathB }],
					uploaded: [pathB],
					failed: [],
					collected: []
				},
				roots: [{ root: rootOne, applied: true, targets: [pathB] }],
				rootReplacements: [
					{
						name: rootOne,
						body: { retention: { kind: 'inherit' }, targets: [pathB] }
					}
				],
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
					version: 3,
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
			name: 'uses copied provenance for a substituted intermediate',
			harness: { valid: [pathA, pathG], substituted: [pathG] },
			options: {
				targets: [target(pathA, rootOne)],
				outcomes: new Map<StorePathString, BatchPathOutcome>([
					[pathA, { outcome: 'published', storePath: pathA }]
				]),
				intermediatePaths: [pathG]
			},
			expected: {
				receipt: {
					version: 3,
					paths: [pathA, pathG],
					subjects: [
						...heldSubjects([pathA]),
						{
							origin: 'copied',
							storePath: pathG,
							narHash: narHash.digestHex(),
							signatures: [substituterSignature]
						}
					],
					outcomes: [{ outcome: 'built', storePath: pathA }],
					uploaded: [pathA],
					failed: [],
					collected: []
				},
				roots: [{ root: rootOne, applied: true, targets: [pathA] }],
				rootReplacements: [
					{
						name: rootOne,
						body: { retention: { kind: 'inherit' }, targets: [pathA] }
					}
				],
				negotiatedPaths: [[pathA, pathG]],
				failures: []
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
					version: 3,
					paths: [pathA],
					subjects: heldSubjects([pathA]),
					outcomes: [{ outcome: 'built', storePath: pathA }],
					uploaded: [pathA],
					failed: [],
					collected: [pathG]
				},
				roots: [{ root: rootOne, applied: true, targets: [pathA] }],
				rootReplacements: [
					{
						name: rootOne,
						body: { retention: { kind: 'inherit' }, targets: [pathA] }
					}
				],
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

	it('does not apply the commit batch limit to negotiation', async () => {
		const paths = Array.from(
			{ length: commitBatchMaxEntries + 1 },
			(_, index) =>
				storePathSchema.parse(
					`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
				)
		);
		const harnessed = harness({ valid: paths });
		const result = await reconcileWith(harnessed, {
			targets: paths.map((storePath) => target(storePath))
		});

		expect({
			negotiatedBatchSizes: harnessed.negotiatedPaths.map(
				(batch) => batch.length
			),
			failed: result.receipt.failed
		}).toStrictEqual({
			negotiatedBatchSizes: [commitBatchMaxEntries + 1],
			failed: []
		});
	});

	// `uploadNegotiateMaxPaths` is fixed by the protocol, so reaching a second
	// batch requires a large fixture. Allow extra time on loaded runners.
	it(
		'continues with later batches after one negotiation fails',
		{ timeout: 30_000 },
		async () => {
			const paths = Array.from(
				{ length: uploadNegotiateMaxPaths + 1 },
				(_, index) =>
					storePathSchema.parse(
						`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
					)
			);
			const first = storePathSchema.parse(paths[0]);
			const last = storePathSchema.parse(paths.at(-1));
			const failedPaths = paths.slice(0, uploadNegotiateMaxPaths);

			const harnessed = harness({
				valid: paths,
				failNegotiationFor: new Set([first])
			});
			const result = await reconcileWith(harnessed, {
				targets: [
					...failedPaths.map((storePath) => target(storePath, rootOne)),
					target(last, rootTwo)
				]
			});

			expect({
				negotiatedBatchSizes: harnessed.negotiatedPaths.map(
					(batch) => batch.length
				),
				failed: result.receipt.failed,
				published: result.receipt.paths,
				outcomes: result.receipt.outcomes,
				roots: result.roots,
				rootReplacements: harnessed.rootReplacements,
				failureTypes: result.failures.map((failure) =>
					failure.cause instanceof Error ? failure.cause.constructor : undefined
				)
			}).toStrictEqual({
				negotiatedBatchSizes: [uploadNegotiateMaxPaths, 1],
				failed: failedPaths,
				published: [last],
				outcomes: [
					...failedPaths.map((storePath) => ({
						outcome: 'failed' as const,
						storePath,
						reason: 'upload' as const
					})),
					{ outcome: 'destination-served', storePath: last }
				],
				roots: [
					{ root: rootOne, applied: false, targets: failedPaths },
					{ root: rootTwo, applied: true, targets: [last] }
				],
				rootReplacements: [
					{
						name: rootTwo,
						body: { retention: { kind: 'inherit' }, targets: [last] }
					}
				],
				failureTypes: Array.from(
					{ length: uploadNegotiateMaxPaths },
					() => NegotiationTestError
				)
			});
		}
	);

	it('applies the declared TTL when it replaces a root', async () => {
		const harnessed = harness({ valid: [pathA] });
		const ttlSeconds = ttlSecondsSchema.parse(3600);

		await reconcileWith(harnessed, {
			targets: [target(pathA, rootOne)],
			retention: { kind: 'duration', seconds: ttlSeconds }
		});

		expect(harnessed.rootReplacements).toStrictEqual([
			{
				name: rootOne,
				body: {
					targets: [pathA],
					retention: { kind: 'duration', seconds: ttlSeconds }
				}
			}
		]);
	});

	it('waits for a deferred verdict before applying the root', async () => {
		const harnessed = harness({
			valid: [pathA],
			actions: new Map<StorePathString, UploadDecisionInput['action']>([
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

	it('leaves the root unchanged when a deferred verdict fails', async () => {
		const harnessed = harness({
			valid: [pathA],
			actions: new Map<StorePathString, UploadDecisionInput['action']>([
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

	it('reports a rejected empty root replacement for its declared target', async () => {
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
			actions: new Map<StorePathString, UploadDecisionInput['action']>([
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

describe('reconcileBuild over a shared commit session', () => {
	it('commits over the session and never through the client', async () => {
		const sessionCommits: CommitSessionTarget[] = [];
		const session: CommitSession = {
			commit: (target) => {
				sessionCommits.push(target);

				return Promise.resolve({
					storePathHash: target.storePathHash,
					narHash: target.narHash,
					status: 'committed' as const,
					settled: Promise.resolve()
				});
			},
			close: () => {
				throw new Error('reconciliation must not close the shared run session');
			}
		};
		const harnessed = harness({
			valid: [pathA],
			actions: new Map([[pathA, 'upload' as const]])
		});

		const result = await reconcileBuild({
			targets: [target(pathA)],
			outcomes: new Map<StorePathString, BatchPathOutcome>(),
			candidates: [pathA],
			snapshot: { derivations: new Map() },
			store: harnessed.store,
			client: harnessed.client,
			session,
			createNarArchive: () => emptyStream(),
			compressNar: () => ({
				body: emptyStream(),
				digest: () => ({ narHash, narSize: 4 })
			})
		});

		expect({
			sessionCommits: sessionCommits.map((target) => target.storePathHash),
			clientCommits: harnessed.clientCommits,
			publishedPaths: result.receipt.paths.length
		}).toStrictEqual({
			sessionCommits: [StorePath.hash(pathA)],
			clientCommits: [],
			publishedPaths: 1
		});
	});
});
