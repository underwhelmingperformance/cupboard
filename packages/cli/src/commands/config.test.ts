import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import type { CacheAccessKeys } from '@cupboard/protocol/cache-access-keys';
import type { Reporter } from '@cupboard/reporter';
import { readUserInputSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import { cacheTargetFromUrl } from '../cache-target.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	InvalidCacheAccessKeysError,
	UnknownCacheAccessKeyError
} from '../errors.ts';
import { destinationAccessKey, sourceAccessKey } from '../test-support.ts';

import {
	cacheSubstituterUrl,
	type ConfigInput,
	parseCacheAccessKeys,
	resolveConfigSubstituters,
	runConfig,
	selectConfigCaches
} from './config.ts';

const defaultCache: CacheScope = { kind: 'default' };
const namedCache = (name: string): CacheScope => ({
	kind: 'named',
	name: cacheNameSchema.parse(name)
});
const buildsCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('builds')
};
const releaseCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('release')
};
const alice = readUserInputSchema.parse('alice');
const cupboard = readUserInputSchema.parse('cupboard');
const publishedPublicKey =
	'cupboard-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

interface CapturedOutput {
	readonly data: string[];
	readonly infos: string[];
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
					},
					result() {
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

function captureConfig(input: ConfigInput): CapturedOutput {
	const captured: CapturedOutput = { data: [], infos: [] };

	runConfig(input, capturingReporter(captured));

	return captured;
}

describe('runConfig', () => {
	it('writes a default-cache nix.conf snippet', () => {
		expect(
			captureConfig({
				url: new URL('https://cupboard.example.workers.dev/t/acme'),
				publicKey: publishedPublicKey,
				substituters: [{ cache: defaultCache }]
			})
		).toStrictEqual({
			data: [
				[
					'extra-substituters = https://cupboard.example.workers.dev/t/acme',
					`extra-trusted-public-keys = ${publishedPublicKey}`
				].join('\n')
			],
			infos: []
		});
	});

	it('renders named caches under one URL namespace regardless of access', () => {
		expect(
			captureConfig({
				url: new URL('https://cupboard.example.workers.dev/t/acme'),
				publicKey: publishedPublicKey,
				substituters: [
					{ cache: buildsCache },
					{
						cache: releaseCache,
						credential: { user: cupboard, password: destinationAccessKey }
					}
				]
			})
		).toStrictEqual({
			data: [
				[
					'extra-substituters = ' +
						'https://cupboard.example.workers.dev/t/acme/cache/builds ' +
						`https://cupboard:${destinationAccessKey}@cupboard.example.workers.dev/t/acme/cache/release`,
					`extra-trusted-public-keys = ${publishedPublicKey}`
				].join('\n')
			],
			infos: [
				[
					'# A substituter URL above contains a cache-specific access key.',
					'# Keep this snippet as secret as the access key itself.'
				].join('\n')
			]
		});
	});

	it('prints a shared access key as netrc guidance', () => {
		expect(
			captureConfig({
				url: new URL('https://cupboard.example.workers.dev/t/acme'),
				publicKey: publishedPublicKey,
				substituters: [{ cache: defaultCache }],
				netrcCredential: { user: cupboard, password: destinationAccessKey }
			})
		).toStrictEqual({
			data: [
				[
					'extra-substituters = https://cupboard.example.workers.dev/t/acme',
					`extra-trusted-public-keys = ${publishedPublicKey}`
				].join('\n')
			],
			infos: [
				[
					"# Add this line to the file configured by Nix's netrc-file setting:",
					'# Check its path with: nix config show netrc-file',
					`machine cupboard.example.workers.dev login cupboard password ${destinationAccessKey}`
				].join('\n')
			]
		});
	});
});

describe('parseCacheAccessKeys', () => {
	it.each([undefined, '  '])('reads %j as no access keys', (value) => {
		expect(parseCacheAccessKeys(value)).toStrictEqual([]);
	});

	it('reads explicit default and named cache scopes', () => {
		const document = JSON.stringify([
			{ cache: defaultCache, accessKey: destinationAccessKey },
			{ cache: releaseCache, accessKey: sourceAccessKey }
		]);

		expect(parseCacheAccessKeys(document)).toStrictEqual([
			{ cache: defaultCache, accessKey: destinationAccessKey },
			{ cache: releaseCache, accessKey: sourceAccessKey }
		]);
	});

	it.each([
		'not json',
		'{}',
		JSON.stringify([
			{
				cache: { kind: 'default' },
				credential: { user: 'ci', password: 'A'.repeat(43) }
			}
		]),
		JSON.stringify([
			{
				cache: { kind: 'named', name: 'Bad!' },
				accessKey: destinationAccessKey
			}
		])
	])('refuses the invalid document %j', (value) => {
		expect(() => parseCacheAccessKeys(value)).toThrow(
			InvalidCacheAccessKeysError
		);
	});
});

describe('resolveConfigSubstituters', () => {
	const releaseKey: CacheAccessKeys[number] = {
		cache: releaseCache,
		accessKey: destinationAccessKey
	};

	it('preserves selected order and attaches matching access keys', () => {
		expect(
			resolveConfigSubstituters(
				[defaultCache, releaseCache, buildsCache],
				[releaseKey]
			)
		).toStrictEqual([
			{ cache: defaultCache },
			{
				cache: releaseCache,
				credential: { user: cupboard, password: destinationAccessKey }
			},
			{ cache: buildsCache }
		]);
	});

	it('refuses an access key for an unselected cache', () => {
		expect(() =>
			resolveConfigSubstituters([buildsCache], [releaseKey])
		).toThrow(UnknownCacheAccessKeyError);
	});
});

describe('cacheSubstituterUrl', () => {
	it.each([
		{
			name: 'the default cache',
			cache: defaultCache,
			expected: 'https://cupboard.example.workers.dev/t/acme'
		},
		{
			name: 'a named cache',
			cache: releaseCache,
			expected: 'https://cupboard.example.workers.dev/t/acme/cache/release'
		}
	])('renders $name', ({ cache, expected }) => {
		const substituter = cacheSubstituterUrl(
			new URL('https://cupboard.example.workers.dev/t/acme'),
			cache
		);

		expect(canonicalHref(substituter)).toBe(expected);
	});

	it('escapes a credential in URL userinfo', () => {
		const substituter = cacheSubstituterUrl(
			new URL('https://cupboard.example.workers.dev/t/acme'),
			releaseCache,
			{ user: alice, password: 'p@ss word/:%' }
		);

		expect(canonicalHref(substituter)).toBe(
			'https://alice:p%40ss%20word%2F%3A%25@cupboard.example.workers.dev/t/acme/cache/release'
		);
	});
});

describe('selectConfigCaches', () => {
	const tenantTarget = cacheTargetFromUrl(
		parseWorkerUrl('https://cupboard.example.workers.dev/t/acme')
	);

	it.each([
		{
			label: 'the URL target when no name is given',
			names: [],
			hasDefaultCache: false,
			expected: [defaultCache]
		},
		{
			label: 'the default cache once when no name is given',
			names: [],
			hasDefaultCache: true,
			expected: [defaultCache]
		},
		{
			label: 'only the names given',
			names: ['builds', 'release'],
			hasDefaultCache: false,
			expected: [buildsCache, namedCache('release')]
		},
		{
			label: 'the default cache alongside the names given',
			names: ['builds', 'release'],
			hasDefaultCache: true,
			expected: [defaultCache, buildsCache, namedCache('release')]
		},
		{
			label: 'a cache named default beside the tenant default',
			names: ['default'],
			hasDefaultCache: true,
			expected: [defaultCache, namedCache('default')]
		}
	])('selects $label', ({ names, hasDefaultCache, expected }) => {
		expect(
			selectConfigCaches(tenantTarget, names, hasDefaultCache)
		).toStrictEqual(expected);
	});
});

describe('config selection from a named-cache URL', () => {
	it.each([
		{ hasDefaultCache: false, expected: [buildsCache] },
		{ hasDefaultCache: true, expected: [defaultCache, buildsCache] }
	])(
		'includes the default cache when requested: $hasDefaultCache',
		({ hasDefaultCache, expected }) => {
			const target = cacheTargetFromUrl(
				parseWorkerUrl(
					'https://cupboard.example.workers.dev/t/acme/cache/builds'
				)
			);
			expect(selectConfigCaches(target, [], hasDefaultCache)).toStrictEqual(
				expected
			);
		}
	);
});
