import { describe, expect, it } from 'vitest';

import {
	type CapacityMeasurement,
	checkStoreCapacity,
	defaultHeadroomAbsoluteMinimum,
	defaultHeadroomFraction,
	type DetectedCapacityOptions,
	StoreCapacityError
} from './capacity.ts';

const storePath = '/nix/store';

function measurement(
	overrides: Partial<CapacityMeasurement> = {}
): CapacityMeasurement {
	return { downloadSize: 100, narSize: 200, unknownCount: 0, ...overrides };
}

function detected(
	overrides: Partial<DetectedCapacityOptions> = {}
): DetectedCapacityOptions {
	return {
		cohortSplitPossible: false,
		remoteStoreConfigured: false,
		componentPublicationApplicable: false,
		...overrides
	};
}

function probeOf(available: number, capacity: number) {
	return () => Promise.resolve({ available, capacity });
}

describe('checkStoreCapacity', () => {
	it('passes and reports the effective headroom when the measured bytes fit comfortably', async () => {
		const capacity = defaultHeadroomAbsoluteMinimum * 100;
		const available = capacity;

		const result = await checkStoreCapacity({
			measurement: measurement({ narSize: 1000 }),
			storePath,
			probe: probeOf(available, capacity),
			detected: detected()
		});

		expect(result).toStrictEqual({
			available,
			capacity,
			headroom: Math.max(defaultHeadroomAbsoluteMinimum, 0.1 * capacity)
		});
	});

	it('refuses when the measured NAR bytes cross available space less the headroom', async () => {
		const available = 10 * defaultHeadroomAbsoluteMinimum;
		const capacity = available;
		const headroom = Math.max(
			defaultHeadroomAbsoluteMinimum,
			defaultHeadroomFraction * capacity
		);
		const narSize = available - headroom + 1;

		let thrown: unknown;

		try {
			await checkStoreCapacity({
				measurement: measurement({
					narSize,
					downloadSize: 42,
					unknownCount: 3
				}),
				storePath,
				probe: probeOf(available, capacity),
				detected: detected({ remoteStoreConfigured: true })
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(StoreCapacityError);

		if (!(thrown instanceof StoreCapacityError)) {
			return;
		}

		expect({
			measured: thrown.measured,
			available: thrown.available,
			headroom: thrown.headroom,
			detected: thrown.detected
		}).toStrictEqual({
			measured: { downloadSize: 42, narSize, unknownCount: 3 },
			available,
			headroom,
			detected: detected({ remoteStoreConfigured: true })
		});
	});

	it('accepts a measurement exactly at the refusal boundary', async () => {
		const available = 10 * defaultHeadroomAbsoluteMinimum;
		const capacity = available;
		const headroom = Math.max(
			defaultHeadroomAbsoluteMinimum,
			defaultHeadroomFraction * capacity
		);

		await expect(
			checkStoreCapacity({
				measurement: measurement({ narSize: available - headroom }),
				storePath,
				probe: probeOf(available, capacity),
				detected: detected()
			})
		).resolves.toStrictEqual({ available, capacity, headroom });
	});

	it('uses the fractional headroom on a large store, where it dominates the absolute minimum', async () => {
		// A capacity twenty times the absolute minimum makes the 10% fraction
		// the larger of the two; `available` is set far above either headroom
		// candidate so only the headroom choice, not the refusal, is under test.
		const capacity = defaultHeadroomAbsoluteMinimum * 20;
		const available = capacity;

		const result = await checkStoreCapacity({
			measurement: measurement({ narSize: 1 }),
			storePath,
			probe: probeOf(available, capacity),
			detected: detected()
		});

		expect(result.headroom).toBe(defaultHeadroomFraction * capacity);
		expect(result.headroom).toBeGreaterThan(defaultHeadroomAbsoluteMinimum);
	});

	it('uses the absolute minimum headroom on a small store, where the fraction would be negligible', async () => {
		// A capacity far below the absolute minimum makes the 10% fraction
		// smaller than the floor; `available` is set far above the floor so
		// only the headroom choice, not the refusal, is under test.
		const capacity = defaultHeadroomAbsoluteMinimum / 100;
		const available = defaultHeadroomAbsoluteMinimum * 100;

		const result = await checkStoreCapacity({
			measurement: measurement({ narSize: 1 }),
			storePath,
			probe: probeOf(available, capacity),
			detected: detected()
		});

		expect(result.headroom).toBe(defaultHeadroomAbsoluteMinimum);
		expect(result.headroom).toBeGreaterThan(defaultHeadroomFraction * capacity);
	});

	it('applies an overridden headroom instead of the provisional defaults', async () => {
		const result = await checkStoreCapacity({
			measurement: measurement({ narSize: 10 }),
			storePath,
			probe: probeOf(10_000, 1000),
			detected: detected(),
			headroom: { absoluteMinimum: 50, fraction: 0.5 }
		});

		expect(result.headroom).toBe(500);
	});

	it.each([
		{
			name: 'a cohort split, for a manifest whose members are separable',
			detected: detected({ cohortSplitPossible: true })
		},
		{
			name: 'component publication, for an aggregate target',
			detected: detected({ componentPublicationApplicable: true })
		},
		{
			name: 'a remote store, when one is configured',
			detected: detected({ remoteStoreConfigured: true })
		},
		{
			name: 'no option at all, when none apply',
			detected: detected()
		}
	])('carries through $name', async ({ detected: detectedOptions }) => {
		const available = defaultHeadroomAbsoluteMinimum;
		const capacity = available;

		let thrown: unknown;

		try {
			await checkStoreCapacity({
				measurement: measurement({ narSize: available }),
				storePath,
				probe: probeOf(available, capacity),
				detected: detectedOptions
			});
		} catch (error) {
			thrown = error;
		}

		expect(
			thrown instanceof StoreCapacityError ? thrown.detected : undefined
		).toStrictEqual(detectedOptions);
	});
});
