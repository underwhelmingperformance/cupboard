import {
	cacheNameSchema,
	DEFAULT_CACHE,
	privateStoredCache,
	type StoredCache
} from '@cupboard/nix-store/scalars';
import { readUserInputSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import {
	BooleanInputInvalidError,
	CacheNameInvalidError,
	CacheSelectionConflictError,
	PrivateCacheCredentialsInvalidError,
	ReadUserInvalidError,
	UnknownPrivateCacheCredentialError,
	UrlInputInvalidError
} from './errors.ts';
import {
	cacheArguments,
	collectLines,
	isEnabled,
	isNixPositionalArgument,
	provided,
	providedCache,
	providedCaches,
	providedCacheSelection,
	providedPrivateCacheCredentials,
	providedPrivateCacheNames,
	providedReadUser,
	providedUrl
} from './options.ts';

const cacheName = (value: string) => cacheNameSchema.parse(value);
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
		['trims a padded cache name', ' pr-1 ', 'pr-1'],
		['reads a blank value as the default cache', ' ', DEFAULT_CACHE],
		['reads an absent value as the default cache', undefined, DEFAULT_CACHE]
	])('%s', (_name, value, expected) => {
		expect(providedCache(value)).toBe(expected);
	});

	it.each([
		{ name: 'is not a legal cache name', value: 'Not A Cache' },
		{ name: 'is a private stored name', value: 'private/release' }
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
			expected.map((value) => cacheName(value))
		);
	});

	it.each([
		{ name: 'is not a legal cache name', value: 'builds,Not A Cache' },
		{ name: 'is a private stored name', value: 'builds,private/release' }
	])('refuses a list entry that $name', ({ value }) => {
		expect(() => providedCaches(value)).toThrow(CacheNameInvalidError);
	});
});

describe('providedPrivateCacheNames', () => {
	it('reads a mixed list as local names in order', () => {
		expect(
			providedPrivateCacheNames('release, staging\nteam.eu\n')
		).toStrictEqual(
			['release', 'staging', 'team.eu'].map((value) => cacheName(value))
		);
	});

	it('refuses a value that is not a legal cache name', () => {
		expect(() => providedPrivateCacheNames('Not A Cache')).toThrow(
			CacheNameInvalidError
		);
	});
});

describe('providedPrivateCacheCredentials', () => {
	it.each([
		{ name: 'an absent input', value: undefined },
		{ name: 'a blank input', value: '  ' }
	])('reads $name as no credential', ({ value }) => {
		expect(
			providedPrivateCacheCredentials(value, [cacheName('release')])
		).toStrictEqual(new Map());
	});

	it('reads a credential for each named cache', () => {
		expect(
			providedPrivateCacheCredentials(
				JSON.stringify({ release: { user: 'ci', password: readPassword } }),
				[cacheName('release')]
			)
		).toStrictEqual(
			new Map([
				[
					cacheName('release'),
					{ user: readUserInputSchema.parse('ci'), password: readPassword }
				]
			])
		);
	});

	it('returns no credential for an unlisted cache named constructor', () => {
		const credentials = providedPrivateCacheCredentials(
			JSON.stringify({ release: { user: 'ci', password: readPassword } }),
			[cacheName('release')]
		);

		expect(credentials.get(cacheName('constructor'))).toBeUndefined();
	});

	it.each([
		{ name: 'is not JSON', value: 'not json' },
		{ name: 'is not an object', value: '"release"' },
		{ name: 'omits the password', value: '{"release":{"user":"ci"}}' },
		{
			name: 'carries a password of the wrong shape',
			value: '{"release":{"user":"ci","password":"short"}}'
		},
		{
			name: 'names a cache the name schema refuses',
			value: `{"Not A Cache":{"user":"ci","password":"${readPassword}"}}`
		}
	])('refuses an input that $name', ({ value }) => {
		expect(() =>
			providedPrivateCacheCredentials(value, [cacheName('release')])
		).toThrow(PrivateCacheCredentialsInvalidError);
	});

	it('refuses a credential for a cache the run does not configure', () => {
		const credentials = JSON.stringify({
			staging: { user: 'ci', password: readPassword }
		});

		expect(() =>
			providedPrivateCacheCredentials(credentials, [cacheName('release')])
		).toThrow(UnknownPrivateCacheCredentialError);
	});
});

describe('providedCacheSelection', () => {
	it.each<{
		readonly name: string;
		readonly cache: string | undefined;
		readonly privateCache: string | undefined;
		readonly expected: StoredCache;
	}>([
		{
			name: 'neither input targets the default cache',
			cache: undefined,
			privateCache: undefined,
			expected: DEFAULT_CACHE
		},
		{
			name: 'a public name targets that cache',
			cache: ' builds ',
			privateCache: '  ',
			expected: cacheName('builds')
		},
		{
			name: 'a private name targets the private stored cache',
			cache: '',
			privateCache: 'release',
			expected: privateStoredCache(cacheName('release'))
		}
	])('$name', ({ cache, expected, privateCache }) => {
		expect(providedCacheSelection(cache, privateCache)).toBe(expected);
	});

	it('refuses both inputs together', () => {
		expect(() => providedCacheSelection('builds', 'release')).toThrow(
			CacheSelectionConflictError
		);
	});

	it('refuses a private name that is not a legal cache name', () => {
		expect(() => providedCacheSelection(undefined, 'Not A Cache')).toThrow(
			CacheNameInvalidError
		);
	});

	it('refuses a private stored name in the public input', () => {
		expect(() => providedCacheSelection('private/release', undefined)).toThrow(
			CacheNameInvalidError
		);
	});
});

describe('cacheArguments', () => {
	it.each<{
		readonly name: string;
		readonly cache: StoredCache;
		readonly expected: readonly string[];
	}>([
		{
			name: 'the default cache is addressed by naming no cache',
			cache: DEFAULT_CACHE,
			expected: []
		},
		{
			name: 'a public cache',
			cache: cacheName('builds'),
			expected: ['--cache', 'builds']
		},
		{
			name: 'a private cache is addressed by local name',
			cache: privateStoredCache(cacheName('release')),
			expected: ['--private-cache', 'release']
		}
	])('$name', ({ cache, expected }) => {
		expect(cacheArguments(cache)).toStrictEqual(expected);
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
