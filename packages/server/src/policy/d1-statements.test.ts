import {
	freeTierD1StatementsPerInvocation,
	paidTierD1StatementsPerInvocation
} from '@cupboard/protocol/platform';
import { describe, expect, it } from 'vitest';

import { d1StatementAllowance } from './d1-statements.ts';

describe('d1StatementAllowance', () => {
	it.each([
		{ name: 'the paid figure', value: '1000', expected: 1000 },
		{ name: 'a figure between the plans', value: '250', expected: 250 },
		{
			name: 'the free figure for an unset variable',
			value: '',
			expected: freeTierD1StatementsPerInvocation
		},
		{
			name: 'the free figure for a value that is not a number',
			value: 'plenty',
			expected: freeTierD1StatementsPerInvocation
		},
		{
			name: 'the free figure for a fractional value',
			value: '2.5',
			expected: freeTierD1StatementsPerInvocation
		},
		{
			name: 'the free figure for zero',
			value: '0',
			expected: freeTierD1StatementsPerInvocation
		},
		{
			name: 'the free figure for a value above the paid figure',
			value: String(paidTierD1StatementsPerInvocation + 1),
			expected: freeTierD1StatementsPerInvocation
		},
		{
			name: 'the free figure for a mistyped allowance of 100,000',
			value: '100000',
			expected: freeTierD1StatementsPerInvocation
		}
	])('returns $name', ({ value, expected }) => {
		expect(
			d1StatementAllowance({
				CUPBOARD_D1_STATEMENTS_PER_INVOCATION: value
			})
		).toBe(expected);
	});
});
