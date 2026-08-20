import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { CommitSocketCeilingInvalidError } from '../errors.ts';

import {
	commitSocketCeiling,
	defaultCommitSocketCeiling
} from './commit-sockets.ts';

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

describe('commitSocketCeiling', () => {
	it.each([
		{
			name: 'empty means the built-in ceiling',
			value: '',
			expected: defaultCommitSocketCeiling
		},
		{ name: 'a configured ceiling', value: '12', expected: 12 }
	])('$name', ({ value, expected }) => {
		expect(commitSocketCeiling({ CUPBOARD_COMMIT_SOCKET_CEILING: value })).toBe(
			expected
		);
	});

	it.each([
		{ name: 'a non-number', value: 'plenty' },
		{ name: 'a ceiling of zero', value: '0' },
		{ name: 'a negative ceiling', value: '-1' },
		{ name: 'a fractional ceiling', value: '2.5' }
	])('rejects $name', ({ value }) => {
		const error = thrownBy(() =>
			commitSocketCeiling({ CUPBOARD_COMMIT_SOCKET_CEILING: value })
		);

		expect(error).toBeInstanceOf(CommitSocketCeilingInvalidError);

		if (!(error instanceof CommitSocketCeilingInvalidError)) {
			throw error;
		}

		expect({ status: error.status, value: error.value }).toStrictEqual({
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			value
		});
	});
});
