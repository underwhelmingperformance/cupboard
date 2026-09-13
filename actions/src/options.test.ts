import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { readUserInputSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import {
	BooleanInputInvalidError,
	CacheCredentialsInvalidError,
	CacheNameInvalidError,
	ReadUserInvalidError,
	UnknownCacheCredentialError,
	UrlInputInvalidError
} from './errors.ts';
import {
	collectLines,
	isEnabled,
	isNixPositionalArgument,
	provided,
	providedCache,
	providedCacheCredentials,
	providedCaches,
	providedCacheSelection,
	providedReadUser,
	providedUrl
} from './options.ts';

const cacheName = (value: string) => cacheNameSchema.parse(value);
const defaultCache: CacheScope = { kind: 'default' };
const namedCache = (value: string): CacheScope => ({
	kind: 'named',
	name: cacheName(value)
});
const readPassword = 'A'.repeat(43);

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
		['trims a padded cache name', ' pr-1 ', namedCache('pr-1')],
		['reads a blank value as the default cache', ' ', defaultCache],
		['reads an absent value as the default cache', undefined, defaultCache]
	])('%s', (_name, value, expected) => {
		expect(providedCache(value)).toStrictEqual(expected);
	});

	it.each([
		{ name: 'is not a legal cache name', value: 'Not A Cache' },
		{ name: 'contains a path separator', value: 'cache/release' }
	])('refuses a value that $name', ({ value }) => {
		expect(() => providedCache(value)).toThrow(CacheNameInvalidError);
	});
});

describe('providedCaches', () => {
	it.each([
		{ name: 'an absent input names no cache', value: undefined, expected: [] },
		{ name: 'a blank input names no cache', value: '  ', expected: [] },
		{
			name: 'a newline-separated list keeps its order',
			value: 'builds\n  docs\n',
			expected: ['builds', 'docs']
		},
		{
			name: 'a comma-separated list keeps its order',
			value: 'builds, docs',
			expected: ['builds', 'docs']
		},
		{
			name: 'lines and commas may be mixed',
			value: 'builds, docs\nreleases\n\n',
			expected: ['builds', 'docs', 'releases']
		}
	])('$name', ({ expected, value }) => {
		expect(providedCaches(value)).toStrictEqual(
			expected.map((value) => namedCache(value))
		);
	});

	it.each([
		{ name: 'is not a legal cache name', value: 'builds,Not A Cache' },
		{ name: 'contains a path separator', value: 'builds,cache/release' }
	])('refuses a list entry that $name', ({ value }) => {
		expect(() => providedCaches(value)).toThrow(CacheNameInvalidError);
	});
});

describe('providedCacheCredentials', () => {
	it.each([
		{ name: 'an absent input', value: undefined },
		{ name: 'a blank input', value: '  ' }
	])('reads $name as no credential', ({ value }) => {
		expect(
			providedCacheCredentials(value, [namedCache('release')])
		).toStrictEqual([]);
	});

	it('reads a credential for each named cache', () => {
		const release = namedCache('release');

		expect(
			providedCacheCredentials(
				JSON.stringify([
					{
						cache: release,
						credential: { user: 'ci', password: readPassword }
					}
				]),
				[release]
			)
		).toStrictEqual([
			{
				cache: release,
				credential: {
					user: readUserInputSchema.parse('ci'),
					password: readPassword
				}
			}
		]);
	});

	it.each([
		{ name: 'is not JSON', value: 'not json' },
		{ name: 'is not an array', value: '"release"' },
		{
			name: 'omits the password',
			value:
				'[{"cache":{"kind":"named","name":"release"},"credential":{"user":"ci"}}]'
		},
		{
			name: 'carries a password of the wrong shape',
			value:
				'[{"cache":{"kind":"named","name":"release"},"credential":{"user":"ci","password":"short"}}]'
		},
		{
			name: 'names a cache the name schema refuses',
			value: `[{"cache":{"kind":"named","name":"Not A Cache"},"credential":{"user":"ci","password":"${readPassword}"}}]`
		}
	])('refuses an input that $name', ({ value }) => {
		expect(() =>
			providedCacheCredentials(value, [namedCache('release')])
		).toThrow(CacheCredentialsInvalidError);
	});

	it('refuses a credential for a cache the run does not configure', () => {
		const credentials = JSON.stringify([
			{
				cache: namedCache('staging'),
				credential: { user: 'ci', password: readPassword }
			}
		]);

		expect(() =>
			providedCacheCredentials(credentials, [namedCache('release')])
		).toThrow(UnknownCacheCredentialError);
	});
});

describe('providedCacheSelection', () => {
	it.each<{
		readonly name: string;
		readonly cache: string | undefined;
		readonly expected: CacheScope;
	}>([
		{
			name: 'an absent input targets the default cache',
			cache: undefined,
			expected: defaultCache
		},
		{
			name: 'a name targets that cache',
			cache: ' builds ',
			expected: namedCache('builds')
		}
	])('$name', ({ cache, expected }) => {
		expect(providedCacheSelection(cache)).toStrictEqual(expected);
	});

	it('refuses an invalid cache name', () => {
		expect(() => providedCacheSelection('cache/release')).toThrow(
			CacheNameInvalidError
		);
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
