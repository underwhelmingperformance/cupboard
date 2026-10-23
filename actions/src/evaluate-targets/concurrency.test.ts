import { describe, expect, it } from 'vitest';

import { resolveEvaluationConcurrency } from './concurrency.ts';

describe('evaluation concurrency', () => {
	it.each([
		{ input: undefined, expected: 3, probes: 1 },
		{ input: '', expected: 3, probes: 1 },
		{ input: 'auto', expected: 3, probes: 1 },
		{ input: '1', expected: 1, probes: 0 },
		{ input: '4', expected: 4, probes: 0 }
	])('resolves $input', async ({ input, expected, probes }) => {
		let calls = 0;
		const concurrency = await resolveEvaluationConcurrency(input, () => {
			calls += 1;
			return Promise.resolve('3\n');
		});

		expect({ concurrency, calls }).toStrictEqual({
			concurrency: expected,
			calls: probes
		});
	});

	it.each(['0', '-1', '1.5', 'NaN', '9007199254740992', 'four'])(
		'rejects invalid concurrency %s before probing CPUs',
		async (input) => {
			let calls = 0;
			await expect(
				resolveEvaluationConcurrency(input, () => {
					calls += 1;
					return Promise.resolve('3');
				})
			).rejects.toThrow('positive safe integer');
			expect(calls).toBe(0);
		}
	);
});
