import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import { describe, expect, it } from 'vitest';

import { subrequestsPerInvocation } from './subrequests.ts';

describe('subrequests per invocation', () => {
	it.each([
		{
			supplied: undefined,
			expected: workersInvocationAllowances.free.subrequests
		},
		{ supplied: '', expected: workersInvocationAllowances.free.subrequests },
		{
			supplied: '1000',
			expected: workersInvocationAllowances.free.subrequests
		},
		{
			supplied: '10000',
			expected: workersInvocationAllowances.paid.subrequests
		},
		{
			supplied: '1001',
			expected: workersInvocationAllowances.free.subrequests
		},
		{
			supplied: '10001',
			expected: workersInvocationAllowances.free.subrequests
		},
		{
			supplied: ' 10000 ',
			expected: workersInvocationAllowances.free.subrequests
		},
		{
			supplied: 'invalid',
			expected: workersInvocationAllowances.free.subrequests
		}
	])('uses $expected calls for $supplied', ({ supplied, expected }) => {
		expect(
			subrequestsPerInvocation({
				CUPBOARD_SUBREQUESTS_PER_INVOCATION: supplied
			})
		).toBe(expected);
	});
});
