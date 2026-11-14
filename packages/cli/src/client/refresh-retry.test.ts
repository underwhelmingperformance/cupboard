import { describe, expect, it } from 'vitest';

import { suspendAwareStopwatch } from './refresh-retry.ts';

describe('suspendAwareStopwatch', () => {
	it.each([
		{
			label: 'the machine was suspended',
			monotonicMs: 1000,
			wallMs: 300_000,
			elapsedMs: 300_000
		},
		{
			label: 'the wall clock stepped backwards',
			monotonicMs: 5000,
			wallMs: -60_000,
			elapsedMs: 5000
		}
	])(
		'reports the larger elapsed reading when $label',
		({ monotonicMs, wallMs, elapsedMs }) => {
			let monotonic = 100;
			let wall = 1_000_000;
			const elapsed = suspendAwareStopwatch(
				() => monotonic,
				() => wall
			)();

			monotonic += monotonicMs;
			wall += wallMs;

			expect(elapsed()).toBe(elapsedMs);
		}
	);
});
