import { createHash } from 'node:crypto';

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
	type UploadNegotiateResponse,
	type UploadPreviewRequestInput,
	type UploadPreviewResponse,
	uploadPreviewResponseSchema
} from '@cupboard/protocol/upload';
import { ORPCError } from '@orpc/client';
import { describe, expect, it, vi } from 'vitest';

import type {
	CommitOutcome,
	CommitSession,
	CommitSessionTarget
} from '../client/commit-socket.ts';
import {
	BuildOutputDivergedError,
	UploadNegotiationMismatchError,
	UploadVerificationFailedError
} from '../errors.ts';
import { SequentialNarSource } from '../nix/nar-source.ts';
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

class UploadExpiredTestError extends Error {}

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
		preview: (body) =>
			Promise.resolve(
				uploadPreviewResponseSchema.parse({
					uploads: body.paths.map((path) => ({
						action: 'upload' as const,
						storePathHash: path.storePathHash,
						narHash: path.narHash
					}))
				})
			),
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
		createNarArchive: () => new SequentialNarSource(emptyStream),
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

	it('negotiates groups larger than the commit batch limit', async () => {
		const paths = Array.from({ length: 300 }, (_, index) =>
			storePathSchema.parse(
				`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
			)
		);
		const harnessed = harness({ valid: paths });
		const result = await reconcileWith(harnessed, {
			targets: paths.map((storePath) => target(storePath)),
			uploadConcurrency: 1
		});

		expect({
			negotiatedBatchSizes: harnessed.negotiatedPaths.map(
				(batch) => batch.length
			),
			failed: result.receipt.failed
		}).toStrictEqual({
			negotiatedBatchSizes: [1, 2, 4, 8, 16, 32, 64, 128, 45],
			failed: []
		});
		expect(commitBatchMaxEntries).toBeLessThan(128);
	});

	it('continues with later groups after one negotiation fails', async () => {
		const harnessed = harness({
			valid: [pathA, pathB, pathC],
			failNegotiationFor: new Set([pathA])
		});
		const result = await reconcileWith(harnessed, {
			targets: [target(pathA, rootOne), target(pathB, rootTwo), target(pathC)],
			uploadConcurrency: 1
		});

		expect({
			negotiatedBatchSizes: harnessed.negotiatedPaths.map(
				(batch) => batch.length
			),
			failed: result.receipt.failed,
			published: result.receipt.paths,
			roots: result.roots,
			failureTypes: result.failures.map((failure) =>
				failure.cause instanceof Error ? failure.cause.constructor : undefined
			)
		}).toStrictEqual({
			negotiatedBatchSizes: [1, 1, 1],
			failed: [pathA],
			published: [pathB, pathC],
			roots: [
				{ root: rootOne, applied: false, targets: [pathA] },
				{ root: rootTwo, applied: true, targets: [pathB] }
			],
			failureTypes: [NegotiationTestError]
		});
	});

	it('commits every upload before it expires when each upload takes five minutes', async () => {
		const paths = [pathA, pathB, pathC, pathD, pathG];
		const fixture = harness({
			valid: paths,
			actions: new Map(paths.map((path) => [path, 'upload' as const]))
		});
		let minutes = 0;
		const expiresAt = new Map<string, number>();
		const expired: string[] = [];
		const client: PushClient = {
			...fixture.client,
			negotiate: (body) => {
				for (const path of body.paths) {
					expiresAt.set(path.storePathHash, minutes + 15);
				}

				return fixture.client.negotiate(body);
			},
			uploadNar: (r2Key, body) => {
				minutes += 5;

				return fixture.client.uploadNar(r2Key, body);
			},
			commit: (commitTarget, options) => {
				const deadline = expiresAt.get(commitTarget.storePathHash) ?? 0;

				if (minutes > deadline) {
					expired.push(commitTarget.storePathHash);

					return Promise.reject(new UploadExpiredTestError());
				}

				return fixture.client.commit(commitTarget, options);
			}
		};
		const result = await reconcileWith(fixture, {
			targets: paths.map((storePath) => target(storePath)),
			client,
			uploadConcurrency: 1
		});

		expect({ expired, failed: result.receipt.failed }).toStrictEqual({
			expired: [],
			failed: []
		});
	});

	it("starts the next upload after an acknowledgement without waiting for the acknowledged path's verdict", async () => {
		const fixture = harness({
			valid: [pathA, pathB],
			actions: new Map([
				[pathA, 'upload' as const],
				[pathB, 'upload' as const]
			])
		});
		const events: string[] = [];
		const acknowledgements = new Map<string, PromiseWithResolvers<undefined>>();
		const verdicts = new Map<string, PromiseWithResolvers<undefined>>();
		const nameOf = (storePathHash: string): string =>
			storePathHash === StorePath.hash(pathA) ? 'A' : 'B';
		const client: PushClient = {
			...fixture.client,
			negotiate: (body) => {
				events.push(
					`negotiate ${body.paths.map((path) => nameOf(path.storePathHash)).join(',')}`
				);

				return fixture.client.negotiate(body);
			},
			uploadNar: (r2Key, body) => {
				events.push(
					`upload ${r2Key === `staging/${StorePath.basename(pathA)}` ? 'A' : 'B'}`
				);

				return fixture.client.uploadNar(r2Key, body);
			}
		};
		const session: CommitSession = {
			commit: async (commitTarget) => {
				const name = nameOf(commitTarget.storePathHash);
				const acknowledgement = Promise.withResolvers<undefined>();
				const verdict = Promise.withResolvers<undefined>();
				acknowledgements.set(name, acknowledgement);
				verdicts.set(name, verdict);
				events.push(`commit ${name}`);
				await acknowledgement.promise;

				return {
					storePathHash: commitTarget.storePathHash,
					narHash: commitTarget.narHash,
					status: 'pending',
					settled: verdict.promise
				};
			},
			close() {
				return;
			}
		};
		const reconciled = reconcileWith(fixture, {
			targets: [target(pathA), target(pathB)],
			client,
			session,
			uploadConcurrency: 1
		});

		await flushMicrotasks();
		const beforeAcknowledgement = events.splice(0);

		acknowledgements.get('A')?.resolve(undefined);
		await flushMicrotasks();
		const afterAcknowledgement = events.splice(0);

		acknowledgements.get('B')?.resolve(undefined);
		verdicts.get('A')?.resolve(undefined);
		verdicts.get('B')?.resolve(undefined);
		const result = await reconciled;

		expect({
			beforeAcknowledgement,
			afterAcknowledgement,
			servable: result.receipt.paths
		}).toStrictEqual({
			beforeAcknowledgement: ['negotiate A', 'upload A', 'commit A'],
			afterAcknowledgement: ['negotiate B', 'upload B', 'commit B'],
			servable: [pathA, pathB]
		});
	});

	it('cancels the NAR body when its upload fails', async () => {
		const fixture = harness({
			valid: [pathA],
			actions: new Map([[pathA, 'upload' as const]])
		});
		const failure = new Error('upload refused');
		const cancellations: unknown[] = [];

		const result = await reconcileWith(fixture, {
			targets: [target(pathA)],
			client: {
				...fixture.client,
				uploadNar: () => Promise.reject(failure)
			},
			compressNar: () => ({
				body: new ReadableStream<Uint8Array>({
					cancel: (reason) => {
						cancellations.push(reason);
					}
				}),
				digest: () => ({ narHash, narSize: 4 })
			})
		});

		expect({
			cancellations,
			failures: result.failures.map((entry) => entry.reason)
		}).toStrictEqual({
			cancellations: [failure],
			failures: ['upload']
		});
	});

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
	const absent = new UploadVerificationFailedError('losing-upload', 'absent');
	const refusal = new ORPCError('FORBIDDEN');
	const confirmationCases: readonly {
		readonly name: string;
		readonly preview: () => Promise<UploadPreviewResponse>;
		readonly cause: Error;
	}[] = [
		...(['upload', 'commit'] as const).map((action) => ({
			name: `an unconfirmed ${action} decision`,
			preview: () =>
				Promise.resolve({
					uploads: [
						{
							action,
							storePathHash: StorePath.hash(pathA),
							narHash: narHash.toString()
						}
					]
				}),
			cause: absent
		})),
		{
			name: 'a different destination NAR',
			preview: () =>
				Promise.resolve({
					uploads: [
						{
							action: 'skip',
							storePathHash: StorePath.hash(pathA),
							narHash: divergentNarHash.toString()
						}
					]
				}),
			cause: new BuildOutputDivergedError(
				pathA,
				narHash.toString(),
				divergentNarHash.toString()
			)
		},
		{
			name: 'an unrelated destination path',
			preview: () => Promise.resolve({ uploads: [decisionFor(pathB, 'skip')] }),
			cause: new UploadNegotiationMismatchError(
				'unexpected',
				StorePath.hash(pathB),
				narHash.toString()
			)
		},
		{
			name: 'a missing destination decision',
			preview: () => Promise.resolve({ uploads: [] }),
			cause: new UploadNegotiationMismatchError(
				'missing',
				StorePath.hash(pathA),
				narHash.toString()
			)
		},
		{
			name: 'an authentication refusal',
			preview: () => Promise.reject(refusal),
			cause: refusal
		}
	];

	it.each(confirmationCases)(
		'preserves failure for $name after an absent verdict',
		async ({ preview, cause }) => {
			const fixture = harness({
				valid: [pathA],
				actions: new Map([[pathA, 'commit' as const]])
			});
			let previewCalls = 0;
			let commitCalls = 0;
			const result = await reconcileWith(fixture, {
				targets: [target(pathA, rootOne)],
				client: {
					...fixture.client,
					commit: () => {
						commitCalls++;
						return Promise.reject(absent);
					},
					preview: () => {
						previewCalls++;
						return preview();
					}
				}
			});

			expect({
				result,
				previewCalls,
				commitCalls,
				negotiations: fixture.negotiatedPaths,
				uploads: fixture.uploadedKeys,
				roots: fixture.rootReplacements
			}).toStrictEqual({
				result: {
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
					failures: [{ storePath: pathA, reason: 'verification', cause }]
				},
				previewCalls: 1,
				commitCalls: 1,
				negotiations: [[pathA]],
				uploads: [],
				roots: []
			});
		}
	);

	it.each(['mismatch', 'over-quota'] as const)(
		'does not confirm or retry a %s verdict',
		async (status) => {
			const fixture = harness({
				valid: [pathA],
				actions: new Map([[pathA, 'commit' as const]])
			});
			const failure = new UploadVerificationFailedError(
				'refused-upload',
				status
			);
			let previewCalls = 0;
			let commitCalls = 0;
			const result = await reconcileWith(fixture, {
				targets: [target(pathA, rootOne)],
				client: {
					...fixture.client,
					commit: () => {
						commitCalls++;
						return Promise.reject(failure);
					},
					preview: () => {
						previewCalls++;
						return Promise.resolve({ uploads: [decisionFor(pathA, 'skip')] });
					}
				}
			});
			expect({
				result,
				previewCalls,
				commitCalls,
				roots: fixture.rootReplacements
			}).toStrictEqual({
				result: {
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
					failures: [
						{ storePath: pathA, reason: 'verification', cause: failure }
					]
				},
				previewCalls: 0,
				commitCalls: 1,
				roots: []
			});
		}
	);

	it.each(['acknowledgement', 'deferred verdict'] as const)(
		'confirms a matching destination copy after an absent %s without retrying publication',
		async (failurePhase) => {
			const bytes = Buffer.from('compressed NAR');
			const fileHash = NixSha256Hash.fromDigest(
				createHash('sha256').update(bytes).digest()
			).toString();
			const fixture = harness({
				valid: [pathA],
				actions: new Map([[pathA, 'upload' as const]])
			});
			const previewRequests: UploadPreviewRequestInput[] = [];
			const sessionCommits: CommitSessionTarget[] = [];
			const failure = new UploadVerificationFailedError(
				'losing-upload',
				'absent'
			);
			const client: PushClient = {
				...fixture.client,
				uploadNar: async (key, body) => {
					await fixture.client.uploadNar(key, body);
					await Array.fromAsync(body);
				},
				preview: (body) => {
					previewRequests.push(body);
					return Promise.resolve({ uploads: [decisionFor(pathA, 'skip')] });
				}
			};
			const session: CommitSession = {
				commit: (commitTarget) => {
					sessionCommits.push(commitTarget);
					if (failurePhase === 'acknowledgement') {
						return Promise.reject(failure);
					}
					return Promise.resolve({
						storePathHash: commitTarget.storePathHash,
						narHash: commitTarget.narHash,
						status: 'pending',
						settled: Promise.reject(failure)
					});
				},
				close: () => {
					throw new Error(
						'reconciliation must not close the shared run session'
					);
				}
			};
			const result = await reconcileWith(fixture, {
				targets: [target(pathA, rootOne)],
				client,
				compressNar: () => ({
					body: new Response(bytes).body ?? emptyStream(),
					digest: () => ({ narHash, narSize: 4 })
				}),
				session
			});

			expect({
				result,
				previewRequests,
				negotiations: fixture.negotiatedPaths,
				uploadedKeys: fixture.uploadedKeys,
				sessionCommits,
				clientCommits: fixture.clientCommits,
				rootReplacements: fixture.rootReplacements
			}).toStrictEqual({
				result: {
					receipt: {
						version: 3,
						paths: [pathA],
						subjects: heldSubjects([pathA]),
						outcomes: [{ outcome: 'destination-served', storePath: pathA }],
						uploaded: [],
						failed: [],
						collected: []
					},
					roots: [{ root: rootOne, applied: true, targets: [pathA] }],
					failures: []
				},
				previewRequests: [
					{
						paths: [
							{
								storePath: pathA,
								narSize: 4,
								references: [],
								deriver: undefined,
								ca: undefined,
								storePathHash: StorePath.hash(pathA),
								narHash: narHash.toString()
							}
						]
					}
				],
				negotiations: [[pathA]],
				uploadedKeys: [`staging/${StorePath.basename(pathA)}`],
				sessionCommits: [
					{
						uploadId: `upload-${StorePath.basename(pathA)}`,
						storePathHash: StorePath.hash(pathA),
						narHash: narHash.toString(),
						blob: { fileHash, fileSize: bytes.byteLength }
					}
				],
				clientCommits: [],
				rootReplacements: [
					{
						name: rootOne,
						body: { targets: [pathA], retention: { kind: 'inherit' } }
					}
				]
			});
		}
	);

	it('renews an upload while its bytes are sent and stops when the upload ends', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

		try {
			const fixture = harness({
				valid: [pathA],
				actions: new Map([[pathA, 'upload' as const]])
			});
			const transfer = Promise.withResolvers<undefined>();
			const renewals: string[][] = [];
			const client: PushClient = {
				...fixture.client,
				uploadNar: () => transfer.promise
			};
			const session: CommitSession = {
				commit: (commitTarget) =>
					Promise.resolve({
						storePathHash: commitTarget.storePathHash,
						narHash: commitTarget.narHash,
						status: 'committed',
						settled: Promise.resolve()
					}),
				renewUploads: (uploadIds) => {
					renewals.push([...uploadIds]);

					return Promise.resolve();
				},
				close() {
					return;
				}
			};
			const reconciled = reconcileWith(fixture, {
				targets: [target(pathA)],
				client,
				session
			});

			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			const whileSending = [...renewals];

			transfer.resolve(undefined);
			await reconciled;
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

			const uploadId = `upload-${StorePath.basename(pathA)}`;

			expect({ whileSending, afterwards: renewals }).toStrictEqual({
				whileSending: [[uploadId], [uploadId]],
				afterwards: [[uploadId], [uploadId]]
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports how long each upload took', async () => {
		const fixture = harness({
			valid: [pathA],
			actions: new Map([[pathA, 'upload' as const]])
		});
		const times = [1000, 4000];
		const uploads: { storePath: string; durationMs: number }[] = [];

		await reconcileWith(fixture, {
			targets: [target(pathA)],
			uploadClock: {
				now: () => times.shift() ?? 0,
				schedule: scheduleNothing
			},
			uploadReport: {
				observe: () => ({}),
				completed: (storePath, upload) => {
					uploads.push({ storePath, durationMs: upload.durationMs });
				}
			}
		});

		expect(uploads).toStrictEqual([{ storePath: pathA, durationMs: 3000 }]);
	});

	it.each(['upload', 'commit'] as const)(
		'commits %s entries over the session with a declaration only for uploaded bytes',
		async (action) => {
			const bytes = Buffer.from('compressed NAR');
			const fileHash = NixSha256Hash.fromDigest(
				createHash('sha256').update(bytes).digest()
			).toString();
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
					throw new Error(
						'reconciliation must not close the shared run session'
					);
				}
			};
			const harnessed = harness({
				valid: [pathA],
				actions: new Map([[pathA, action]])
			});

			const result = await reconcileBuild({
				targets: [target(pathA)],
				outcomes: new Map<StorePathString, BatchPathOutcome>(),
				candidates: [pathA],
				snapshot: { derivations: new Map() },
				store: harnessed.store,
				client: {
					...harnessed.client,
					uploadNar: async (_key, body) => {
						await Array.fromAsync(body);
					}
				},
				session,
				createNarArchive: () => new SequentialNarSource(emptyStream),
				compressNar: () => ({
					body: new Response(bytes).body ?? emptyStream(),
					digest: () => ({ narHash, narSize: 4 })
				})
			});

			expect({
				sessionCommits,
				clientCommits: harnessed.clientCommits,
				publishedPaths: result.receipt.paths.length
			}).toStrictEqual({
				sessionCommits: [
					{
						uploadId: `upload-${StorePath.basename(pathA)}`,
						storePathHash: StorePath.hash(pathA),
						narHash: narHash.toString(),
						...(action === 'upload' && {
							blob: { fileHash, fileSize: bytes.byteLength }
						})
					}
				],
				clientCommits: [],
				publishedPaths: 1
			});
		}
	);
});

async function flushMicrotasks(): Promise<void> {
	for (let iteration = 0; iteration < 50; iteration += 1) {
		await Promise.resolve();
	}
}

// The duration tests send no renewals.
function scheduleNothing(): () => void {
	return cancelNothing;
}

function cancelNothing(): void {
	return;
}
