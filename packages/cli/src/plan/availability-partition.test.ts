import type {
	Nix,
	NixDerivedPathString,
	NixMissingPartition,
	NixSubstitutablePathInfo,
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
	type AvailabilityPartition,
	type AvailabilityPartitionOptions,
	type AvailabilityTarget,
	type DestinationProbes,
	partitionAvailability,
	RemoteFloatingOutputUnsupportedError,
	UnknownPathsCeilingError,
	type UnknownRequeryOutcome,
	type UpstreamAvailabilityCandidate,
	type UpstreamAvailabilityVerdict
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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	const [result] = await Promise.allSettled([promise]);

	if (result.status === 'fulfilled') {
		return;
	}

	const error: unknown = result.reason;

	return error;
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

function noProbes(): DestinationProbes {
	return {
		destinationServed: () => Promise.resolve(new Set()),
		viewServed: () => Promise.resolve(new Set())
	};
}

function probesFrom(overrides: Partial<DestinationProbes>): DestinationProbes {
	return { ...noProbes(), ...overrides };
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
	| 'querySubstitutablePathInfos'
	| 'querySubstitutablePaths'
	| 'queryValidPaths'
	| 'unreachableSubstituters'
> {
	private missingIndex = 0;

	readonly missingCalls: (readonly string[])[] = [];
	readonly substitutableInfoCalls: (readonly string[])[] = [];
	readonly substitutableCalls: (readonly string[])[] = [];
	readonly validCalls: (readonly string[])[] = [];

	constructor(
		private readonly missing:
			NixMissingPartition | readonly NixMissingPartition[] = emptyMissing(),
		private readonly substitutable: readonly string[] = [],
		private readonly valid: readonly string[] = [],
		private readonly unreachable: readonly UnreachableSubstituter[] = [],
		private readonly substitutableInfos: readonly NixSubstitutablePathInfo[] = []
	) {}

	unreachableSubstituters(): Promise<readonly UnreachableSubstituter[]> {
		return Promise.resolve(this.unreachable);
	}

	queryMissing(targets: readonly string[]): Promise<NixMissingPartition> {
		this.missingCalls.push(targets);
		const answers = 'willBuild' in this.missing ? [this.missing] : this.missing;
		const answer = answers[this.missingIndex] ?? answers.at(-1);
		this.missingIndex += 1;

		return Promise.resolve(answer ?? emptyMissing());
	}

	querySubstitutablePaths(
		paths: readonly string[]
	): Promise<readonly string[]> {
		this.substitutableCalls.push(paths);

		return Promise.resolve(this.substitutable);
	}

	querySubstitutablePathInfos(
		paths: readonly string[]
	): Promise<readonly NixSubstitutablePathInfo[]> {
		this.substitutableInfoCalls.push(paths);
		const requested = new Set(paths);

		return Promise.resolve(
			this.substitutableInfos.filter((info) => requested.has(info.storePath))
		);
	}

	queryValidPaths(paths: readonly string[]): Promise<readonly string[]> {
		this.validCalls.push(paths);
		const requested = new Set(paths);

		return Promise.resolve(
			this.valid.filter((storePath) => requested.has(storePath))
		);
	}
}

function expectedPartition(
	overrides: Partial<AvailabilityPartition> = {}
): AvailabilityPartition {
	return {
		attachOnly: [],
		publishByReference: [],
		leftUpstream: [],
		leftUpstreamRejections: [],
		buildSet: [],
		dependencyBuilds: [],
		dependencyCopies: [],
		unattested: [],
		counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
		downloadSize: 0,
		narSize: 0,
		alreadyValid: [],
		unknownCount: 0,
		ceiling: { value: defaultCeiling.value, source: 'configured' },
		unreachableSubstituters: [],
		...overrides
	};
}

function neverAsked(): Promise<UnknownRequeryOutcome> {
	throw new Error('The unknown paths were re-queried unexpectedly');
}

function alwaysConfirms(): Promise<UpstreamAvailabilityVerdict> {
	return Promise.resolve({ kind: 'confirmed' });
}

function baseOptions(
	overrides: Partial<AvailabilityPartitionOptions> = {}
): AvailabilityPartitionOptions {
	return {
		targets: [],
		storeIdentity: { kind: 'daemon' },
		plannedSubstitutionPolicy: {
			kind: 'known',
			substitute: true,
			alwaysAllowSubstitutes: false
		},
		store: new RecordingStore(),
		destinationProbes: noProbes(),
		rootEnsureResults: new Map(),
		requeryUnknown: neverAsked,
		confirmUpstreamAvailability: alwaysConfirms,
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
				destinationProbes: probesFrom({
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
		const asked: UpstreamAvailabilityCandidate[] = [];

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({ expectedPath: appPath, installable: `${appPath}^out` }),
					target({ expectedPath: appPath, installable: `${appPath}^out` }),
					// Served by the destination, so never a candidate.
					target({ expectedPath: otherPath, installable: otherPath })
				],
				store,
				destinationProbes: probesFrom({
					destinationServed: () => Promise.resolve(new Set([otherPath]))
				}),
				confirmUpstreamAvailability: (candidate) => {
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
		const asked: UpstreamAvailabilityCandidate[] = [];
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
				confirmUpstreamAvailability: (candidate) => {
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
					confirmUpstreamAvailability: () => Promise.resolve(verdict)
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
				destinationProbes: probesFrom({
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
					destinationProbes: probesFrom({
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

	it('does not count Nix work for an attested destination path', async () => {
		const store = new RecordingStore(
			missingWith({
				willSubstitute: [appPath],
				downloadSize: 100,
				narSize: 200
			})
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [target({ expectedPath: appPath, installable: appPath })],
				destinationProbes: probesFrom({
					destinationServed: () => Promise.resolve(new Set([appPath]))
				}),
				attestedServed: () => Promise.resolve(new Set([appPath])),
				store
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({ attachOnly: [appPath] })
		);
		expect(store.missingCalls).toStrictEqual([]);
	});

	it('asks only about the attach-only paths, and adds the unattested path to the build set', async () => {
		const asked: (readonly StorePathString[])[] = [];

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({ expectedPath: appPath, installable: appPath }),
					target({ expectedPath: otherPath, installable: otherPath })
				],
				destinationProbes: probesFrom({
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

	it('does not inspect substitute references for an attach-only target', async () => {
		const derivation = path('22222222222222222222222222222222-app.drv');
		const dependencyOutput = path(
			'33333333333333333333333333333333-dependency'
		);
		const installable: NixDerivedPathString = `${derivation}^out`;
		const store = new RecordingStore(
			missingWith({ unknown: [derivation, dependencyOutput] })
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						expectedPath: appPath,
						installable,
						plannedLocalDerivation: derivation
					})
				],
				plannedLocalClosure: new Set([derivation]),
				plannedLocalOutputs: new Map([[dependencyOutput, [installable]]]),
				destinationProbes: probesFrom({
					destinationServed: () => Promise.resolve(new Set([appPath]))
				}),
				store,
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({
				attachOnly: [appPath],
				ceiling: { value: 0, source: 'configured' }
			})
		);
		expect(store.missingCalls).toStrictEqual([]);
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

		const availability = partitionAvailability(
			baseOptions({
				targets: [target({ installable })],
				store,
				requeryUnknown: () =>
					Promise.resolve({ kind: 'refused', reason: 'not trusted' }),
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);
		const error = await rejectionOf(availability);
		const refusal =
			error instanceof UnknownPathsCeilingError ? error : undefined;

		expect(error).toBeInstanceOf(UnknownPathsCeilingError);
		expect(
			refusal === undefined
				? undefined
				: {
						unknownCount: refusal.unknownCount,
						unknownPaths: refusal.unknownPaths,
						ceiling: refusal.ceiling,
						downloadSize: refusal.downloadSize,
						narSize: refusal.narSize,
						exitCode: refusal.exitCode,
						store: refusal.store,
						unreachableSubstituters: refusal.unreachableSubstituters
					}
		).toStrictEqual({
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

		const availability = partitionAvailability(
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
		const error = await rejectionOf(availability);
		const unknownPaths =
			error instanceof UnknownPathsCeilingError
				? error.unknownPaths
				: undefined;

		expect(error).toBeInstanceOf(UnknownPathsCeilingError);
		expect(unknownPaths).toStrictEqual([
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

		const availability = partitionAvailability(
			baseOptions({
				targets: [target({ installable: unknownPath })],
				store,
				requeryUnknown: () =>
					Promise.resolve({ kind: 'refused', reason: 'not trusted' }),
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);
		const error = await rejectionOf(availability);
		const unreachableSubstituters =
			error instanceof UnknownPathsCeilingError
				? error.unreachableSubstituters
				: undefined;

		expect(error).toBeInstanceOf(UnknownPathsCeilingError);
		expect(unreachableSubstituters).toStrictEqual([
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

	it('refuses a local closure path with no target ownership', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const source = path('22222222222222222222222222222222-source');
		const store = new RecordingStore(
			missingWith({ unknown: [derivation, source] })
		);
		const availabilityTarget = target({
			installable: `${derivation}^out`,
			plannedLocalDerivation: derivation
		});
		const availability = partitionAvailability(
			baseOptions({
				targets: [availabilityTarget],
				plannedLocalClosure: new Set([derivation, source]),
				store,
				requeryUnknown: () =>
					Promise.resolve({
						kind: 'answered',
						partition: missingWith({ unknown: [source] }),
						sizes: new Map()
					}),
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		const error = await rejectionOf(availability);
		const refusal =
			error instanceof UnknownPathsCeilingError ? error : undefined;

		expect(error).toBeInstanceOf(UnknownPathsCeilingError);
		expect(
			refusal === undefined
				? undefined
				: {
						unknownCount: refusal.unknownCount,
						unknownPaths: refusal.unknownPaths,
						ceiling: refusal.ceiling,
						downloadSize: refusal.downloadSize,
						narSize: refusal.narSize,
						exitCode: refusal.exitCode,
						store: refusal.store,
						unreachableSubstituters: refusal.unreachableSubstituters
					}
		).toStrictEqual({
			unknownCount: 1,
			unknownPaths: [
				{
					path: source,
					cause: { kind: 'not-in-store-or-substituters' },
					targets: []
				}
			],
			ceiling: { value: 0, source: 'configured' },
			downloadSize: 0,
			narSize: 0,
			exitCode: 75,
			store: { kind: 'daemon' },
			unreachableSubstituters: []
		});
	});

	it('moves an unknown output into the dependency build set', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const output = path('44444444444444444444444444444444-target');
		const dependencyDerivation = path(
			'22222222222222222222222222222222-dependency.drv'
		);
		const alternativeDerivation = path(
			'55555555555555555555555555555555-dependency.drv'
		);
		const dependencyOutput = path(
			'33333333333333333333333333333333-dependency'
		);
		const dependencyInstallable: NixDerivedPathString = `${dependencyDerivation}^out`;
		const alternativeInstallable: NixDerivedPathString = `${alternativeDerivation}^out`;
		const store = new RecordingStore(
			[
				missingWith({ unknown: [derivation] }),
				missingWith({
					willSubstitute: [output],
					unknown: [dependencyOutput],
					downloadSize: 20,
					narSize: 30
				})
			],
			[],
			[],
			[],
			[
				{
					source: 'daemon',
					storePath: output,
					references: [dependencyOutput],
					downloadSize: 20,
					narSize: 30
				}
			]
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable: `${derivation}^out`,
						expectedPath: output,
						plannedLocalDerivation: derivation
					})
				],
				plannedLocalClosure: new Set([
					derivation,
					dependencyDerivation,
					alternativeDerivation
				]),
				plannedSubstitutableDerivations: new Set([derivation]),
				plannedLocalOutputs: new Map([
					[dependencyOutput, [dependencyInstallable, alternativeInstallable]]
				]),
				store,
				requeryUnknown: () => Promise.resolve({ kind: 'already-fresh' }),
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({
				buildSet: [`${derivation}^out`],
				counts: { willBuild: 1, willSubstitute: 1, unknown: 0 },
				dependencyBuilds: [
					{
						path: dependencyOutput,
						installables: [dependencyInstallable, alternativeInstallable],
						requiredBy: [`${derivation}^out`]
					}
				],
				downloadSize: 20,
				narSize: 30,
				ceiling: { value: 0, source: 'configured' }
			})
		);
		expect(store.missingCalls).toStrictEqual([[`${derivation}^out`], [output]]);
	});

	it('keeps a locally buildable path unresolved when no target requires it', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const output = path('22222222222222222222222222222222-unowned');
		const installable: NixDerivedPathString = `${derivation}^out`;
		const store = new RecordingStore(missingWith({ unknown: [output] }));
		const targets = [target({ installable, expectedPath: undefined })];
		const plannedLocalClosure = new Set([derivation]);
		const plannedLocalOutputs = new Map([[output, [installable]]]);

		const error = await rejectionOf(
			partitionAvailability(
				baseOptions({
					targets,
					plannedLocalClosure,
					plannedLocalOutputs,
					store,
					requeryUnknown: () => Promise.resolve({ kind: 'already-fresh' }),
					ceiling: { value: 0, untrustedFallback: 0 }
				})
			)
		);
		const refusal =
			error instanceof UnknownPathsCeilingError ? error : undefined;

		expect(error).toBeInstanceOf(UnknownPathsCeilingError);
		expect(
			refusal === undefined
				? undefined
				: {
						unknownPaths: refusal.unknownPaths,
						unknownCount: refusal.unknownCount,
						ceiling: refusal.ceiling
					}
		).toStrictEqual({
			unknownPaths: [
				{
					path: output,
					cause: { kind: 'not-in-store-or-substituters' },
					targets: []
				}
			],
			unknownCount: 1,
			ceiling: { value: 0, source: 'configured' }
		});
	});

	it('copies a local closure reference required by a target substitute', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const output = path('22222222222222222222222222222222-target');
		const reference = path('33333333333333333333333333333333-reference');
		const installable: NixDerivedPathString = `${derivation}^out`;
		const store = new RecordingStore([
			missingWith({ unknown: [derivation] }),
			missingWith({ willSubstitute: [output], unknown: [reference] })
		]);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable,
						expectedPath: output,
						plannedLocalDerivation: derivation
					})
				],
				plannedLocalClosure: new Set([derivation, reference]),
				plannedSubstitutableDerivations: new Set([derivation]),
				store,
				requeryUnknown: () => Promise.resolve({ kind: 'already-fresh' }),
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({
				buildSet: [installable],
				dependencyCopies: [{ path: reference, requiredBy: [installable] }],
				counts: { willBuild: 0, willSubstitute: 1, unknown: 0 },
				ceiling: { value: 0, source: 'configured' }
			})
		);
	});

	it('inspects every known output of a multi-output target', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const output = path('22222222222222222222222222222222-target');
		const developmentOutput = path(
			'33333333333333333333333333333333-target-dev'
		);
		const dependencyDerivation = path(
			'44444444444444444444444444444444-dependency.drv'
		);
		const dependencyOutput = path(
			'55555555555555555555555555555555-dependency'
		);
		const installable: NixDerivedPathString = `${derivation}^out,dev`;
		const dependencyInstallable: NixDerivedPathString = `${dependencyDerivation}^out`;
		const store = new RecordingStore(
			[
				missingWith({ unknown: [derivation] }),
				missingWith({
					willSubstitute: [output, developmentOutput],
					unknown: [dependencyOutput],
					downloadSize: 20,
					narSize: 30
				}),
				emptyMissing()
			],
			[],
			[],
			[],
			[
				{
					source: 'daemon',
					storePath: output,
					references: [dependencyOutput],
					downloadSize: 10,
					narSize: 15
				},
				{
					source: 'daemon',
					storePath: developmentOutput,
					references: [dependencyOutput],
					downloadSize: 10,
					narSize: 15
				}
			]
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable,
						plannedLocalDerivation: derivation,
						expectedPath: undefined
					})
				],
				plannedLocalClosure: new Set([derivation, dependencyDerivation]),
				plannedSubstitutableDerivations: new Set([derivation]),
				plannedLocalOutputs: new Map([
					[output, [`${derivation}^out`]],
					[developmentOutput, [`${derivation}^dev`]],
					[dependencyOutput, [dependencyInstallable]]
				]),
				store,
				requeryUnknown: () => Promise.resolve({ kind: 'already-fresh' }),
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({
				buildSet: [installable],
				dependencyBuilds: [
					{
						path: dependencyOutput,
						installables: [dependencyInstallable],
						requiredBy: [installable]
					}
				],
				counts: { willBuild: 1, willSubstitute: 2, unknown: 0 },
				downloadSize: 20,
				narSize: 30,
				ceiling: { value: 0, source: 'configured' }
			})
		);
		expect(store.missingCalls).toStrictEqual([
			[installable],
			[output, developmentOutput]
		]);
	});

	it('counts every path in the selected output substitute closure', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const output = path('22222222222222222222222222222222-target');
		const reference = path('33333333333333333333333333333333-reference');
		const installable: NixDerivedPathString = `${derivation}^out`;
		const store = new RecordingStore(
			[
				missingWith({ unknown: [derivation] }),
				missingWith({
					willSubstitute: [output, reference],
					downloadSize: 27,
					narSize: 41
				})
			],
			[],
			[],
			[],
			[
				{
					source: 'daemon',
					storePath: output,
					references: [reference],
					downloadSize: 20,
					narSize: 30
				},
				{
					source: 'daemon',
					storePath: reference,
					references: [],
					downloadSize: 7,
					narSize: 11
				}
			]
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable,
						expectedPath: output,
						plannedLocalDerivation: derivation
					})
				],
				plannedLocalClosure: new Set([derivation]),
				plannedSubstitutableDerivations: new Set([derivation]),
				store,
				requeryUnknown: () => Promise.resolve({ kind: 'already-fresh' }),
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({
				buildSet: [installable],
				counts: { willBuild: 0, willSubstitute: 2, unknown: 0 },
				downloadSize: 27,
				narSize: 41,
				ceiling: { value: 0, source: 'configured' }
			})
		);
		expect({
			missingCalls: store.missingCalls,
			substitutableInfoCalls: store.substitutableInfoCalls
		}).toStrictEqual({
			missingCalls: [[installable], [output]],
			substitutableInfoCalls: [[output, reference]]
		});
	});

	it('substitutes the offered outputs when the other selected outputs are already valid', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const output = path('22222222222222222222222222222222-target');
		const developmentOutput = path(
			'33333333333333333333333333333333-target-dev'
		);
		const installable: NixDerivedPathString = `${derivation}^out,dev`;
		const store = new RecordingStore(
			[
				missingWith({ unknown: [derivation] }),
				missingWith({
					willSubstitute: [developmentOutput],
					downloadSize: 8,
					narSize: 13
				})
			],
			[],
			[output],
			[],
			[
				{
					source: 'daemon',
					storePath: developmentOutput,
					references: [],
					downloadSize: 8,
					narSize: 13
				}
			]
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable,
						expectedPath: undefined,
						plannedLocalDerivation: derivation
					})
				],
				plannedLocalClosure: new Set([derivation]),
				plannedSubstitutableDerivations: new Set([derivation]),
				plannedLocalOutputs: new Map([
					[output, [`${derivation}^out`]],
					[developmentOutput, [`${derivation}^dev`]]
				]),
				store,
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({
				buildSet: [installable],
				counts: { willBuild: 0, willSubstitute: 1, unknown: 0 },
				downloadSize: 8,
				narSize: 13,
				ceiling: { value: 0, source: 'configured' }
			})
		);
		expect({
			missingCalls: store.missingCalls,
			substitutableInfoCalls: store.substitutableInfoCalls,
			validCalls: store.validCalls
		}).toStrictEqual({
			missingCalls: [[installable], [output, developmentOutput]],
			substitutableInfoCalls: [[developmentOutput]],
			validCalls: [[], [output, developmentOutput]]
		});
	});

	it('keeps a shared derivation in the build count when only one selected output can substitute', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const output = path('22222222222222222222222222222222-target');
		const developmentOutput = path(
			'33333333333333333333333333333333-target-dev'
		);
		const outputInstallable: NixDerivedPathString = `${derivation}^out`;
		const developmentInstallable: NixDerivedPathString = `${derivation}^dev`;
		const developmentRoot = root('github:owner/repo/main/dev');
		const store = new RecordingStore(
			[
				missingWith({ unknown: [derivation] }),
				missingWith({
					willSubstitute: [output],
					unknown: [developmentOutput],
					downloadSize: 8,
					narSize: 13
				}),
				missingWith({
					willSubstitute: [output],
					downloadSize: 8,
					narSize: 13
				}),
				missingWith({ unknown: [developmentOutput] })
			],
			[],
			[],
			[],
			[
				{
					source: 'daemon',
					storePath: output,
					references: [],
					downloadSize: 8,
					narSize: 13
				}
			]
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable: outputInstallable,
						expectedPath: output,
						plannedLocalDerivation: derivation
					}),
					target({
						installable: developmentInstallable,
						expectedPath: developmentOutput,
						plannedLocalDerivation: derivation,
						root: developmentRoot
					})
				],
				plannedLocalClosure: new Set([derivation]),
				plannedSubstitutableDerivations: new Set([derivation]),
				store,
				requeryUnknown: () => Promise.resolve({ kind: 'already-fresh' }),
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({
				buildSet: [outputInstallable, developmentInstallable],
				counts: { willBuild: 1, willSubstitute: 1, unknown: 0 },
				downloadSize: 8,
				narSize: 13,
				ceiling: { value: 0, source: 'configured' }
			})
		);
		expect({
			missingCalls: store.missingCalls,
			substitutableInfoCalls: store.substitutableInfoCalls
		}).toStrictEqual({
			missingCalls: [
				[outputInstallable, developmentInstallable],
				[output, developmentOutput],
				[output],
				[developmentOutput]
			],
			substitutableInfoCalls: [[output]]
		});
	});

	it('counts only the substitutable candidate when another stopped candidate refuses substitution', async () => {
		const appDerivation = path('11111111111111111111111111111111-app.drv');
		const appOutput = path('22222222222222222222222222222222-app');
		const otherDerivation = path('33333333333333333333333333333333-other.drv');
		const otherOutput = path('44444444444444444444444444444444-other');
		const appInstallable: NixDerivedPathString = `${appDerivation}^out`;
		const otherInstallable: NixDerivedPathString = `${otherDerivation}^out`;
		const otherRoot = root('github:owner/repo/main/other');
		const store = new RecordingStore(
			[
				missingWith({ unknown: [appDerivation, otherDerivation] }),
				missingWith({
					willSubstitute: [appOutput, otherOutput],
					downloadSize: 33,
					narSize: 55
				}),
				missingWith({
					willSubstitute: [appOutput],
					downloadSize: 20,
					narSize: 30
				}),
				missingWith({
					willSubstitute: [otherOutput],
					downloadSize: 13,
					narSize: 25
				})
			],
			[],
			[],
			[],
			[
				{
					source: 'daemon',
					storePath: appOutput,
					references: [],
					downloadSize: 20,
					narSize: 30
				},
				{
					source: 'daemon',
					storePath: otherOutput,
					references: [],
					downloadSize: 13,
					narSize: 25
				}
			]
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable: appInstallable,
						expectedPath: appOutput,
						plannedLocalDerivation: appDerivation
					}),
					target({
						installable: otherInstallable,
						expectedPath: otherOutput,
						plannedLocalDerivation: otherDerivation,
						root: otherRoot
					})
				],
				plannedLocalClosure: new Set([appDerivation, otherDerivation]),
				plannedSubstitutableDerivations: new Set([appDerivation]),
				store,
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({
				buildSet: [appInstallable, otherInstallable],
				counts: { willBuild: 1, willSubstitute: 1, unknown: 0 },
				downloadSize: 20,
				narSize: 30,
				ceiling: { value: 0, source: 'configured' }
			})
		);
		expect({
			missingCalls: store.missingCalls,
			substitutableInfoCalls: store.substitutableInfoCalls
		}).toStrictEqual({
			missingCalls: [
				[appInstallable, otherInstallable],
				[appOutput, otherOutput],
				[appOutput],
				[otherOutput]
			],
			substitutableInfoCalls: [[appOutput]]
		});
	});

	it('does not count a build when every selected output is already valid', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const output = path('22222222222222222222222222222222-target');
		const installable: NixDerivedPathString = `${derivation}^out`;
		const store = new RecordingStore(
			[missingWith({ unknown: [derivation] }), emptyMissing()],
			[],
			[output]
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable,
						expectedPath: output,
						plannedLocalDerivation: derivation
					})
				],
				plannedLocalClosure: new Set([derivation]),
				plannedSubstitutableDerivations: new Set(),
				plannedSubstitutionPolicy: { kind: 'unknown' },
				store,
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({
				buildSet: [installable],
				alreadyValid: [output],
				ceiling: { value: 0, source: 'configured' }
			})
		);
		expect({
			missingCalls: store.missingCalls,
			substitutableInfoCalls: store.substitutableInfoCalls
		}).toStrictEqual({
			missingCalls: [[installable], [output]],
			substitutableInfoCalls: []
		});
	});

	it.each([
		{
			name: 'the remote policy is unknown',
			policy: { kind: 'unknown' } as const,
			canDerivationSubstitute: false,
			willBuild: 1,
			willSubstitute: 1,
			bytes: { downloadSize: 20, narSize: 30 },
			infoCalls: [[path('22222222222222222222222222222222-target')]]
		},
		{
			name: 'the selected store always allows substitutes',
			policy: {
				kind: 'known',
				substitute: true,
				alwaysAllowSubstitutes: true
			} as const,
			canDerivationSubstitute: false,
			willBuild: 0,
			willSubstitute: 1,
			bytes: { downloadSize: 20, narSize: 30 },
			infoCalls: [[path('22222222222222222222222222222222-target')]]
		},
		{
			name: 'the derivation refuses substitutes',
			policy: {
				kind: 'known',
				substitute: true,
				alwaysAllowSubstitutes: false
			} as const,
			canDerivationSubstitute: false,
			willBuild: 1,
			willSubstitute: 0,
			bytes: { downloadSize: 0, narSize: 0 },
			infoCalls: []
		},
		{
			name: 'the selected store has substitution disabled',
			policy: {
				kind: 'known',
				substitute: false,
				alwaysAllowSubstitutes: true
			} as const,
			canDerivationSubstitute: true,
			willBuild: 1,
			willSubstitute: 0,
			bytes: { downloadSize: 0, narSize: 0 },
			infoCalls: []
		}
	])(
		'accounts for the substitution policy when $name',
		async ({
			policy,
			canDerivationSubstitute,
			willBuild,
			willSubstitute,
			bytes,
			infoCalls
		}) => {
			const derivation = path('11111111111111111111111111111111-target.drv');
			const output = path('22222222222222222222222222222222-target');
			const installable: NixDerivedPathString = `${derivation}^out`;
			const store = new RecordingStore(
				[
					missingWith({ unknown: [derivation] }),
					missingWith({
						willSubstitute: [output],
						downloadSize: 20,
						narSize: 30
					})
				],
				[],
				[],
				[],
				[
					{
						source: 'daemon',
						storePath: output,
						references: [],
						downloadSize: 20,
						narSize: 30
					}
				]
			);

			const partition = await partitionAvailability(
				baseOptions({
					targets: [
						target({
							installable,
							expectedPath: output,
							plannedLocalDerivation: derivation
						})
					],
					plannedLocalClosure: new Set([derivation]),
					plannedSubstitutableDerivations: new Set(
						canDerivationSubstitute ? [derivation] : []
					),
					plannedSubstitutionPolicy: policy,
					store,
					ceiling: { value: 0, untrustedFallback: 0 }
				})
			);

			expect(partition).toStrictEqual(
				expectedPartition({
					buildSet: [installable],
					counts: { willBuild, willSubstitute, unknown: 0 },
					downloadSize: bytes.downloadSize,
					narSize: bytes.narSize,
					ceiling: { value: 0, source: 'configured' }
				})
			);
			expect({
				missingCalls: store.missingCalls,
				substitutableInfoCalls: store.substitutableInfoCalls
			}).toStrictEqual({
				missingCalls: [[installable], [output]],
				substitutableInfoCalls: infoCalls
			});
		}
	);

	it('builds every selected output when a substituter offers only some of them', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const output = path('22222222222222222222222222222222-target');
		const developmentOutput = path(
			'33333333333333333333333333333333-target-dev'
		);
		const installable: NixDerivedPathString = `${derivation}^out,dev`;
		const store = new RecordingStore([
			missingWith({ unknown: [derivation] }),
			missingWith({
				willSubstitute: [output],
				unknown: [developmentOutput],
				downloadSize: 20,
				narSize: 30
			})
		]);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable,
						expectedPath: undefined,
						plannedLocalDerivation: derivation
					})
				],
				plannedLocalClosure: new Set([derivation]),
				plannedSubstitutableDerivations: new Set([derivation]),
				plannedLocalOutputs: new Map([
					[output, [`${derivation}^out`]],
					[developmentOutput, [`${derivation}^dev`]]
				]),
				store,
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({
				buildSet: [installable],
				counts: { willBuild: 1, willSubstitute: 0, unknown: 0 },
				ceiling: { value: 0, source: 'configured' }
			})
		);
		expect(store.missingCalls).toStrictEqual([
			[installable],
			[output, developmentOutput]
		]);
	});

	it('retains dependency ownership when the target derivation is already present', async () => {
		const appDerivation = path('11111111111111111111111111111111-app.drv');
		const appOutput = path('22222222222222222222222222222222-app');
		const otherDerivation = path('33333333333333333333333333333333-other.drv');
		const otherOutput = path('44444444444444444444444444444444-other');
		const dependencyDerivation = path(
			'55555555555555555555555555555555-dependency.drv'
		);
		const dependencyOutput = path(
			'66666666666666666666666666666666-dependency'
		);
		const appInstallable: NixDerivedPathString = `${appDerivation}^out`;
		const otherInstallable: NixDerivedPathString = `${otherDerivation}^out`;
		const dependencyInstallable: NixDerivedPathString = `${dependencyDerivation}^out`;
		const store = new RecordingStore([
			missingWith({ unknown: [dependencyOutput] }),
			missingWith({ unknown: [dependencyOutput] }),
			emptyMissing(),
			emptyMissing()
		]);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable: appInstallable,
						expectedPath: appOutput,
						plannedLocalDerivation: appDerivation
					}),
					target({
						installable: otherInstallable,
						expectedPath: otherOutput,
						plannedLocalDerivation: otherDerivation
					})
				],
				plannedLocalClosure: new Set([
					appDerivation,
					otherDerivation,
					dependencyDerivation
				]),
				plannedLocalOutputs: new Map([
					[dependencyOutput, [dependencyInstallable]]
				]),
				store,
				requeryUnknown: () => Promise.resolve({ kind: 'already-fresh' }),
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual(
			expectedPartition({
				buildSet: [appInstallable, otherInstallable],
				dependencyBuilds: [
					{
						path: dependencyOutput,
						installables: [dependencyInstallable],
						requiredBy: [appInstallable]
					}
				],
				counts: { willBuild: 1, willSubstitute: 0, unknown: 0 },
				ceiling: { value: 0, source: 'configured' }
			})
		);
		expect(store.missingCalls).toStrictEqual([
			[appInstallable, otherInstallable],
			[appInstallable],
			[otherInstallable]
		]);
	});

	it('counts a target substitution once when both availability queries find it', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const output = path('22222222222222222222222222222222-target');
		const installable: NixDerivedPathString = `${derivation}^out`;
		const substitution = missingWith({
			willSubstitute: [output],
			downloadSize: 20,
			narSize: 30
		});
		const store = new RecordingStore(
			[
				missingWith({
					willSubstitute: [output],
					unknown: [derivation],
					downloadSize: 20,
					narSize: 30
				}),
				substitution
			],
			[],
			[],
			[],
			[
				{
					source: 'daemon',
					storePath: output,
					references: [],
					downloadSize: 20,
					narSize: 30
				}
			]
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable,
						expectedPath: output,
						plannedLocalDerivation: derivation
					}),
					target({ installable: output, expectedPath: output })
				],
				plannedLocalClosure: new Set([derivation]),
				plannedSubstitutableDerivations: new Set([derivation]),
				plannedLocalOutputs: new Map(),
				store,
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect({
			counts: partition.counts,
			downloadSize: partition.downloadSize,
			narSize: partition.narSize
		}).toStrictEqual({
			counts: { willBuild: 0, willSubstitute: 1, unknown: 0 },
			downloadSize: 20,
			narSize: 30
		});
	});

	it('rejects a floating output before querying remote availability', async () => {
		const derivation = path('11111111111111111111111111111111-target.drv');
		const output = path('22222222222222222222222222222222-target');
		const developmentOutput = path(
			'33333333333333333333333333333333-target-dev'
		);
		const outputInstallable: NixDerivedPathString = `${derivation}^out`;
		const developmentInstallable: NixDerivedPathString = `${derivation}^dev`;
		const installable: NixDerivedPathString = `${derivation}^out,dev`;
		const availabilityTarget = target({
			installable,
			expectedPath: developmentOutput,
			plannedLocalDerivation: derivation
		});
		const plannedLocalClosure = new Set([derivation]);
		const plannedFloatingOutputs = new Set([developmentInstallable]);
		const plannedLocalOutputs = new Map([[output, [outputInstallable]]]);
		const plannedSubstitutableDerivations = new Set([derivation]);
		const store = new RecordingStore([
			missingWith({ unknown: [derivation] }),
			missingWith({
				willSubstitute: [output, developmentOutput],
				downloadSize: 20,
				narSize: 30
			})
		]);

		const error = await rejectionOf(
			partitionAvailability(
				baseOptions({
					targets: [availabilityTarget],
					plannedLocalClosure,
					plannedFloatingOutputs,
					plannedLocalOutputs,
					plannedSubstitutableDerivations,
					store,
					ceiling: { value: 0, untrustedFallback: 0 }
				})
			)
		);
		const refusal =
			error instanceof RemoteFloatingOutputUnsupportedError ? error : undefined;

		expect(error).toBeInstanceOf(RemoteFloatingOutputUnsupportedError);
		expect({
			targets: refusal?.targets,
			missingCalls: store.missingCalls
		}).toStrictEqual({
			targets: [
				{
					attr: 'packages.x86_64-linux.app',
					installable,
					floatingOutputs: [developmentInstallable]
				}
			],
			missingCalls: []
		});
	});

	it('keeps dependencies found by a fresh query with their original target', async () => {
		const appDerivation = path('11111111111111111111111111111111-app.drv');
		const appOutput = path('22222222222222222222222222222222-app');
		const otherDerivation = path('33333333333333333333333333333333-other.drv');
		const otherOutput = path('44444444444444444444444444444444-other');
		const dependencyOutput = path(
			'55555555555555555555555555555555-dependency'
		);
		const nestedDerivation = path(
			'66666666666666666666666666666666-nested.drv'
		);
		const nestedOutput = path('77777777777777777777777777777777-nested');
		const appInstallable: NixDerivedPathString = `${appDerivation}^out`;
		const otherInstallable: NixDerivedPathString = `${otherDerivation}^out`;
		const nestedInstallable: NixDerivedPathString = `${nestedDerivation}^out`;
		const store = new RecordingStore([
			missingWith({ unknown: [appDerivation, otherDerivation] }),
			missingWith({
				willSubstitute: [appOutput, otherOutput],
				unknown: [dependencyOutput]
			}),
			missingWith({
				willSubstitute: [appOutput],
				unknown: [dependencyOutput]
			}),
			missingWith({ willSubstitute: [otherOutput] }),
			emptyMissing()
		]);
		const requeryCalls: (readonly StorePathString[])[] = [];

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable: appInstallable,
						expectedPath: appOutput,
						plannedLocalDerivation: appDerivation
					}),
					target({
						installable: otherInstallable,
						expectedPath: otherOutput,
						plannedLocalDerivation: otherDerivation
					})
				],
				plannedLocalClosure: new Set([
					appDerivation,
					otherDerivation,
					nestedDerivation
				]),
				plannedSubstitutableDerivations: new Set([
					appDerivation,
					otherDerivation
				]),
				plannedLocalOutputs: new Map([[nestedOutput, [nestedInstallable]]]),
				store,
				requeryUnknown: (storePaths) => {
					requeryCalls.push(storePaths);

					return Promise.resolve({
						kind: 'answered',
						partition: missingWith({
							willSubstitute: [dependencyOutput],
							unknown: [nestedOutput]
						}),
						sizes: new Map()
					});
				},
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect({ partition, requeryCalls }).toStrictEqual({
			partition: {
				attachOnly: [],
				publishByReference: [],
				leftUpstream: [],
				leftUpstreamRejections: [],
				buildSet: [appInstallable, otherInstallable],
				dependencyBuilds: [
					{
						path: nestedOutput,
						installables: [nestedInstallable],
						requiredBy: [appInstallable]
					}
				],
				dependencyCopies: [],
				unattested: [],
				counts: { willBuild: 1, willSubstitute: 3, unknown: 0 },
				downloadSize: 0,
				narSize: 0,
				alreadyValid: [],
				unknownCount: 0,
				ceiling: { value: 0, source: 'configured' },
				unreachableSubstituters: []
			},
			requeryCalls: [[dependencyOutput]]
		});
	});

	it('realises a target output that another target substitute requires', async () => {
		const appDerivation = path('11111111111111111111111111111111-app.drv');
		const appOutput = path('22222222222222222222222222222222-app');
		const libraryDerivation = path(
			'33333333333333333333333333333333-library.drv'
		);
		const libraryOutput = path('44444444444444444444444444444444-library');
		const appInstallable: NixDerivedPathString = `${appDerivation}^out`;
		const libraryInstallable: NixDerivedPathString = `${libraryDerivation}^out`;
		const libraryRoot = root('github:owner/repo/main/library');
		const store = new RecordingStore(
			[
				missingWith({ unknown: [appDerivation] }),
				missingWith({
					willSubstitute: [appOutput],
					unknown: [libraryOutput],
					downloadSize: 20,
					narSize: 30
				})
			],
			[],
			[],
			[],
			[
				{
					source: 'daemon',
					storePath: appOutput,
					references: [libraryOutput],
					downloadSize: 20,
					narSize: 30
				}
			]
		);

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({
						installable: appInstallable,
						expectedPath: appOutput,
						plannedLocalDerivation: appDerivation
					}),
					target({
						installable: libraryInstallable,
						expectedPath: libraryOutput,
						plannedLocalDerivation: libraryDerivation,
						root: libraryRoot
					})
				],
				plannedLocalClosure: new Set([appDerivation, libraryDerivation]),
				plannedSubstitutableDerivations: new Set([appDerivation]),
				plannedLocalOutputs: new Map([
					[appOutput, [appInstallable]],
					[libraryOutput, [libraryInstallable]]
				]),
				destinationProbes: probesFrom({
					destinationServed: () => Promise.resolve(new Set([libraryOutput]))
				}),
				store,
				requeryUnknown: () => Promise.resolve({ kind: 'already-fresh' }),
				ceiling: { value: 0, untrustedFallback: 0 }
			})
		);

		expect(partition).toStrictEqual({
			attachOnly: [libraryOutput],
			publishByReference: [],
			leftUpstream: [],
			leftUpstreamRejections: [],
			buildSet: [appInstallable],
			dependencyBuilds: [
				{
					path: libraryOutput,
					installables: [libraryInstallable],
					requiredBy: [appInstallable]
				}
			],
			dependencyCopies: [],
			unattested: [],
			counts: { willBuild: 1, willSubstitute: 1, unknown: 0 },
			downloadSize: 20,
			narSize: 30,
			alreadyValid: [],
			unknownCount: 0,
			ceiling: { value: 0, source: 'configured' },
			unreachableSubstituters: []
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
