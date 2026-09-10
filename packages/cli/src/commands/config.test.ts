import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import type { CacheCredentials } from '@cupboard/protocol/cache-credentials';
import type { Reporter } from '@cupboard/reporter';
import { readUserInputSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import {
	InvalidCacheCredentialsError,
	UnknownCacheCredentialError
} from '../errors.ts';

import {
	cacheSubstituterUrl,
	type ConfigInput,
	parseCacheCredentials,
	resolveConfigSubstituters,
	runConfig
} from './config.ts';

const defaultCache = { kind: 'default' } as const satisfies CacheScope;
const buildsCache = {
	kind: 'named',
	name: cacheNameSchema.parse('builds')
} as const satisfies CacheScope;
const releaseCache = {
	kind: 'named',
	name: cacheNameSchema.parse('release')
} as const satisfies CacheScope;
const alice = readUserInputSchema.parse('alice');
const ci = readUserInputSchema.parse('ci');
const correctHorse = 'correct-horse-battery-staple';
const readPassword = 'A'.repeat(43);
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
						credential: { user: ci, password: readPassword }
					}
				]
			})
		).toStrictEqual({
			data: [
				[
					'extra-substituters = ' +
						'https://cupboard.example.workers.dev/t/acme/cache/builds ' +
						`https://ci:${readPassword}@cupboard.example.workers.dev/t/acme/cache/release`,
					`extra-trusted-public-keys = ${publishedPublicKey}`
				].join('\n')
			],
			infos: [
				[
					'# A substituter URL above contains a cache-specific read credential.',
					'# Keep this snippet as secret as the credential itself.'
				].join('\n')
			]
		});
	});

	it('prints a shared read credential as netrc guidance', () => {
		expect(
			captureConfig({
				url: new URL('https://cupboard.example.workers.dev/t/acme'),
				publicKey: publishedPublicKey,
				substituters: [{ cache: defaultCache }],
				netrcCredential: { user: alice, password: correctHorse }
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
					'# Add this line to your Nix netrc-file (for example, ~/.config/nix/netrc):',
					`machine cupboard.example.workers.dev login alice password ${correctHorse}`
				].join('\n')
			]
		});
	});
});

describe('parseCacheCredentials', () => {
	it.each([undefined, '  '])('reads %j as no credentials', (value) => {
		expect(parseCacheCredentials(value)).toStrictEqual([]);
	});

	it('reads explicit default and named cache scopes', () => {
		const document = JSON.stringify([
			{
				cache: defaultCache,
				credential: { user: 'alice', password: readPassword }
			},
			{
				cache: releaseCache,
				credential: { user: 'ci', password: readPassword }
			}
		]);

		expect(parseCacheCredentials(document)).toStrictEqual([
			{
				cache: defaultCache,
				credential: { user: alice, password: readPassword }
			},
			{
				cache: releaseCache,
				credential: { user: ci, password: readPassword }
			}
		]);
	});

	it.each([
		'not json',
		'{}',
		JSON.stringify([
			{ cache: { kind: 'default' }, credential: { user: 'ci' } }
		]),
		JSON.stringify([
			{
				cache: { kind: 'named', name: 'Bad!' },
				credential: { user: 'ci', password: readPassword }
			}
		])
	])('refuses the invalid document %j', (value) => {
		expect(() => parseCacheCredentials(value)).toThrow(
			InvalidCacheCredentialsError
		);
	});
});

describe('resolveConfigSubstituters', () => {
	const releaseCredential = {
		cache: releaseCache,
		credential: { user: ci, password: readPassword }
	} as const;

	it('preserves selected order and attaches matching credentials', () => {
		expect(
			resolveConfigSubstituters(
				[defaultCache, releaseCache, buildsCache],
				[releaseCredential]
			)
		).toStrictEqual([
			{ cache: defaultCache },
			{ cache: releaseCache, credential: releaseCredential.credential },
			{ cache: buildsCache }
		]);
	});

	it('refuses a credential for an unselected cache', () => {
		const credentials: CacheCredentials = [releaseCredential];

		expect(() => resolveConfigSubstituters([buildsCache], credentials)).toThrow(
			UnknownCacheCredentialError
		);
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
