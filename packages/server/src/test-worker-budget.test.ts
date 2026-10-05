import { describe, expect, it } from 'vitest';

import { resolveTestWorkerBudget } from './test-worker-budget.ts';

describe('Worker test budget', () => {
	it('keeps four workers when no budget is supplied', () => {
		expect(resolveTestWorkerBudget(undefined)).toBe(4);
	});

	it.each([1, 2, 4, 8, Number.MAX_SAFE_INTEGER])(
		'uses an explicit budget of %s workers',
		(budget) => {
			expect(resolveTestWorkerBudget(String(budget))).toBe(budget);
		}
	);

	it.each([
		'',
		' ',
		'0',
		'-1',
		'1.5',
		'NaN',
		'Infinity',
		'1e2',
		'0x10',
		String(Number.MAX_SAFE_INTEGER + 1)
	])('rejects invalid budget %j', (value) => {
		expect(() => resolveTestWorkerBudget(value)).toThrow(
			'CUPBOARD_TEST_WORKERS must be a positive safe integer'
		);
	});
});
