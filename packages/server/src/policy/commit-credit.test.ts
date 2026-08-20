import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { CommitCreditBudgetInvalidError } from '../errors.ts';

import {
	commitEntryCreditBudget,
	defaultCommitEntryCreditBudget
} from './commit-credit.ts';

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

describe('commitEntryCreditBudget', () => {
	it.each([
		{
			name: 'empty means the built-in budget',
			value: '',
			expected: defaultCommitEntryCreditBudget
		},
		{ name: 'a configured budget', value: '4', expected: 4 }
	])('$name', ({ value, expected }) => {
		expect(
			commitEntryCreditBudget({ CUPBOARD_COMMIT_ENTRY_CREDIT_BUDGET: value })
		).toBe(expected);
	});

	it.each([
		{ name: 'a non-number', value: 'lots' },
		{ name: 'a budget of zero', value: '0' },
		{ name: 'a negative budget', value: '-1' },
		{ name: 'a fractional budget', value: '1.5' }
	])('rejects $name', ({ value }) => {
		const error = thrownBy(() =>
			commitEntryCreditBudget({ CUPBOARD_COMMIT_ENTRY_CREDIT_BUDGET: value })
		);

		expect(error).toBeInstanceOf(CommitCreditBudgetInvalidError);

		if (!(error instanceof CommitCreditBudgetInvalidError)) {
			throw error;
		}

		expect({ status: error.status, value: error.value }).toStrictEqual({
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			value
		});
	});
});
