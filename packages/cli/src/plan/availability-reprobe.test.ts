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
		attr: 'packages.x86_64-linux.app',
		installable: appPath,
		expectedPath: appPath,
		root: appRoot,
		...overrides
	};
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
		destinationAnswers: noAnswers(),
		...overrides
	};
}

describe('reprobeAvailability', () => {
	it('leaves the build set unchanged when nothing has become available', async () => {
		const reprobe = await reprobeAvailability(
			baseOptions({
				targets: [target(), target({ installable: otherPath })]
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

		await reprobeAvailability(
			baseOptions({
				targets: [
					target(),
					target({ installable: otherPath, expectedPath: otherPath })
				],
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

		expect({ destinationCalls, viewCalls }).toStrictEqual({
			destinationCalls: [[appPath, otherPath]],
			viewCalls: [[appPath, otherPath]]
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
		const reprobe = await reprobeAvailability(
			baseOptions({
				targets: [target({ expectedPath: undefined })],
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

		expect(reprobe).toStrictEqual({ buildSet: [appPath], withdrawn: [] });
	});
});
