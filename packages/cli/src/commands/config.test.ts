import {
	type CacheName,
	cacheNameSchema,
	DEFAULT_CACHE,
	privateStoredCache,
	type StoredCache
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import type { PrivateCacheCredentials } from '@cupboard/protocol/private-cache-credentials';
import type { Reporter } from '@cupboard/reporter';
import { readUserInputSchema } from '@cupboard/shared/http';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	InvalidCacheNameError,
	InvalidPrivateCacheCredentialsError,
	PrivateCacheCredentialRequiredError,
	UnknownPrivateCacheCredentialError
} from '../errors.ts';

import {
	addConfigCacheOptions,
	cacheSubstituterUrl,
	type ConfigInput,
	parsePrivateCacheCredentials,
	resolveConfigSubstituters,
	runConfig
} from './config.ts';

const cacheName = (value: string): CacheName => cacheNameSchema.parse(value);
const alice = readUserInputSchema.parse('alice');
const bob = readUserInputSchema.parse('bob');
const ci = readUserInputSchema.parse('ci');
const buildsCache = cacheName('builds');
const guidesCache = cacheName('guides');
const releaseCache = privateStoredCache(cacheName('release'));
const stagingCache = privateStoredCache(cacheName('staging'));
const correctHorse = 'correct-horse-battery-staple';
// A read password is 32 random bytes rendered as 43 base64url characters.
const readPassword = 'A'.repeat(43);
const otherReadPassword = 'B'.repeat(43);
const publishedPublicKey =
	'cupboard-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

interface CapturedOutput {
	readonly data: string[];
	readonly infos: string[];
}

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

function capturingReporter(captured: CapturedOutput): Reporter {
	return {
		phase: (_label, body) =>
			Promise.resolve(
				body({
					fact() {
						return;
					},
					warn() {
						return;
					}
				})
			),
		progress: (_label, _options, body) =>
			Promise.resolve(
				body({
					advance() {
						return;
					},
					fact() {
						return;
					},
					warn() {
						return;
					}
				})
			),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message() {
						return;
					},
					group: () => ({
						message() {
							return;
						},
						success() {
							return;
						},
						error() {
							return;
						}
					}),
					warn() {
						return;
					}
				})
			),
		result() {
			return;
		},
		data(text) {
			captured.data.push(text);
		},
		warn() {
			return;
		},
		info(message) {
			captured.infos.push(message);
		},
		success(message) {
			captured.infos.push(message);
		},
		step(message) {
			captured.infos.push(message);
		},
		error() {
			return;
		}
	};
}

const tenantUrl = new URL('https://cupboard.example.workers.dev');
const trustedKeysLine = `extra-trusted-public-keys = ${publishedPublicKey}`;
const nixConfig = [
	'extra-substituters = https://cupboard.example.workers.dev',
	trustedKeysLine
].join('\n');
const netrcGuidance = (machine: string, password: string): string =>
	[
		'# Private tenant: add this line to your Nix netrc-file ' +
			'(e.g. ~/.config/nix/netrc):',
		`machine ${machine} login alice password ${password}`
	].join('\n');
const userinfoGuidance = [
	'# Every private-cache read requires authentication. The substituter URL ' +
		'above contains its read credential.',
	'# Keep this snippet as secret as the credential itself.'
].join('\n');

function selected(
	isPrivate: boolean,
	name: string,
	position: number
): {
	readonly isPrivate: boolean;
	readonly name: string;
	readonly position: number;
} {
	return { isPrivate, name, position };
}

function captureConfig(input: ConfigInput): CapturedOutput {
	const captured: CapturedOutput = { data: [], infos: [] };

	runConfig(input, capturingReporter(captured));

	return captured;
}

describe('runConfig', () => {
	it('writes a nix.conf snippet to the payload stream', () => {
		expect(
			captureConfig({
				url: tenantUrl,
				publicKey: publishedPublicKey,
				substituters: [{ cache: DEFAULT_CACHE }]
			})
		).toStrictEqual({ data: [nixConfig], infos: [] });
	});

	it('writes the nix.conf to the payload and the netrc as guidance', () => {
		expect(
			captureConfig({
				url: tenantUrl,
				publicKey: publishedPublicKey,
				substituters: [{ cache: DEFAULT_CACHE }],
				netrcCredential: { user: alice, password: correctHorse }
			})
		).toStrictEqual({
			data: [nixConfig],
			infos: [netrcGuidance('cupboard.example.workers.dev', correctHorse)]
		});
	});

	it('uses the URL hostname for the netrc machine', () => {
		expect(
			captureConfig({
				url: new URL('http://localhost:1234'),
				publicKey: publishedPublicKey,
				substituters: [{ cache: DEFAULT_CACHE }],
				netrcCredential: { user: alice, password: correctHorse }
			})
		).toStrictEqual({
			data: [
				['extra-substituters = http://localhost:1234', trustedKeysLine].join(
					'\n'
				)
			],
			infos: [netrcGuidance('localhost', correctHorse)]
		});
	});

	it('renders every selected cache on one substituters line', () => {
		const base = new URL('https://cupboard.example.workers.dev/t/acme');

		expect(
			captureConfig({
				url: base,
				publicKey: publishedPublicKey,
				substituters: [
					{ cache: DEFAULT_CACHE },
					{ cache: buildsCache },
					{
						cache: releaseCache,
						credential: { user: alice, password: correctHorse }
					},
					{
						cache: stagingCache,
						credential: { user: bob, password: 'p@ss%20word' }
					}
				]
			})
		).toStrictEqual({
			data: [
				[
					'extra-substituters = ' +
						[
							'https://cupboard.example.workers.dev/t/acme',
							'https://cupboard.example.workers.dev/t/acme/cache/builds',
							'https://alice:correct-horse-battery-staple@cupboard.example.workers.dev/t/acme/private-cache/release',
							'https://bob:p%40ss%2520word@cupboard.example.workers.dev/t/acme/private-cache/staging'
						].join(' '),
					trustedKeysLine
				].join('\n')
			],
			infos: [userinfoGuidance]
		});
	});

	it('composes tenant netrc guidance with a private-cache userinfo URL', () => {
		const base = new URL('https://cupboard.example.workers.dev/t/acme');

		expect(
			captureConfig({
				url: base,
				publicKey: publishedPublicKey,
				substituters: [
					{ cache: DEFAULT_CACHE },
					{
						cache: releaseCache,
						credential: { user: bob, password: 'hunter2' }
					}
				],
				netrcCredential: { user: alice, password: correctHorse }
			})
		).toStrictEqual({
			data: [
				[
					'extra-substituters = ' +
						[
							'https://cupboard.example.workers.dev/t/acme',
							'https://bob:hunter2@cupboard.example.workers.dev/t/acme/private-cache/release'
						].join(' '),
					trustedKeysLine
				].join('\n')
			],
			infos: [
				netrcGuidance('cupboard.example.workers.dev', correctHorse),
				userinfoGuidance
			]
		});
	});
});

describe('parsePrivateCacheCredentials', () => {
	it.each([
		{ name: 'an absent value', value: undefined },
		{ name: 'a blank value', value: '  ' }
	])('reads $name as no credential', ({ value }) => {
		expect(parsePrivateCacheCredentials(value)).toStrictEqual(new Map());
	});

	it('reads the credential of every cache the document names', () => {
		expect(
			parsePrivateCacheCredentials(
				JSON.stringify({
					release: { user: 'ci', password: readPassword },
					staging: { user: 'bob', password: otherReadPassword }
				})
			)
		).toStrictEqual(
			new Map([
				[cacheName('release'), { user: ci, password: readPassword }],
				[cacheName('staging'), { user: bob, password: otherReadPassword }]
			])
		);
	});

	it('returns no credential for an unlisted cache named constructor', () => {
		const credentials = parsePrivateCacheCredentials(
			JSON.stringify({ release: { user: 'ci', password: readPassword } })
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
	])('refuses a document that $name', ({ value }) => {
		expect(() => parsePrivateCacheCredentials(value)).toThrow(
			InvalidPrivateCacheCredentialsError
		);
	});
});

describe('resolveConfigSubstituters', () => {
	const shared = { user: alice, password: correctHorse };
	const noCredentials: PrivateCacheCredentials = new Map();

	it('configures the default cache when no cache is named', () => {
		expect(
			resolveConfigSubstituters([], undefined, noCredentials)
		).toStrictEqual([{ cache: DEFAULT_CACHE }]);
	});

	it('returns the caches in the order they were named', () => {
		expect(
			resolveConfigSubstituters(
				[
					selected(false, 'builds', 0),
					selected(false, 'guides', 2),
					selected(true, 'release', 1)
				],
				shared,
				noCredentials
			)
		).toStrictEqual([
			{ cache: buildsCache },
			{
				cache: releaseCache,
				credential: shared
			},
			{ cache: guidesCache }
		]);
	});

	it('keeps a-b and a.b as distinct credential keys', () => {
		const credentials = parsePrivateCacheCredentials(
			JSON.stringify({
				'a-b': { user: 'ci', password: readPassword },
				'a.b': { user: 'bob', password: otherReadPassword }
			})
		);

		expect(
			resolveConfigSubstituters(
				[
					selected(true, 'a-b', 0),
					selected(true, 'a.b', 1),
					selected(true, 'release', 2)
				],
				shared,
				credentials
			)
		).toStrictEqual([
			{
				cache: privateStoredCache(cacheName('a-b')),
				credential: { user: ci, password: readPassword }
			},
			{
				cache: privateStoredCache(cacheName('a.b')),
				credential: { user: bob, password: otherReadPassword }
			},
			{ cache: releaseCache, credential: shared }
		]);
	});

	it.each([
		{ name: 'an ordinary name', cache: 'release' },
		{
			name: 'a name that is a property of Object.prototype',
			cache: 'constructor'
		}
	])(
		'refuses a private cache with no resolvable credential and $name',
		({ cache }) => {
			const error = thrownBy(() =>
				resolveConfigSubstituters(
					[selected(false, 'builds', 0), selected(true, cache, 1)],
					undefined,
					noCredentials
				)
			);

			expect(error).toBeInstanceOf(PrivateCacheCredentialRequiredError);

			if (error instanceof PrivateCacheCredentialRequiredError) {
				expect({ name: error.name, cache: error.cache }).toStrictEqual({
					name: 'PrivateCacheCredentialRequiredError',
					cache
				});
			}
		}
	);

	it('requires every credential to match a selected private cache', () => {
		const credentials = parsePrivateCacheCredentials(
			JSON.stringify({ staging: { user: 'ci', password: readPassword } })
		);
		const error = thrownBy(() =>
			resolveConfigSubstituters(
				[selected(true, 'release', 0)],
				shared,
				credentials
			)
		);

		expect(error).toBeInstanceOf(UnknownPrivateCacheCredentialError);

		if (error instanceof UnknownPrivateCacheCredentialError) {
			expect({ name: error.name, cache: error.cache }).toStrictEqual({
				name: 'UnknownPrivateCacheCredentialError',
				cache: 'staging'
			});
		}
	});

	it('rejects an invalid private cache name', () => {
		const error = thrownBy(() =>
			resolveConfigSubstituters(
				[selected(true, 'Bad!', 0)],
				shared,
				noCredentials
			)
		);

		expect(error).toBeInstanceOf(InvalidCacheNameError);

		if (error instanceof InvalidCacheNameError) {
			expect({ name: error.name, cache: error.cache }).toStrictEqual({
				name: 'InvalidCacheNameError',
				cache: 'Bad!'
			});
		}
	});
});

function parseSelection(arguments_: readonly string[]): readonly unknown[] {
	const command = addConfigCacheOptions(new Command());

	command.parse([...arguments_], { from: 'user' });

	const options = command.opts<{
		readonly cache: readonly unknown[];
		readonly privateCache: readonly unknown[];
	}>();

	return [...options.cache, ...options.privateCache];
}

describe('addConfigCacheOptions', () => {
	it('preserves command-line order across --cache and --private-cache', () => {
		expect(
			parseSelection([
				'--private-cache',
				'release',
				'--cache',
				'builds',
				'--private-cache',
				'staging'
			])
		).toStrictEqual([
			selected(false, 'builds', 1),
			selected(true, 'release', 0),
			selected(true, 'staging', 2)
		]);
	});

	it('names no cache when neither option is given', () => {
		expect(parseSelection([])).toStrictEqual([]);
	});
});

describe('cacheSubstituterUrl', () => {
	it.each<{
		readonly name: string;
		readonly cache: StoredCache;
		readonly url: string;
		readonly expected: string;
	}>([
		{
			name: 'the default cache returns the bare URL',
			cache: DEFAULT_CACHE,
			url: 'https://cupboard.example.workers.dev',
			expected: 'https://cupboard.example.workers.dev'
		},
		{
			name: 'a named cache appends the cache path to a bare host',
			cache: buildsCache,
			url: 'https://cupboard.example.workers.dev',
			expected: 'https://cupboard.example.workers.dev/cache/builds'
		},
		{
			name: 'a named cache preserves a tenant path prefix',
			cache: buildsCache,
			url: 'https://cupboard.example.workers.dev/t/acme',
			expected: 'https://cupboard.example.workers.dev/t/acme/cache/builds'
		},
		{
			name: 'a private cache uses the private namespace',
			cache: releaseCache,
			url: 'https://cupboard.example.workers.dev/t/acme',
			expected:
				'https://cupboard.example.workers.dev/t/acme/private-cache/release'
		}
	])('$name', ({ cache, expected, url }) => {
		const substituter = cacheSubstituterUrl(new URL(url), cache);

		expect(canonicalHref(substituter)).toBe(expected);
	});

	it.each([
		{
			name: 'a plain credential',
			credential: { user: alice, password: correctHorse },
			expected:
				'https://alice:correct-horse-battery-staple@cupboard.example.workers.dev/t/acme/private-cache/release'
		},
		{
			name: 'a credential containing userinfo delimiters',
			credential: { user: bob, password: 'p@ss word/:%' },
			expected:
				'https://bob:p%40ss%20word%2F%3A%25@cupboard.example.workers.dev/t/acme/private-cache/release'
		}
	])('escapes $name', ({ credential, expected }) => {
		const substituter = cacheSubstituterUrl(
			new URL('https://cupboard.example.workers.dev/t/acme'),
			releaseCache,
			credential
		);

		expect(canonicalHref(substituter)).toBe(expected);
		expect({
			user: decodeURIComponent(substituter.username),
			password: decodeURIComponent(substituter.password)
		}).toStrictEqual({
			user: credential.user,
			password: credential.password
		});
	});
});
