import { describe, expect, it } from 'vitest';

import { InvalidInputError } from './errors.ts';
import { collectLines, isEnabled, provided } from './options.ts';

describe('provided', () => {
	it.each([
		['trims and returns a non-empty value', '  value ', 'value'],
		['treats a blank string as absent', ' '.repeat(3), undefined],
		['treats undefined as absent', undefined, undefined]
	])('%s', (_name, value, expected) => {
		expect(provided(value)).toBe(expected);
	});
});

describe('collectLines', () => {
	it('splits a newline-delimited value onto the accumulator', () => {
		expect(
			collectLines('/nix/store/a\n\n /nix/store/b \r\n', ['/nix/store/z'])
		).toStrictEqual(['/nix/store/z', '/nix/store/a', '/nix/store/b']);
	});

	it('appends a single repeated value', () => {
		expect(collectLines('/nix/store/a', [])).toStrictEqual(['/nix/store/a']);
	});
});

describe('isEnabled', () => {
	it.each([
		['true', true],
		[' false ', false],
		['', true],
		['  ', true],
		[undefined, true]
	])('resolves %j with a true fallback as %j', (value, expected) => {
		expect(isEnabled('add-to-path', value, true)).toBe(expected);
	});

	it('resolves an absent value with a false fallback as false', () => {
		expect(isEnabled('wait', undefined, false)).toBe(false);
	});

	it.each([['yes'], ['flase'], ['1'], ['TRUE']])(
		'rejects %j with an invalid-input error',
		(value) => {
			expect(() => isEnabled('add-to-path', value, true)).toThrow(
				InvalidInputError
			);
		}
	);
});
