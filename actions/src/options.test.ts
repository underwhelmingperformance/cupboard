import { DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	BooleanInputInvalidError,
	CacheNameInvalidError,
	ReadUserInvalidError,
	UrlInputInvalidError
} from './errors.ts';
import {
	collectLines,
	isEnabled,
	isNixPositionalArgument,
	provided,
	providedCache,
	providedReadUser,
	providedUrl
} from './options.ts';

describe('isNixPositionalArgument', () => {
	it.each([
		['a flake attribute', '.#packages.x86_64-linux.app', true],
		['an option-like value', '--refresh', false],
		['a line break', '.#app\n--refresh', false],
		['an embedded tab', '.#app\tdev', false],
		['a delete character', '.#app\u{7F}', false],
		['a C1 control character', '.#app\u{85}', false]
	])('%s', (_name, value, expected) => {
		expect(isNixPositionalArgument(value)).toBe(expected);
	});
});

describe('provided', () => {
	it.each([
		['trims and returns a non-empty value', '  value ', 'value'],
		['treats a blank string as absent', ' '.repeat(3), undefined],
		['treats undefined as absent', undefined, undefined]
	])('%s', (_name, value, expected) => {
		expect(provided(value)).toBe(expected);
	});
});

describe('providedUrl', () => {
	it.each([
		[
			'a plain origin',
			'https://cache.example.test',
			'https://cache.example.test/'
		],
		[
			'a tenant path',
			'https://cache.example.test/t/acme',
			'https://cache.example.test/t/acme'
		],
		[
			'an http URL',
			'http://localhost:8787/t/acme',
			'http://localhost:8787/t/acme'
		],
		[
			'a padded value',
			'  https://cache.example.test/t/acme  ',
			'https://cache.example.test/t/acme'
		],
		[
			'a trailing slash',
			'https://cache.example.test/t/acme/',
			'https://cache.example.test/t/acme'
		]
	])('accepts %s', (_name, value, expected) => {
		expect(providedUrl('cache-url', value)?.href).toBe(expected);
	});

	it.each([
		['an absent value', undefined],
		['a blank value', ' '.repeat(3)]
	])('reads %s as absent', (_name, value) => {
		expect(providedUrl('cache-url', value)).toBeUndefined();
	});

	it.each([
		['a bare hostname', 'cache.example.test/t/acme'],
		['a non-http scheme', 'ftp://cache.example.test'],
		['a fragment', 'https://cache.example.test/t/acme#copied'],
		['a query string', 'https://cache.example.test/t/acme?tab=keys'],
		['an embedded username', 'https://ci@cache.example.test/t/acme'],
		['embedded credentials', 'https://ci:secret@cache.example.test/t/acme']
	])('refuses %s', (_name, value) => {
		expect(() => providedUrl('cache-url', value)).toThrow(UrlInputInvalidError);
	});

	it('records the input name without storing its value', () => {
		const error = new UrlInputInvalidError('cache-url');

		expect({ type: error.constructor, input: error.input }).toStrictEqual({
			type: UrlInputInvalidError,
			input: 'cache-url'
		});
	});
});

describe('providedCache', () => {
	it.each([
		['trims a padded cache name', ' pr-1 ', 'pr-1'],
		['reads a blank value as the default cache', ' ', DEFAULT_CACHE],
		['reads an absent value as the default cache', undefined, DEFAULT_CACHE]
	])('%s', (_name, value, expected) => {
		expect(providedCache(value)).toBe(expected);
	});

	it('refuses a value that is not a legal cache name', () => {
		expect(() => providedCache('Not A Cache')).toThrow(CacheNameInvalidError);
	});
});

describe('providedReadUser', () => {
	it.each([
		['keeps a supplied name verbatim', ' alice ', ' alice '],
		['reads a blank value as no read user', '', ''],
		['reads an absent value as no read user', undefined, '']
	])('%s', (_name, value, expected) => {
		expect(providedReadUser(value)).toBe(expected);
	});

	it('rejects a colon because Basic authentication uses it as a separator', () => {
		expect(() => providedReadUser('rea:der')).toThrow(ReadUserInvalidError);
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
				BooleanInputInvalidError
			);
		}
	);
});
