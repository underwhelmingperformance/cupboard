import { describe, expect, it } from 'vitest';

import {
	charactersRead,
	unsafeRegularExpressions
} from './scan-cost.test-support.ts';

describe('charactersRead', () => {
	it.each([
		['one character', () => 'abc'.charAt(1), 1],
		['a match', () => 'abcabc'.indexOf('c', 1), 2],
		['a missing match', () => 'abc'.indexOf('z', 1), 2],
		['a start index after the end', () => 'abc'.indexOf('a', 10), 0],
		['a negative start index', () => 'abc'.indexOf('b', -5), 2],
		[
			'a mix of calls',
			() => {
				'abc'.charAt(0);
				'abcabc'.indexOf('ca');
			},
			5
		]
	])('counts %s', (_name, run, expected) => {
		expect(charactersRead(run)).toBe(expected);
	});
});

describe('unsafeRegularExpressions', () => {
	it('reports an expression with polynomial backtracking', async () => {
		expect(
			await unsafeRegularExpressions(() => {
				/\/+$/u.test('//a');
			})
		).toStrictEqual([
			{ pattern: String.raw`/\/+$/u`, verdict: '2nd degree polynomial' }
		]);
	});

	it('does not report an expression that recheck proves safe', async () => {
		expect(
			await unsafeRegularExpressions(() => {
				/^a+$/u.test('aa');
			})
		).toStrictEqual([]);
	});
});
