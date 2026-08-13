import type {
	Nix,
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
						partition: bypassPartition
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

	it('throws a typed error carrying the counts and sizes when the final unknown count exceeds the ceiling', async () => {
		const unknownPath = path('33333333333333333333333333333333-unknown');
		const store = new RecordingStore(
			missingWith({ unknown: [unknownPath], downloadSize: 1, narSize: 2 })
		);

		let thrown: unknown;

		try {
			await partitionAvailability(
				baseOptions({
					targets: [
						target({ expectedPath: unknownPath, installable: unknownPath })
					],
					store,
					requeryUnknown: () =>
						Promise.resolve({ kind: 'refused', reason: 'not trusted' }),
					ceiling: { value: 0, untrustedFallback: 0 }
				})
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(UnknownPathsCeilingError);

		if (!(thrown instanceof UnknownPathsCeilingError)) {
			return;
		}

		expect({
			unknownCount: thrown.unknownCount,
			ceiling: thrown.ceiling,
			downloadSize: thrown.downloadSize,
			narSize: thrown.narSize,
			exitCode: thrown.exitCode
		}).toStrictEqual({
			unknownCount: 1,
			ceiling: {
				value: 0,
				source: 'untrusted-fallback',
				fallbackReason: 'not trusted'
			},
			downloadSize: 1,
			narSize: 2,
			exitCode: 75
		});
	});

	// A path counted as held nowhere is held nowhere among the substituters
	// that answered, so which ones did not answer belongs beside the counts.
	it('records the substituters nothing could be asked of', async () => {
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
	// look past, so its unknowns are as settled as they get and the configured
	// ceiling stands.
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
