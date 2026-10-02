import { describe, expect, it } from 'vitest';

import { EligibleRetryClock, RetryPolicy } from './retry.ts';

describe('RetryPolicy', () => {
	it.each([
		{ phase: 'verification', failures: 0, delayMs: 30_000 },
		{ phase: 'verification', failures: 1, delayMs: 60_000 },
		{ phase: 'verification', failures: 5, delayMs: 600_000 },
		{ phase: 'verification', failures: 10, delayMs: 600_000 },
		{ phase: 'inheritance', failures: 0, delayMs: 60_000 },
		{ phase: 'inheritance', failures: 1, delayMs: 120_000 },
		{ phase: 'inheritance', failures: 6, delayMs: 3_600_000 },
		{ phase: 'inheritance', failures: 10, delayMs: 3_600_000 }
	] as const)(
		'backs off $phase failure $failures',
		({ phase, failures, delayMs }) => {
			expect(
				new RetryPolicy(phase).afterFailure({ failures, eligibleAgeMs: 0 })
			).toStrictEqual({
				kind: 'retry',
				failures: failures + 1,
				delayMs
			});
		}
	);

	it.each(['verification', 'inheritance'] as const)(
		'uses the same attempt and eligible-age bounds for %s',
		(phase) => {
			const policy = new RetryPolicy(phase);
			expect([
				policy.afterFailure({ failures: 11, eligibleAgeMs: 0 }),
				policy.afterFailure({ failures: 0, eligibleAgeMs: 86_400_000 }),
				policy.afterFailure({ failures: 0, eligibleAgeMs: 86_399_999 }),
				policy.exhaustion({ failures: 12, eligibleAgeMs: 0 }),
				policy.exhaustion({ failures: 1, eligibleAgeMs: 86_400_000 }),
				policy.exhaustion({ failures: 11, eligibleAgeMs: 86_399_999 })
			]).toStrictEqual([
				{ kind: 'exhausted', failures: 12, reason: 'attempt-limit' },
				{ kind: 'exhausted', failures: 1, reason: 'eligible-age-limit' },
				{
					kind: 'retry',
					failures: 1,
					delayMs: phase === 'verification' ? 30_000 : 60_000
				},
				'attempt-limit',
				'eligible-age-limit',
				undefined
			]);
		}
	);
});

describe('EligibleRetryClock', () => {
	it.each([
		{ status: 'active', activeSinceMs: 1000, nowMs: 4000, expected: 8000 },
		{
			status: 'suspended',
			activeSinceMs: undefined,
			nowMs: 100_000,
			expected: 5000
		},
		{
			status: 'offboarding',
			activeSinceMs: undefined,
			nowMs: 100_000,
			expected: 5000
		},
		{ status: 'active', activeSinceMs: 1000, nowMs: 999, expected: 5000 }
	] as const)(
		'counts active time for $status at $nowMs',
		({ status, activeSinceMs, nowMs, expected }) => {
			const clock = new EligibleRetryClock({
				status,
				activeElapsedMs: 5000,
				activeSinceMs
			});
			expect({
				elapsed: clock.elapsedAt(nowMs),
				age: clock.ageAt(2000, nowMs)
			}).toStrictEqual({
				elapsed: expected,
				age: expected - 2000
			});
		}
	);
	it('does not make a newly migrated clock negative', () => {
		const clock = new EligibleRetryClock({
			status: 'active',
			activeElapsedMs: 0,
			activeSinceMs: 1000
		});
		expect(clock.ageAt(100, 1001)).toBe(0);
	});
});
