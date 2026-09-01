import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { ORPCError } from '@orpc/client';
import { describe, expect, it, vi } from 'vitest';

import {
	cacheExistsWith,
	cacheTargetFromUrl,
	cacheTargetWithName,
	resolveCachePositionals,
	splitDelimitedCachePositionals
} from './cache-target.ts';
import {
	CacheTargetConflictError,
	CacheTargetPayloadCountError,
	CacheTargetPayloadRequiredError,
	CommandPayloadRequiredError,
	InvalidCacheTargetUrlError
} from './errors.ts';

const tenantUrl = new URL('https://cupboard.test/t/acme');
const builds = cacheNameSchema.parse('builds');

describe('cacheTargetFromUrl', () => {
	it('selects the default cache at a tenant URL', () => {
		expect(cacheTargetFromUrl(tenantUrl)).toStrictEqual({
			tenantUrl,
			cache: { kind: 'default' }
		});
	});

	it('separates a named cache from its tenant URL', () => {
		expect(
			cacheTargetFromUrl(new URL('https://cupboard.test/t/acme/cache/builds'))
		).toStrictEqual({
			tenantUrl,
			cache: { kind: 'named', name: builds }
		});
	});

	it('maps a non-cache URL to a typed CLI usage error', () => {
		expect(() =>
			cacheTargetFromUrl(new URL('https://cupboard.test/t/acme/reuse/nightly'))
		).toThrow(InvalidCacheTargetUrlError);
	});
});

describe('cacheTargetWithName', () => {
	it('selects a named cache under a tenant target', () => {
		expect(
			cacheTargetWithName(cacheTargetFromUrl(tenantUrl), 'builds')
		).toStrictEqual({
			tenantUrl,
			cache: { kind: 'named', name: builds }
		});
	});

	it('refuses a second cache after a cache URL', () => {
		const target = cacheTargetFromUrl(
			new URL('https://cupboard.test/t/acme/cache/builds')
		);

		expect(() => cacheTargetWithName(target, 'release')).toThrow(
			CacheTargetConflictError
		);
	});
});

describe('splitDelimitedCachePositionals', () => {
	it('keeps every positional as command payload without a separator', () => {
		expect(
			splitDelimitedCachePositionals(
				['builds', 'nix', 'build'],
				[
					'build-push',
					'https://cupboard.test/t/acme',
					'builds',
					'nix',
					'build'
				],
				{ withoutSeparator: 'command-payload' }
			)
		).toStrictEqual({
			cacheName: undefined,
			payload: ['builds', 'nix', 'build']
		});
	});

	it('separates one cache name before the command boundary', () => {
		expect(
			splitDelimitedCachePositionals(
				['builds', 'nix', 'build'],
				[
					'build-push',
					'https://cupboard.test/t/acme',
					'builds',
					'--',
					'nix',
					'build'
				],
				{ withoutSeparator: 'command-payload' }
			)
		).toStrictEqual({
			cacheName: 'builds',
			payload: ['nix', 'build']
		});
	});

	it('preserves a later separator as command payload', () => {
		expect(
			splitDelimitedCachePositionals(
				['nix', 'build', '--', 'target'],
				[
					'build-push',
					'https://cupboard.test/t/acme',
					'--',
					'nix',
					'build',
					'--',
					'target'
				],
				{ withoutSeparator: 'command-payload' }
			)
		).toStrictEqual({
			cacheName: undefined,
			payload: ['nix', 'build', '--', 'target']
		});
	});

	it('refuses more than one positional before the boundary', () => {
		expect(() =>
			splitDelimitedCachePositionals(
				['builds', 'extra', 'nix'],
				[
					'build-push',
					'https://cupboard.test/t/acme',
					'builds',
					'extra',
					'--',
					'nix'
				],
				{ withoutSeparator: 'command-payload' }
			)
		).toThrow(CacheTargetPayloadCountError);
	});

	it('treats one undelimited positional as the cache in cache-only mode', () => {
		expect(
			splitDelimitedCachePositionals(
				['builds'],
				['build-push', '--cohorts-file', 'plan.json', 'builds'],
				{ withoutSeparator: 'cache-only' }
			)
		).toStrictEqual({ cacheName: 'builds', payload: [] });
	});

	it('refuses two undelimited positionals in cache-only mode', () => {
		expect(() =>
			splitDelimitedCachePositionals(
				['builds', 'extra'],
				['build-push', '--cohorts-file', 'plan.json', 'builds', 'extra'],
				{ withoutSeparator: 'cache-only' }
			)
		).toThrow(CacheTargetPayloadCountError);
	});
});

describe('resolveCachePositionals', () => {
	it('requires the configured minimum payload for an explicit cache URL', async () => {
		await expect(
			resolveCachePositionals(
				new URL('https://cupboard.test/t/acme/cache/builds'),
				[],
				{
					minimumPayload: 1,
					payloadDescription: 'a path',
					cacheExists: () => Promise.resolve(true)
				}
			)
		).rejects.toBeInstanceOf(CommandPayloadRequiredError);
	});

	it('enforces the configured maximum payload', async () => {
		await expect(
			resolveCachePositionals(tenantUrl, ['./one', './two'], {
				minimumPayload: 1,
				maximumPayload: 1,
				payloadDescription: 'a path',
				cacheExists: () => Promise.resolve(false)
			})
		).rejects.toBeInstanceOf(CacheTargetPayloadCountError);
	});

	it('uses the cache selected by the URL without probing a payload', async () => {
		const cacheExists = vi.fn<() => Promise<boolean>>();

		await expect(
			resolveCachePositionals(
				new URL('https://cupboard.test/t/acme/cache/builds'),
				['result'],
				{ minimumPayload: 1, payloadDescription: 'a path', cacheExists }
			)
		).resolves.toStrictEqual({
			target: {
				tenantUrl,
				cache: { kind: 'named', name: builds }
			},
			payload: ['result']
		});
		expect(cacheExists).not.toHaveBeenCalled();
	});

	it('consumes an existing cache name after a tenant URL', async () => {
		const cacheExists = vi.fn(() => Promise.resolve(true));

		await expect(
			resolveCachePositionals(tenantUrl, ['builds', 'result'], {
				minimumPayload: 1,
				payloadDescription: 'a path',
				cacheExists
			})
		).resolves.toStrictEqual({
			target: {
				tenantUrl,
				cache: { kind: 'named', name: builds }
			},
			payload: ['result']
		});
		expect(cacheExists).toHaveBeenCalledWith({
			tenantUrl,
			cache: { kind: 'named', name: builds }
		});
	});

	it('keeps a missing cache candidate as default-cache payload', async () => {
		await expect(
			resolveCachePositionals(tenantUrl, ['result'], {
				minimumPayload: 1,
				payloadDescription: 'a path',
				cacheExists: () => Promise.resolve(false)
			})
		).resolves.toStrictEqual({
			target: { tenantUrl, cache: { kind: 'default' } },
			payload: ['result']
		});
	});

	it('does not probe an explicit local path', async () => {
		const cacheExists = vi.fn<() => Promise<boolean>>();

		await expect(
			resolveCachePositionals(tenantUrl, ['./result'], {
				minimumPayload: 1,
				payloadDescription: 'a path',
				cacheExists
			})
		).resolves.toStrictEqual({
			target: { tenantUrl, cache: { kind: 'default' } },
			payload: ['./result']
		});
		expect(cacheExists).not.toHaveBeenCalled();
	});

	it('explains when consuming a cache leaves required payload missing', async () => {
		const result = resolveCachePositionals(tenantUrl, ['builds'], {
			minimumPayload: 1,
			payloadDescription: 'a path',
			cacheExists: () => Promise.resolve(true)
		});

		await expect(result).rejects.toStrictEqual(
			expect.objectContaining({
				name: 'CacheTargetPayloadRequiredError',
				message:
					"Cache 'builds' exists, so Cupboard treated 'builds' as the cache target, but the command still requires a path. " +
					"Use './builds' to pass a local path to the default cache, or select the cache explicitly with https://cupboard.test/t/acme/cache/builds."
			})
		);
		await expect(result).rejects.toBeInstanceOf(
			CacheTargetPayloadRequiredError
		);
	});
});

describe('cacheExistsWith', () => {
	it('returns true when the exact cache lookup succeeds', async () => {
		const get = {
			inDefaultCache: vi.fn(() => Promise.resolve({ exists: true })),
			inNamedCache: vi.fn(() => Promise.resolve({ exists: true }))
		};
		const exists = cacheExistsWith({ get });

		await expect(
			exists({ tenantUrl, cache: { kind: 'named', name: builds } })
		).resolves.toBe(true);
		expect(get.inNamedCache).toHaveBeenCalledWith({ cacheName: builds });
	});

	it('returns false only for the typed not-found response', async () => {
		const exists = cacheExistsWith({
			get: {
				inDefaultCache: vi.fn(),
				inNamedCache: vi.fn(() =>
					Promise.reject(new ORPCError('NOT_FOUND', { status: 404 }))
				)
			}
		});

		await expect(
			exists({ tenantUrl, cache: { kind: 'named', name: builds } })
		).resolves.toBe(false);
	});

	it('preserves every other failure', async () => {
		const failure = new ORPCError('FORBIDDEN', { status: 403 });
		const exists = cacheExistsWith({
			get: {
				inDefaultCache: vi.fn(),
				inNamedCache: vi.fn(() => Promise.reject(failure))
			}
		});

		await expect(
			exists({ tenantUrl, cache: { kind: 'named', name: builds } })
		).rejects.toBe(failure);
	});
});
