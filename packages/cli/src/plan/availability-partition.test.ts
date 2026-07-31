import type { Nix, NixDaemonTrust, NixMissingPartition } from '@cupboard/nix';
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
	partitionAvailability,
	UnknownPathsCeilingError
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
	'queryMissing' | 'querySubstitutablePaths' | 'queryValidPaths'
> {
	readonly missingCalls: (readonly string[])[] = [];
	readonly substitutableCalls: (readonly string[])[] = [];
	readonly validCalls: (readonly string[])[] = [];

	constructor(
		private readonly missing: NixMissingPartition = emptyMissing(),
		private readonly substitutable: readonly string[] = [],
		private readonly valid: readonly string[] = []
	) {}

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

function alwaysTrusted(): Promise<NixDaemonTrust> {
	return Promise.resolve('trusted');
}

function neverOpened(): Pick<Nix, 'queryMissing'> {
	return {
		queryMissing() {
			throw new Error('the bypass client must not be opened here');
		}
	};
}

function baseOptions(
	overrides: Partial<AvailabilityPartitionOptions> = {}
): AvailabilityPartitionOptions {
	return {
		targets: [],
		store: new RecordingStore(),
		destinationAnswers: noAnswers(),
		rootEnsureResults: new Map(),
		daemonTrust: alwaysTrusted,
		openReQueryClient: neverOpened,
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

	it('re-queries only the unknown paths through the dedicated bypass client when the daemon is trusted', async () => {
		const unknownPath = path('33333333333333333333333333333333-unknown');
		const store = new RecordingStore(
			missingWith({ unknown: [unknownPath], downloadSize: 10, narSize: 20 })
		);
		let bypassCalls: (readonly string[])[] = [];
		const bypassClient: Pick<Nix, 'queryMissing'> = {
			queryMissing(targets: readonly string[]) {
				bypassCalls = [...bypassCalls, targets];

				return Promise.resolve(
					missingWith({
						willSubstitute: [unknownPath],
						downloadSize: 5,
						narSize: 8
					})
				);
			}
		};

		const partition = await partitionAvailability(
			baseOptions({
				targets: [
					target({ expectedPath: unknownPath, installable: unknownPath })
				],
				store,
				daemonTrust: alwaysTrusted,
				openReQueryClient: () => bypassClient
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
		'falls back to the nonzero ceiling and never opens the bypass client when the daemon is $name',
		async ({ trust }) => {
			const unknownPath = path('33333333333333333333333333333333-unknown');
			const store = new RecordingStore(missingWith({ unknown: [unknownPath] }));

			const partition = await partitionAvailability(
				baseOptions({
					targets: [
						target({ expectedPath: unknownPath, installable: unknownPath })
					],
					store,
					daemonTrust: () => Promise.resolve(trust),
					ceiling: { value: 0, untrustedFallback: 20 }
				})
			);

			expect(partition.ceiling).toStrictEqual({
				value: 20,
				source: 'untrusted-fallback',
				fallbackReason:
					'the daemon connection is not fully trusted, so its narinfo-cache-negative-ttl override cannot be relied on to take effect'
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
					daemonTrust: () => Promise.resolve('not-trusted'),
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
				fallbackReason:
					'the daemon connection is not fully trusted, so its narinfo-cache-negative-ttl override cannot be relied on to take effect'
			},
			downloadSize: 1,
			narSize: 2,
			exitCode: 75
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
