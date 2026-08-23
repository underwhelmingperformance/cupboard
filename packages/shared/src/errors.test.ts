import { describe, expect, it } from 'vitest';

import { errorCauses, formatErrorWithCauses } from './errors.ts';

const twoLevelChain = new Error('the step failed', {
	cause: new RangeError('the value is too big', {
		cause: new TypeError('the key has the wrong type')
	})
});

class SelfReferringError extends Error {
	override readonly cause: Error;

	constructor() {
		super('outer');
		this.name = 'SelfReferringError';
		this.cause = new Error('inner', { cause: this });
	}
}

interface CircularCause {
	code: string;
	self?: CircularCause;
}

const circularCause: CircularCause = { code: 'EAGAIN' };
circularCause.self = circularCause;

function nestedError(depth: number): Error {
	let error = new Error('level 0');

	for (let level = 1; level <= depth; level += 1) {
		error = new Error(`level ${String(level)}`, { cause: error });
	}

	return error;
}

describe('errorCauses', () => {
	it.each([
		{
			name: 'an error without a cause',
			error: new Error('the step failed'),
			expected: []
		},
		{
			name: 'a two-level cause chain',
			error: twoLevelChain,
			expected: [
				'RangeError: the value is too big',
				'TypeError: the key has the wrong type'
			]
		},
		{
			name: 'a cause that is not an error',
			error: new Error('the step failed', { cause: 'the daemon said no' }),
			expected: ['the daemon said no']
		},
		{
			name: 'a cause that is an object',
			error: new Error('the step failed', {
				cause: { code: 'ENOENT', path: '/nix/store/x' }
			}),
			expected: ['{"code":"ENOENT","path":"/nix/store/x"}']
		},
		{
			name: 'a cause object JSON cannot represent',
			error: new Error('the step failed', { cause: circularCause }),
			expected: ['[object Object]']
		},
		{
			name: 'a chain that leads back to the error itself',
			error: new SelfReferringError(),
			expected: ['Error: inner']
		},
		{
			name: 'a chain deeper than the rendered limit',
			error: nestedError(8),
			expected: [
				'Error: level 7',
				'Error: level 6',
				'Error: level 5',
				'Error: level 4',
				'Error: level 3'
			]
		}
	])('describes $name', ({ error, expected }) => {
		expect(errorCauses(error)).toStrictEqual(expected);
	});
});

describe('formatErrorWithCauses', () => {
	it.each([
		{
			name: 'indents every cause under the message',
			error: twoLevelChain,
			expected:
				'the step failed\n' +
				'  RangeError: the value is too big\n' +
				'  TypeError: the key has the wrong type'
		},
		{
			name: 'renders a thrown value that is not an error',
			error: 'the daemon said no',
			expected: 'the daemon said no'
		}
	])('$name', ({ error, expected }) => {
		expect(formatErrorWithCauses(error)).toBe(expected);
	});
});
