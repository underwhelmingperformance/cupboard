import type {
	Nix,
	NixDerivedPathString,
	NixMissingPartition,
	UnreachableSubstituter
} from '@cupboard/nix';
import {
	type RootName,
	rootNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import type { ParsedRootEnsureResponse } from '@cupboard/protocol/retention';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { describe, expect, it } from 'vitest';

import {
	type AvailabilityCeilingConfig,
	type AvailabilityPartitionOptions,
	type AvailabilityTarget,
	type DestinationAnswers,
	type LeftUpstreamCandidate,
	type LeftUpstreamVerdict,
	partitionAvailability,
	UnknownPathsCeilingError,
	type UnknownRequeryOutcome
} from './availability-partition.ts';

function path(basename: string): StorePathString {
	return storePathSchema.parse(`/nix/store/${basename}`);
}

function root(value: string): RootName {
	return rootNameSchema.parse(value);
}

function target(
	overrides: Partial<AvailabilityTarget> = {}
): AvailabilityTarget {
	return {
		attr: 'packages.x86_64-linux.app',
		installable: path('11111111111111111111111111111111-app'),
		expectedPath: path('11111111111111111111111111111111-app'),
		root: root('github:owner/repo/main/app'),
		...overrides
	};
}

function emptyMissing(): NixMissingPartition {
	return {
		willBuild: [],
		willSubstitute: [],
		unknown: [],
		downloadSize: 0,
		narSize: 0
	};
}

function missingWith(
	overrides: Partial<NixMissingPartition>
): NixMissingPartition {
	return { ...emptyMissing(), ...overrides };
}

function retained(name: RootName): ParsedRootEnsureResponse {
	return {
		status: 'retained',
		root: {
			name,
			expired: false,
			createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
			updatedAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
			targets: []
		}
	};
}

function buildRequired(
	unavailable: readonly StorePathString[]
): ParsedRootEnsureResponse {
	return { status: 'build-required', unavailable: [...unavailable] };
}

function noAnswers(): DestinationAnswers {
	return {
		destinationServed: () => Promise.resolve(new Set()),
		viewServed: () => Promise.resolve(new Set())
	};
}

function answersFrom(
	overrides: Partial<DestinationAnswers>
): DestinationAnswers {
	return { ...noAnswers(), ...overrides };
}

const defaultCeiling: AvailabilityCeilingConfig = {
	value: 5,
	untrustedFallback: 20
};

// A store double that records every call it receives so a test can assert
// exactly what was asked of it, and of nothing else.
class RecordingStore implements Pick<
	Nix,
	| 'queryMissing'
	| 'querySubstitutablePaths'
	| 'queryValidPaths'
	| 'unreachableSubstituters'
> {
	readonly missingCalls: (readonly string[])[] = [];
	readonly substitutableCalls: (readonly string[])[] = [];
	readonly validCalls: (readonly string[])[] = [];

	constructor(
		private readonly missing: NixMissingPartition = emptyMissing(),
		private readonly substitutable: readonly string[] = [],
		private readonly valid: readonly string[] = [],
		private readonly unreachable: readonly UnreachableSubstituter[] = []
	) {}

	unreachableSubstituters(): Promise<readonly UnreachableSubstituter[]> {
		return Promise.resolve(this.unreachable);
	}

	queryMissing(targets: readonly string[]): Promise<NixMissingPartition> {
		this.missingCalls.push(targets);

		return Promise.resolve(this.missing);
	}

	querySubstitutablePaths(
		paths: readonly string[]
	): Promise<readonly string[]> {
		this.substitutableCalls.push(paths);

		return Promise.resolve(this.substitutable);
	}

	queryValidPaths(paths: readonly string[]): Promise<readonly string[]> {
		this.validCalls.push(paths);

		return Promise.resolve(this.valid);
	}
}

function neverAsked(): Promise<UnknownRequeryOutcome> {
	throw new Error('The unknown paths were re-queried unexpectedly');
}

function alwaysConfirms(): Promise<LeftUpstreamVerdict> {
	return Promise.resolve({ kind: 'confirmed' });
}

function baseOptions(
	overrides: Partial<AvailabilityPartitionOptions> = {}
): AvailabilityPartitionOptions {
	return {
		targets: [],
		storeIdentity: { kind: 'daemon' },
		store: new RecordingStore(),
		destinationAnswers: noAnswers(),
		rootEnsureResults: new Map(),
		requeryUnknown: neverAsked,
		confirmLeftUpstream: alwaysConfirms,
		ceiling: defaultCeiling,
		...overrides
	};
}

describe('partitionAvailability', () => {
	const appRoot = root('github:owner/repo/main/app');
	const appPath = path('11111111111111111111111111111111-app');
	const otherPath = path('22222222222222222222222222222222-other');
	const retainedResult = retained(appRoot);
	const buildRequiredMissingSelf = buildRequired([appPath]);
	const buildRequiredMissingOther = buildRequired([otherPath]);

	it.each([
		{
			name: 'a target whose root is retained is attachOnly',
			target: target(),
			rootEnsureResults: new Map([[appRoot, retainedResult]]),
			expected: {
				attachOnly: [appPath],
				publishByReference: [],
				leftUpstream: [],
				buildSet: []
			}
		},
		{
			name: 'a target absent from its build-required root falls through to further classification',
			target: target(),
			rootEnsureResults: new Map([[appRoot, buildRequiredMissingSelf]]),
			expected: {
				attachOnly: [],
				publishByReference: [],
				leftUpstream: [],
				buildSet: [appPath]
			}
		},
		{
			name: "a target present in its build-required root's list, though not the whole root, is still attachOnly",
			target: target(),
			rootEnsureResults: new Map([[appRoot, buildRequiredMissingOther]]),
			expected: {
				attachOnly: [appPath],
				publishByReference: [],
				leftUpstream: [],
				buildSet: []
			}
		},
		{
			name: 'a target with no known output path always joins the build set',
			target: target({ expectedPath: undefined }),
			rootEnsureResults: new Map(),
			expected: {
				attachOnly: [],
				publishByReference: [],
				leftUpstream: [],
				buildSet: [appPath]
			}
		}
	])('$name', async ({ target: theTarget, rootEnsureResults, expected }) => {
		const partition = await partitionAvailability(
			baseOptions({ targets: [theTarget], rootEnsureResults })
		);

		expect({
			attachOnly: partition.attachOnly,
			publishByReference: partition.publishByReference,
			leftUpstream: partition.leftUpstream,
			buildSet: partition.buildSet
		}).toStrictEqual(expected);
	});

	it('publishes by reference when a reuse view serves the path, never left upstream, even when it is also externally substitutable', async () => {
		const store = new RecordingStore(emptyMissing(), [appPath], []);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [target({ expectedPath: appPath })],
				store,
				destinationAnswers: answersFrom({
					viewServed: () => Promise.resolve(new Set([appPath]))
				})
			})
		);

		expect({
			attachOnly: partition.attachOnly,
			publishByReference: partition.publishByReference,
			leftUpstream: partition.leftUpstream
		}).toStrictEqual({
			attachOnly: [],
			publishByReference: [appPath],
			leftUpstream: []
		});
	});

	it('leaves a path upstream only once destination- and view-served paths are excluded from the substitutable answer', async () => {
		const store = new RecordingStore(emptyMissing(), [appPath], [appPath]);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [target({ expectedPath: appPath })],
				store
			})
		);

		expect(partition.leftUpstream).toStrictEqual([appPath]);
	});

	it('confirms only the candidates it would leave upstream, once per path', async () => {
		const store = new RecordingStore(
			emptyMissing(),
			[appPath, otherPath],
			[appPath, otherPath]
		);
		const asked: LeftUpstreamCandidate[] = [];

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({ expectedPath: appPath, installable: `${appPath}^out` }),
					target({ expectedPath: appPath, installable: `${appPath}^out` }),
					// Served by the destination, so never a candidate.
					target({ expectedPath: otherPath, installable: otherPath })
				],
				store,
				destinationAnswers: answersFrom({
					destinationServed: () => Promise.resolve(new Set([otherPath]))
				}),
				confirmLeftUpstream: (candidate) => {
					asked.push(candidate);

					return Promise.resolve({ kind: 'confirmed' });
				}
			})
		);

		expect({
			asked,
			leftUpstream: partition.leftUpstream,
			attachOnly: partition.attachOnly,
			rejections: partition.leftUpstreamRejections
		}).toStrictEqual({
			asked: [{ installable: `${appPath}^out`, storePath: appPath }],
			leftUpstream: [appPath, appPath],
			attachOnly: [otherPath],
			rejections: []
		});
	});

	it('builds every alias of a shared path when any installable refuses substitution', async () => {
		const store = new RecordingStore(emptyMissing(), [appPath], [appPath]);
		const asked: LeftUpstreamCandidate[] = [];
		const substitutable: NixDerivedPathString = `${path(
			'33333333333333333333333333333333-first.drv'
		)}^out`;
		const nonSubstitutable: NixDerivedPathString = `${path(
			'44444444444444444444444444444444-second.drv'
		)}^out`;

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({ expectedPath: appPath, installable: substitutable }),
					target({ expectedPath: appPath, installable: nonSubstitutable })
				],
				store,
				confirmLeftUpstream: (candidate) => {
					asked.push(candidate);

					return Promise.resolve(
						candidate.installable === nonSubstitutable
							? { kind: 'substitutes-not-allowed' }
							: { kind: 'confirmed' }
					);
				}
			})
		);

		expect({
			asked,
			leftUpstream: partition.leftUpstream,
			buildSet: partition.buildSet,
			rejections: partition.leftUpstreamRejections
		}).toStrictEqual({
			asked: [
				{ installable: substitutable, storePath: appPath },
				{ installable: nonSubstitutable, storePath: appPath }
			],
			leftUpstream: [],
			buildSet: [substitutable, nonSubstitutable],
			rejections: [{ kind: 'substitutes-not-allowed', storePath: appPath }]
		});
	});

	it.each([
		{
			name: 'substitution is turned off',
			verdict: { kind: 'substitution-disabled' } as const
		},
		{
			name: 'the derivation withholds substitution',
			verdict: { kind: 'substitutes-not-allowed' } as const
		},
		{
			name: 'the derivation cannot be read',
			verdict: {
				kind: 'derivation-unreadable',
				errorName: 'UnexpectedNarShapeError'
			} as const
		},
		{
			name: 'the daemon does not trust the confirmation connection',
			verdict: { kind: 'connection-not-trusted', trust: 'not-trusted' } as const
		},
		{
			name: 'a reference is not served upstream',
			verdict: { kind: 'closure-not-served', missing: otherPath } as const
		},
		{
			name: 'the closure is larger than the walk allows',
			verdict: { kind: 'closure-over-cap', maxPaths: 10 } as const
		}
	])(
		'builds a candidate instead of leaving it upstream when $name',
		async ({ verdict }) => {
			const store = new RecordingStore(emptyMissing(), [appPath], [appPath]);

			const partition = await partitionAvailability(
				baseOptions({
					targets: [
						target({ expectedPath: appPath, installable: `${appPath}^out` })
					],
					store,
					confirmLeftUpstream: () => Promise.resolve(verdict)
				})
			);

			expect({
				leftUpstream: partition.leftUpstream,
				buildSet: partition.buildSet,
				rejections: partition.leftUpstreamRejections
			}).toStrictEqual({
				leftUpstream: [],
				buildSet: [`${appPath}^out`],
				rejections: [{ ...verdict, storePath: appPath }]
			});
		}
	);

	it('does not ask the cache about attestations when the run does not require them', async () => {
		const partition = await partitionAvailability(
			baseOptions({
				targets: [target({ expectedPath: appPath, installable: appPath })],
				destinationAnswers: answersFrom({
					destinationServed: () => Promise.resolve(new Set([appPath]))
				})
			})
		);

		expect({
			attachOnly: partition.attachOnly,
			buildSet: partition.buildSet,
			unattested: partition.unattested
		}).toStrictEqual({
			attachOnly: [appPath],
			buildSet: [],
			unattested: []
		});
	});

	it.each([
		{
			name: 'attaches a served path the cache also holds an attestation for',
			attested: [appPath],
			expected: { attachOnly: [appPath], buildSet: [], unattested: [] }
		},
		{
			name: 'builds a served path the cache holds no attestation for',
			attested: [],
			expected: { attachOnly: [], buildSet: [appPath], unattested: [appPath] }
		}
	])(
		'with attested availability required, $name',
		async ({ attested, expected }) => {
			const asked: (readonly StorePathString[])[] = [];

			const partition = await partitionAvailability(
				baseOptions({
					targets: [target({ expectedPath: appPath, installable: appPath })],
					destinationAnswers: answersFrom({
						destinationServed: () => Promise.resolve(new Set([appPath]))
					}),
					attestedServed: (paths) => {
						asked.push(paths);

						return Promise.resolve(new Set(attested));
					}
				})
			);

			expect({
				asked,
				attachOnly: partition.attachOnly,
				buildSet: partition.buildSet,
				unattested: partition.unattested
			}).toStrictEqual({ asked: [[appPath]], ...expected });
		}
	);

	it('asks only about the attach-only paths, and adds the unattested path to the build set', async () => {
		const asked: (readonly StorePathString[])[] = [];

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({ expectedPath: appPath, installable: appPath }),
					target({ expectedPath: otherPath, installable: otherPath })
				],
				destinationAnswers: answersFrom({
					destinationServed: () => Promise.resolve(new Set([appPath]))
				}),
				attestedServed: (paths) => {
					asked.push(paths);

					return Promise.resolve(new Set());
				}
			})
		);

		expect({
			asked,
			attachOnly: partition.attachOnly,
			buildSet: partition.buildSet,
			unattested: partition.unattested
		}).toStrictEqual({
			asked: [[appPath]],
			attachOnly: [],
			buildSet: [appPath, otherPath],
			unattested: [appPath]
		});
	});

	it('builds an unattested path its retained root still serves', async () => {
		const partition = await partitionAvailability(
			baseOptions({
				targets: [target({ expectedPath: appPath, installable: appPath })],
				rootEnsureResults: new Map([[appRoot, retainedResult]]),
				attestedServed: () => Promise.resolve(new Set())
			})
		);

		expect({
			attachOnly: partition.attachOnly,
			buildSet: partition.buildSet,
			unattested: partition.unattested
		}).toStrictEqual({
			attachOnly: [],
			buildSet: [appPath],
			unattested: [appPath]
		});
	});

	it('re-queries only the unknown paths, and folds the fresh answer in', async () => {
		const unknownPath = path('33333333333333333333333333333333-unknown');
		const store = new RecordingStore(
			missingWith({ unknown: [unknownPath], downloadSize: 10, narSize: 20 })
		);
		const bypassPartition = missingWith({
			willSubstitute: [unknownPath],
			downloadSize: 5,
			narSize: 8
		});
		let bypassCalls: (readonly string[])[] = [];

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({ expectedPath: unknownPath, installable: unknownPath })
				],
				store,
				requeryUnknown: (storePaths) => {
					bypassCalls = [...bypassCalls, [...storePaths]];

					return Promise.resolve({
						kind: 'answered',
						partition: bypassPartition,
						sizes: new Map()
					});
				}
			})
		);

		expect({
			bypassCalls,
			primaryMissingCalls: store.missingCalls.length,
			counts: partition.counts,
			downloadSize: partition.downloadSize,
			narSize: partition.narSize,
			ceiling: partition.ceiling
		}).toStrictEqual({
			bypassCalls: [[unknownPath]],
			primaryMissingCalls: 1,
			counts: { willBuild: 0, willSubstitute: 1, unknown: 0 },
			downloadSize: 15,
			narSize: 28,
			ceiling: { value: defaultCeiling.value, source: 'configured' }
		});
	});

	// The fresh answer walks the closures of the paths it resolved, so it names
	// paths the first answer classified by another route. Each of those is one
	// path, however many answers named it.
	it('counts a path both answers name once', async () => {
		const unknownPath = path('33333333333333333333333333333333-unknown');
		const sharedSubstitute = path('44444444444444444444444444444444-shared');
		const sharedBuild = path('55555555555555555555555555555555-built');
		const store = new RecordingStore(
			missingWith({
				willBuild: [sharedBuild],
				willSubstitute: [sharedSubstitute],
				unknown: [unknownPath],
				downloadSize: 10,
				narSize: 20
			})
		);
		// The fresh answer classifies the unknown path, names the shared paths
		// again, and leaves one the first answer had already classified unknown.
		// Its bytes cover both paths it classified as substitutable.
		const bypassPartition = missingWith({
			willBuild: [sharedBuild],
			willSubstitute: [unknownPath, sharedSubstitute],
			unknown: [sharedBuild],
			downloadSize: 5 + 3,
			narSize: 8 + 6
		});
		const bypassSizes = new Map([
			[unknownPath, { downloadSize: 5, narSize: 8 }],
			[sharedSubstitute, { downloadSize: 3, narSize: 6 }]
		]);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({ expectedPath: unknownPath, installable: unknownPath })
				],
				store,
				requeryUnknown: () =>
					Promise.resolve({
						kind: 'answered',
						partition: bypassPartition,
						sizes: bypassSizes
					})
			})
		);

		// The shared path's bytes are in both answers' totals and belong in the
		// merged one once, so the fresh answer's figures for it come back out:
		// 10 + 8 - 3 to download, and 20 + 14 - 6 of NAR.
		expect({
			counts: partition.counts,
			unknownCount: partition.unknownCount,
			downloadSize: partition.downloadSize,
			narSize: partition.narSize
		}).toStrictEqual({
			counts: { willBuild: 1, willSubstitute: 2, unknown: 0 },
			unknownCount: 0,
			downloadSize: 15,
			narSize: 28
		});
	});

	it.each([
		{ name: 'not-trusted', trust: 'not-trusted' as const },
		{ name: 'unknown', trust: 'unknown' as const }
	])(
		'falls back to the nonzero ceiling when a re-query is refused because the daemon is $name',
		async ({ trust }) => {
			const unknownPath = path('33333333333333333333333333333333-unknown');
			const store = new RecordingStore(missingWith({ unknown: [unknownPath] }));

			const partition = await partitionAvailability(
				baseOptions({
					targets: [
						target({ expectedPath: unknownPath, installable: unknownPath })
					],
					store,
					requeryUnknown: () =>
						Promise.resolve({
							kind: 'refused',
							reason: `the daemon connection is ${trust}`
						}),
					ceiling: { value: 0, untrustedFallback: 20 }
				})
			);

			expect(partition.ceiling).toStrictEqual({
				value: 20,
				source: 'untrusted-fallback',
				fallbackReason: `the daemon connection is ${trust}`
			});
		}
	);

	it('throws a typed error carrying the details, ceiling, sizes and store when the final unknown count exceeds the ceiling', async () => {
		const unknownDerivation = path(
			'33333333333333333333333333333333-unknown.drv'
		);
		const installable: NixDerivedPathString = `${unknownDerivation}^out`;
		const store = new RecordingStore(
			missingWith({ unknown: [unknownDerivation], downloadSize: 1, narSize: 2 })
		);

		let thrown: unknown;

		try {
			await partitionAvailability(
				baseOptions({
					targets: [target({ installable })],
					store,
					requeryUnknown: () =>
						Promise.resolve({ kind: 'refused', reason: 'not trusted' }),
					ceiling: { value: 0, untrustedFallback: 0 }
				})
			);
		} catch (error) {
			thrown = error;
		}

		if (!(thrown instanceof UnknownPathsCeilingError)) {
			expect.unreachable(
				'the partition must refuse with UnknownPathsCeilingError'
			);
		}

		// The target is attributed through its installable's store path, with
		// the output selection stripped.
		expect({
			unknownCount: thrown.unknownCount,
			unknownPaths: thrown.unknownPaths,
			ceiling: thrown.ceiling,
			downloadSize: thrown.downloadSize,
			narSize: thrown.narSize,
			exitCode: thrown.exitCode,
			store: thrown.store,
			unreachableSubstituters: thrown.unreachableSubstituters
		}).toStrictEqual({
			unknownCount: 1,
			unknownPaths: [
				{
					path: unknownDerivation,
					cause: { kind: 'missing-derivation' },
					targets: [
						{
							attr: 'packages.x86_64-linux.app',
							installable
						}
					]
				}
			],
			ceiling: {
				value: 0,
				source: 'untrusted-fallback',
				fallbackReason: 'not trusted'
			},
			downloadSize: 1,
			narSize: 2,
			exitCode: 75,
			store: { kind: 'daemon' },
			unreachableSubstituters: []
		});
	});

	it.each([
		{
			name: 'a derivation path as missing even when the re-query was refused',
			basename: '33333333333333333333333333333333-unknown.drv',
			requery: { kind: 'refused' as const, reason: 'not trusted' },
			expectedCause: { kind: 'missing-derivation' }
		},
		{
			name: 'an output path with a refused re-query to the unrefreshed substituter result',
			basename: '44444444444444444444444444444444-unknown',
			requery: { kind: 'refused' as const, reason: 'not trusted' },
			expectedCause: {
				kind: 'substituter-result-not-refreshed',
				reason: 'not trusted'
			}
		},
		{
			name: 'an output path that a fresh answer still left unknown to no substituter holding it',
			basename: '44444444444444444444444444444444-unknown',
			requery: undefined,
			expectedCause: { kind: 'not-in-store-or-substituters' }
		}
	])('attributes $name', async ({ basename, requery, expectedCause }) => {
		const unknownPath = path(basename);
		const store = new RecordingStore(missingWith({ unknown: [unknownPath] }));

		let thrown: unknown;

		try {
			await partitionAvailability(
				baseOptions({
					targets: [target({ installable: unknownPath })],
					store,
					requeryUnknown: () =>
						Promise.resolve(
							requery ?? {
								kind: 'answered',
								partition: missingWith({ unknown: [unknownPath] }),
								sizes: new Map()
							}
						),
					ceiling: { value: 0, untrustedFallback: 0 }
				})
			);
		} catch (error) {
			thrown = error;
		}

		if (!(thrown instanceof UnknownPathsCeilingError)) {
			expect.unreachable(
				'the partition must refuse with UnknownPathsCeilingError'
			);
		}

		expect(thrown.unknownPaths).toStrictEqual([
			{
				path: unknownPath,
				cause: expectedCause,
				targets: [
					{
						attr: 'packages.x86_64-linux.app',
						installable: unknownPath
					}
				]
			}
		]);
	});

	it('carries the substituters the plan could not query into the refusal', async () => {
		const unknownPath = path('44444444444444444444444444444444-unknown');
		const store = new RecordingStore(
			missingWith({ unknown: [unknownPath] }),
			[],
			[],
			[{ uri: 'https://cache.example.test', reason: 'no-cache-info' }]
		);

		let thrown: unknown;

		try {
			await partitionAvailability(
				baseOptions({
					targets: [target({ installable: unknownPath })],
					store,
					requeryUnknown: () =>
						Promise.resolve({ kind: 'refused', reason: 'not trusted' }),
					ceiling: { value: 0, untrustedFallback: 0 }
				})
			);
		} catch (error) {
			thrown = error;
		}

		if (!(thrown instanceof UnknownPathsCeilingError)) {
			expect.unreachable(
				'the partition must refuse with UnknownPathsCeilingError'
			);
		}

		expect(thrown.unreachableSubstituters).toStrictEqual([
			'https://cache.example.test'
		]);
	});

	it('counts a planned local derivation as build work instead of unknown availability', async () => {
		const derivations = Array.from({ length: 6 }, (_, index) =>
			path(`${String(index + 1).repeat(32)}-target-${String(index)}.drv`)
		);
		const targets = derivations.map((derivation, index) =>
			target({
				installable: `${derivation}^out`,
				expectedPath: path(
					`${String(index + 1).repeat(32)}-target-${String(index)}`
				),
				plannedLocalDerivation: derivation,
				root: root(`github:owner/repo/main/target-${String(index)}`)
			})
		);
		const store = new RecordingStore(missingWith({ unknown: derivations }));

		const partition = await partitionAvailability(
			baseOptions({
				targets,
				store,
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect({
			buildSet: partition.buildSet,
			counts: partition.counts,
			unknownCount: partition.unknownCount,
			ceiling: partition.ceiling
		}).toStrictEqual({
			buildSet: targets.map(({ installable }) => installable),
			counts: { willBuild: 6, willSubstitute: 0, unknown: 0 },
			unknownCount: 0,
			ceiling: { value: 0, source: 'configured' }
		});
	});

	it('keeps an unknown path without matching local-copy evidence under the ceiling', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const unknown = path('22222222222222222222222222222222-source');
		const store = new RecordingStore(
			missingWith({ unknown: [derivation, unknown] })
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable: `${derivation}^out`,
						plannedLocalDerivation: derivation
					})
				],
				store,
				requeryUnknown: () => Promise.resolve({ kind: 'already-fresh' }),
				ceiling: { value: 1, untrustedFallback: 1 }
			})
		);

		expect({
			counts: partition.counts,
			unknownCount: partition.unknownCount,
			ceiling: partition.ceiling
		}).toStrictEqual({
			counts: { willBuild: 1, willSubstitute: 0, unknown: 1 },
			unknownCount: 1,
			ceiling: { value: 1, source: 'configured' }
		});
	});

	// A path counted as held nowhere is held nowhere among the substituters
	// that answered, so which ones did not answer belongs beside the counts.
	it('records the substituters that could not be queried', async () => {
		const unreachable = [
			{ uri: 'https://down.example', reason: 'no-cache-info' as const }
		];
		const store = new RecordingStore(emptyMissing(), [], [], unreachable);

		const partition = await partitionAvailability(
			baseOptions({ targets: [target()], store })
		);

		expect(partition.unreachableSubstituters).toStrictEqual(unreachable);
	});

	// A store asking the substituters as the question is put has no cache to
	// look past, so a second query would classify no more of its unknowns and
	// the configured ceiling stands.
	it('keeps the configured ceiling when the first answer was already fresh', async () => {
		const unknownPath = path('33333333333333333333333333333333-unknown');
		const store = new RecordingStore(missingWith({ unknown: [unknownPath] }));

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({ expectedPath: unknownPath, installable: unknownPath })
				],
				store,
				requeryUnknown: () => Promise.resolve({ kind: 'already-fresh' }),
				ceiling: { value: 5, untrustedFallback: 20 }
			})
		);

		expect({
			ceiling: partition.ceiling,
			unknown: partition.counts.unknown
		}).toStrictEqual({
			ceiling: { value: 5, source: 'configured' },
			unknown: 1
		});
	});

	it('does not re-query, and applies the configured ceiling, when nothing is unknown', async () => {
		const store = new RecordingStore(emptyMissing());

		const partition = await partitionAvailability(
			baseOptions({
				targets: [target()],
				store,
				rootEnsureResults: new Map([[appRoot, retainedResult]])
			})
		);

		expect(partition.ceiling).toStrictEqual({
			value: defaultCeiling.value,
			source: 'configured'
		});
	});
});
