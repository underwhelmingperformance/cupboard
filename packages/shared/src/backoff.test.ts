import { describe, expect, it } from 'vitest';

import {
	ExponentialBackoff,
	type ExponentialBackoffPolicy
} from './backoff.ts';

// The largest value below 1 that these tests use. It is exact in binary, so
// the expected delays are exact.
const nearlyOne = 1 - 2 ** -10;

describe('ExponentialBackoff', () => {
	it.each<{
		readonly what: string;
		readonly policy: ExponentialBackoffPolicy;
		readonly attempt: number;
		readonly random: number;
		readonly expected: number;
	}>([
		{
			what: 'full jitter at random 0',
			policy: { baseMs: 250, maximumMs: 5000, jitter: 'full' },
			attempt: 1,
			random: 0,
			expected: 0
		},
		{
			what: 'full jitter just below random 1',
			policy: { baseMs: 250, maximumMs: 5000, jitter: 'full' },
			attempt: 1,
			random: nearlyOne,
			expected: 249.755859375
		},
		{
			what: 'full jitter on the third attempt',
			policy: { baseMs: 250, maximumMs: 5000, jitter: 'full' },
			attempt: 3,
			random: 0.5,
			expected: 500
		},
		{
			what: 'half jitter at random 0',
			policy: { baseMs: 500, jitter: 'half' },
			attempt: 1,
			random: 0,
			expected: 250
		},
		{
			what: 'half jitter just below random 1',
			policy: { baseMs: 500, jitter: 'half' },
			attempt: 1,
			random: nearlyOne,
			expected: 499.755859375
		},
		{
			what: 'no jitter',
			policy: { baseMs: 250, maximumMs: 5000, jitter: 'none' },
			attempt: 3,
			random: 0.5,
			expected: 1000
		},
		{
			what: 'full jitter at the cap',
			policy: { baseMs: 250, maximumMs: 5000, jitter: 'full' },
			attempt: 40,
			random: 0.5,
			expected: 2500
		},
		{
			what: 'no jitter at the cap',
			policy: { baseMs: 250, maximumMs: 5000, jitter: 'none' },
			attempt: 6,
			random: 0,
			expected: 5000
		},
		{
			what: 'no jitter without a cap',
			policy: { baseMs: 500, jitter: 'none' },
			attempt: 12,
			random: 0,
			expected: 1_024_000
		},
		{
			what: 'no jitter after 31 doublings',
			policy: { baseMs: 500, jitter: 'none' },
			attempt: 2000,
			random: 0,
			expected: 500 * 2 ** 31
		},
		{
			what: 'full jitter from a zero base at a large attempt',
			policy: { baseMs: 0, jitter: 'full' },
			attempt: 2000,
			random: 0,
			expected: 0
		}
	])(
		'returns $expected ms for $what',
		({ policy, attempt, random, expected }) => {
			const backoff = new ExponentialBackoff(policy, () => random);

			expect(backoff.delayMs(attempt)).toBe(expected);
		}
	);
});
