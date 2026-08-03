import type { Nix } from '@cupboard/nix';
import {
	type RootName,
	rootNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import type {
	AvailabilityTarget,
	DestinationAnswers
} from './availability-partition.ts';
import {
	type AvailabilityReprobeOptions,
	reprobeAvailability,
	type WithdrawnOutcome
} from './availability-reprobe.ts';

function path(basename: string): StorePathString {
	return storePathSchema.parse(`/nix/store/${basename}`);
}

function root(value: string): RootName {
	return rootNameSchema.parse(value);
}

const appRoot = root('github:owner/repo/main/app');
const appPath = path('11111111111111111111111111111111-app');
const otherPath = path('22222222222222222222222222222222-other');

function target(
	overrides: Partial<AvailabilityTarget> = {}
): AvailabilityTarget {
	return {
		installable: appPath,
		expectedPath: appPath,
		root: appRoot,
		...overrides
	};
}

// A store double that records every call it receives, so a test can assert
// exactly how many round trips the confirmation cost.
class RecordingStore implements Pick<
	Nix,
	'querySubstitutablePaths' | 'queryValidPaths'
> {
	readonly substitutableCalls: (readonly string[])[] = [];
	readonly validCalls: (readonly string[])[] = [];

	constructor(
		private readonly valid: readonly string[] = [],
		private readonly substitutable: readonly string[] = []
	) {}

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

function baseOptions(
	overrides: Partial<AvailabilityReprobeOptions> = {}
): AvailabilityReprobeOptions {
	return {
		targets: [],
		store: new RecordingStore(),
		destinationAnswers: noAnswers(),
		...overrides
	};
}

describe('reprobeAvailability', () => {
	it('leaves a build set nothing has caught up with exactly as it was', async () => {
		const store = new RecordingStore();
		const reprobe = await reprobeAvailability(
			baseOptions({
				targets: [target(), target({ installable: otherPath })],
				store
			})
		);

		expect(reprobe).toStrictEqual({
			buildSet: [appPath, otherPath],
			withdrawn: []
		});
	});

	it('asks each question once over the whole build set', async () => {
		const destinationCalls: (readonly StorePathString[])[] = [];
		const viewCalls: (readonly StorePathString[])[] = [];
		const store = new RecordingStore([appPath]);

		await reprobeAvailability(
			baseOptions({
				targets: [
					target(),
					target({ installable: otherPath, expectedPath: otherPath })
				],
				store,
				destinationAnswers: {
					destinationServed: (paths) => {
						destinationCalls.push(paths);

						return Promise.resolve(new Set());
					},
					viewServed: (paths) => {
						viewCalls.push(paths);

						return Promise.resolve(new Set());
					}
				}
			})
		);

		expect({
			destinationCalls,
			viewCalls,
			validCalls: store.validCalls,
			substitutableCalls: store.substitutableCalls
		}).toStrictEqual({
			destinationCalls: [[appPath, otherPath]],
			viewCalls: [[appPath, otherPath]],
			validCalls: [[appPath, otherPath]],
			substitutableCalls: [[appPath]]
		});
	});

	it.each([
		{
			becameAvailable: 'at the destination',
			outcome: 'attachOnly',
			options: {
				destinationAnswers: answersFrom({
					destinationServed: () => Promise.resolve(new Set([appPath]))
				})
			}
		},
		{
			becameAvailable: 'in the reuse view',
			outcome: 'publishByReference',
			options: {
				destinationAnswers: answersFrom({
					viewServed: () => Promise.resolve(new Set([appPath]))
				})
			}
		},
		{
			becameAvailable: 'upstream, with the store now holding it',
			outcome: 'leftUpstream',
			options: { store: new RecordingStore([appPath], [appPath]) }
		}
	] satisfies readonly {
		readonly becameAvailable: string;
		readonly outcome: WithdrawnOutcome;
		readonly options: Partial<AvailabilityReprobeOptions>;
	}[])(
		'withdraws a target that became available $becameAvailable',
		async ({ outcome, options }) => {
			const reprobe = await reprobeAvailability(
				baseOptions({
					targets: [
						target(),
						target({ installable: otherPath, expectedPath: otherPath })
					],
					...options
				})
			);

			expect(reprobe).toStrictEqual({
				buildSet: [otherPath],
				withdrawn: [{ installable: appPath, storePath: appPath, outcome }]
			});
		}
	);

	it('keeps a target the store holds but nothing else serves in the build set', async () => {
		const reprobe = await reprobeAvailability(
			baseOptions({
				targets: [target()],
				store: new RecordingStore([appPath])
			})
		);

		expect(reprobe).toStrictEqual({ buildSet: [appPath], withdrawn: [] });
	});

	it('never withdraws a target with no predictable output', async () => {
		const floating = target({
			installable: otherPath,
			expectedPath: undefined
		});
		const reprobe = await reprobeAvailability(
			baseOptions({
				targets: [floating, target()],
				destinationAnswers: answersFrom({
					destinationServed: () => Promise.resolve(new Set([appPath]))
				})
			})
		);

		expect(reprobe).toStrictEqual({
			buildSet: [otherPath],
			withdrawn: [
				{ installable: appPath, storePath: appPath, outcome: 'attachOnly' }
			]
		});
	});

	it('asks nothing at all when no target has a predictable output', async () => {
		const store = new RecordingStore();
		const reprobe = await reprobeAvailability(
			baseOptions({
				targets: [target({ expectedPath: undefined })],
				store,
				destinationAnswers: {
					destinationServed: () => {
						throw new Error('the destination must not be asked here');
					},
					viewServed: () => {
						throw new Error('the reuse view must not be asked here');
					}
				}
			})
		);

		expect({
			reprobe,
			validCalls: store.validCalls,
			substitutableCalls: store.substitutableCalls
		}).toStrictEqual({
			reprobe: { buildSet: [appPath], withdrawn: [] },
			validCalls: [],
			substitutableCalls: []
		});
	});
});
