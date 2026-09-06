import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import {
	type CacheName,
	cacheNameSchema,
	cachePrioritySchema,
	graceSecondsSchema,
	rootNameSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import {
	cacheRemoveResponseSchema,
	type CacheSummaryInput,
	cacheSummarySchema
} from '@cupboard/protocol/caches';
import type { ResultRow } from '@cupboard/reporter';
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import { InvalidCachePriorityError } from '../errors.ts';

const cacheName = (value: string): CacheName => cacheNameSchema.parse(value);

import {
	type CacheClient,
	parsePriority,
	runCacheClearGrace,
	runCacheClearRootTtl,
	runCacheCreate,
	runCacheInspect,
	runCacheList,
	runCacheRemove,
	runCacheSetAccess,
	runCacheSetGrace,
	runCacheSetPriority,
	runCacheSetRootTtl
} from './cache.ts';

function cacheSummary(
	value: Omit<
		CacheSummaryInput,
		'defaultRootTtl' | 'grace' | 'rootTtlOverrides'
	> &
		Partial<
			Pick<CacheSummaryInput, 'defaultRootTtl' | 'grace' | 'rootTtlOverrides'>
		>
) {
	return cacheSummarySchema.parse({
		defaultRootTtl: { kind: 'permanent' },
		grace: { kind: 'none' },
		rootTtlOverrides: [],
		...value
	});
}

function cacheClient(overrides: Partial<CacheClient>): CacheClient {
	return {
		list: () => Promise.resolve({ caches: [] }),
		get: {
			inDefaultCache: () =>
				Promise.reject(new ORPCError('NOT_FOUND', { status: 404 })),
			inNamedCache: () =>
				Promise.reject(new ORPCError('NOT_FOUND', { status: 404 }))
		},
		put: {
			inDefaultCache: ({ access, priority }) =>
				Promise.resolve(
					cacheSummary({
						scope: { kind: 'default' },
						access,
						priority,
						storePaths: 0
					})
				),
			inNamedCache: ({ cacheName, access, priority }) =>
				Promise.resolve(
					cacheSummary({
						scope: { kind: 'named', name: cacheName },
						access,
						priority,
						storePaths: 0
					})
				)
		},
		update: {
			inDefaultCache: (input) =>
				Promise.resolve(
					cacheSummary({
						scope: { kind: 'default' },
						access: input.kind === 'access' ? input.access : 'public',
						priority: input.kind === 'priority' ? input.priority : 40,
						storePaths: 0
					})
				),
			inNamedCache: (input) =>
				Promise.resolve(
					cacheSummary({
						scope: { kind: 'named', name: input.cacheName },
						access: input.kind === 'access' ? input.access : 'public',
						priority: input.kind === 'priority' ? input.priority : 40,
						storePaths: 0
					})
				)
		},
		remove: ({ params }) =>
			Promise.resolve(
				cacheRemoveResponseSchema.parse({
					scope: { kind: 'named', name: params.cacheName },
					removed: false,
					storePathsRemoved: 0
				})
			),
		...overrides
	};
}

describe('parsePriority', () => {
	it('accepts a decimal integer', () => {
		expect(parsePriority('50')).toBe(50);
	});

	it.each([[''], ['1e2'], ['0x10'], ['-1'], ['1.5'], ['soon'], ['010']])(
		"rejects '%s'",
		(value) => {
			expect(() => parsePriority(value)).toThrow(InvalidCachePriorityError);
		}
	);
});

describe('runCacheList', () => {
	it('reports a row per cache, labelling the default and its grace state', async () => {
		const results: ResultRow[][] = [];
		const response = {
			caches: [
				cacheSummary({
					scope: { kind: 'default' },
					access: 'private',
					priority: 40,
					storePaths: 0,
					graceManaged: false
				}),
				cacheSummary({
					scope: { kind: 'named', name: 'builds' },
					access: 'public',
					priority: 30,
					storePaths: 5,
					defaultRootTtl: { kind: 'duration', ttlSeconds: 1_209_600 },
					grace: { kind: 'duration', graceSeconds: 86_400 },
					rootTtlOverrides: [
						{ rootPrefix: 'github:acme/', ttlSeconds: 604_800 }
					],
					graceManaged: true,
					earliestGraceDeadline: '2026-03-01T00:00:00.000Z'
				}),
				cacheSummary({
					scope: { kind: 'named', name: 'drained' },
					access: 'private',
					priority: 45,
					storePaths: 0,
					graceManaged: true
				})
			]
		};

		await runCacheList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{
					label: '(default)',
					value:
						'private; priority 40; 0 path(s); default root TTL permanent; grace none; 0 root TTL override(s)'
				},
				{
					label: 'builds',
					value:
						'public; priority 30; 5 path(s); default root TTL 1,209,600s; grace 86,400s; 1 root TTL override(s); grace-managed; earliest deadline 2026-03-01 00:00 UTC'
				},
				{
					label: 'drained',
					value:
						'private; priority 45; 0 path(s); default root TTL permanent; grace none; 0 root TTL override(s); grace-managed'
				}
			]
		]);
	});

	it('lists access independently from the cache name', async () => {
		const results: ResultRow[][] = [];
		const response = {
			caches: [
				cacheSummary({
					scope: { kind: 'named', name: 'release' },
					access: 'private',
					priority: 30,
					storePaths: 5
				}),
				cacheSummary({
					scope: { kind: 'named', name: 'builds' },
					access: 'public',
					priority: 40,
					storePaths: 1
				})
			]
		};

		await runCacheList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{
					label: 'release',
					value:
						'private; priority 30; 5 path(s); default root TTL permanent; grace none; 0 root TTL override(s)'
				},
				{
					label: 'builds',
					value:
						'public; priority 40; 1 path(s); default root TTL permanent; grace none; 0 root TTL override(s)'
				}
			]
		]);
	});

	it('reports nothing when there are no caches', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runCacheList(
			reporter(results, infos),
			cacheClient({ list: () => Promise.resolve({ caches: [] }) })
		);

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No caches.']
		});
	});
});

describe('runCacheCreate', () => {
	it('creates the cache and reports the summary', async () => {
		const calls: unknown[] = [];
		const results: ResultRow[][] = [];
		const summary = cacheSummary({
			scope: { kind: 'named', name: 'builds' },
			access: 'private',
			priority: 30,
			storePaths: 0
		});

		await runCacheCreate(
			{ kind: 'named', name: cacheName('builds') },
			'private',
			cachePrioritySchema.parse(30),
			ttlSecondsSchema.parse(1_209_600),
			graceSecondsSchema.parse(86_400),
			reporter(results),
			cacheClient({
				put: {
					inDefaultCache: () => Promise.resolve(summary),
					inNamedCache(input) {
						calls.push(input);
						return Promise.resolve(summary);
					}
				}
			})
		);

		expect({ calls, results }).toStrictEqual({
			calls: [
				{
					cacheName: 'builds',
					access: 'private',
					priority: 30,
					defaultRootTtl: { kind: 'duration', ttlSeconds: 1_209_600 },
					grace: { kind: 'duration', graceSeconds: 86_400 }
				}
			],
			results: [
				[
					{ label: 'Cache', value: 'builds' },
					{ label: 'Access', value: 'private' },
					{ label: 'Priority', value: '30' },
					{ label: 'Store paths', value: '0' },
					{ label: 'Default root TTL', value: 'permanent' },
					{ label: 'Grace', value: 'none' },
					{ label: 'Root TTL overrides', value: 'none' }
				]
			]
		});
	});

	it('creates a permanent cache without grace when retention options are omitted', async () => {
		const calls: unknown[] = [];
		const summary = cacheSummary({
			scope: { kind: 'named', name: 'builds' },
			access: 'public',
			priority: 40,
			storePaths: 0
		});

		await runCacheCreate(
			{ kind: 'named', name: cacheName('builds') },
			'public',
			cachePrioritySchema.parse(40),
			undefined,
			undefined,
			reporter([]),
			cacheClient({
				put: {
					inDefaultCache: () => Promise.resolve(summary),
					inNamedCache(input) {
						calls.push(input);
						return Promise.resolve(summary);
					}
				}
			})
		);

		expect(calls).toStrictEqual([
			{
				cacheName: 'builds',
				access: 'public',
				priority: 40,
				defaultRootTtl: { kind: 'permanent' },
				grace: { kind: 'none' }
			}
		]);
	});
});

describe('cache property updates', () => {
	it('sets only the selected cache access property', async () => {
		const calls: unknown[] = [];
		const summary = cacheSummary({
			scope: { kind: 'named', name: 'builds' },
			access: 'private',
			priority: 40,
			storePaths: 0
		});

		await runCacheSetAccess(
			{ kind: 'named', name: cacheName('builds') },
			'private',
			reporter([]),
			cacheClient({
				update: {
					inDefaultCache: () => Promise.resolve(summary),
					inNamedCache(input) {
						calls.push(input);
						return Promise.resolve(summary);
					}
				}
			})
		);

		expect(calls).toStrictEqual([
			{ cacheName: 'builds', kind: 'access', access: 'private' }
		]);
	});

	it('sets only the selected cache priority property', async () => {
		const calls: unknown[] = [];
		const summary = cacheSummary({
			scope: { kind: 'default' },
			access: 'public',
			priority: 30,
			storePaths: 0
		});

		await runCacheSetPriority(
			{ kind: 'default' },
			cachePrioritySchema.parse(30),
			reporter([]),
			cacheClient({
				update: {
					inDefaultCache(input) {
						calls.push(input);
						return Promise.resolve(summary);
					},
					inNamedCache: () => Promise.resolve(summary)
				}
			})
		);

		expect(calls).toStrictEqual([{ kind: 'priority', priority: 30 }]);
	});

	it.each([
		{
			name: 'the cache default',
			rootPrefix: undefined,
			expected: { kind: 'set-default-root-ttl', ttlSeconds: 86_400 }
		},
		{
			name: 'a root-prefix override',
			rootPrefix: rootNameSchema.parse('github:acme/'),
			expected: {
				kind: 'set-root-ttl-override',
				rootPrefix: 'github:acme/',
				ttlSeconds: 86_400
			}
		}
	])('sets the root TTL for $name', async ({ rootPrefix, expected }) => {
		const calls: unknown[] = [];
		const summary = cacheSummary({
			scope: { kind: 'default' },
			access: 'public',
			priority: 40,
			storePaths: 0
		});

		await runCacheSetRootTtl(
			{ kind: 'default' },
			rootPrefix,
			ttlSecondsSchema.parse(86_400),
			reporter([]),
			cacheClient({
				update: {
					inDefaultCache(input) {
						calls.push(input);
						return Promise.resolve(summary);
					},
					inNamedCache: () => Promise.resolve(summary)
				}
			})
		);

		expect(calls).toStrictEqual([expected]);
	});

	it.each([
		{
			name: 'the cache default',
			rootPrefix: undefined,
			expected: { kind: 'clear-default-root-ttl' }
		},
		{
			name: 'a root-prefix override',
			rootPrefix: rootNameSchema.parse('github:acme/'),
			expected: {
				kind: 'clear-root-ttl-override',
				rootPrefix: 'github:acme/'
			}
		}
	])('clears the root TTL for $name', async ({ rootPrefix, expected }) => {
		const calls: unknown[] = [];
		const summary = cacheSummary({
			scope: { kind: 'named', name: 'builds' },
			access: 'public',
			priority: 40,
			storePaths: 0
		});

		await runCacheClearRootTtl(
			{ kind: 'named', name: cacheName('builds') },
			rootPrefix,
			reporter([]),
			cacheClient({
				update: {
					inDefaultCache: () => Promise.resolve(summary),
					inNamedCache(input) {
						calls.push(input);
						return Promise.resolve(summary);
					}
				}
			})
		);

		expect(calls).toStrictEqual([{ cacheName: 'builds', ...expected }]);
	});

	it('sets the cache grace period', async () => {
		const calls: unknown[] = [];
		const summary = cacheSummary({
			scope: { kind: 'default' },
			access: 'public',
			priority: 40,
			storePaths: 0
		});

		await runCacheSetGrace(
			{ kind: 'default' },
			graceSecondsSchema.parse(0),
			reporter([]),
			cacheClient({
				update: {
					inDefaultCache(input) {
						calls.push(input);
						return Promise.resolve(summary);
					},
					inNamedCache: () => Promise.resolve(summary)
				}
			})
		);

		expect(calls).toStrictEqual([{ kind: 'set-grace', graceSeconds: 0 }]);
	});

	it('clears the cache grace period', async () => {
		const calls: unknown[] = [];
		const summary = cacheSummary({
			scope: { kind: 'named', name: 'builds' },
			access: 'public',
			priority: 40,
			storePaths: 0
		});

		await runCacheClearGrace(
			{ kind: 'named', name: cacheName('builds') },
			reporter([]),
			cacheClient({
				update: {
					inDefaultCache: () => Promise.resolve(summary),
					inNamedCache(input) {
						calls.push(input);
						return Promise.resolve(summary);
					}
				}
			})
		);

		expect(calls).toStrictEqual([{ cacheName: 'builds', kind: 'clear-grace' }]);
	});
});

describe('runCacheRemove', () => {
	it('removes the cache with the force flag once confirmed', async () => {
		const calls: Parameters<CacheClient['remove']>[0][] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response = cacheRemoveResponseSchema.parse({
			scope: { kind: 'named', name: 'builds' },
			removed: true,
			storePathsRemoved: 5
		});

		await runCacheRemove(
			cacheName('builds'),
			true,
			ui,
			cacheClient({
				remove(input) {
					calls.push(input);
					return Promise.resolve(response);
				}
			})
		);

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ params: { cacheName: 'builds' }, query: { force: true } }],
			results: [
				{
					kind: 'cache',
					data: response,
					rows: [
						{ label: 'Cache', value: 'builds' },
						{ label: 'Removed', value: 'yes' },
						{ label: 'Store paths removed', value: '5' }
					]
				}
			]
		});
	});

	it('leaves the cache in place when the confirmation is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runCacheRemove(cacheName('builds'), false, ui, cacheClient({}));

		expect({
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			results: [],
			cancellations: ['The cache was left in place.']
		});
	});
});

describe('runCacheInspect', () => {
	it('reports the summary of a named cache', async () => {
		const results: ResultRow[][] = [];
		const summary = cacheSummary({
			scope: { kind: 'named', name: 'builds' },
			access: 'public',
			priority: 30,
			storePaths: 5,
			defaultRootTtl: { kind: 'duration', ttlSeconds: 1_209_600 },
			grace: { kind: 'duration', graceSeconds: 86_400 },
			rootTtlOverrides: [
				{ rootPrefix: 'github:acme/', ttlSeconds: 604_800 },
				{ rootPrefix: 'release:', ttlSeconds: 2_592_000 }
			]
		});

		await runCacheInspect(
			{ kind: 'named', name: cacheName('builds') },
			reporter(results),
			{
				get: {
					inDefaultCache: () => Promise.resolve(summary),
					inNamedCache: () => Promise.resolve(summary)
				}
			}
		);

		expect(results).toStrictEqual([
			[
				{ label: 'Cache', value: 'builds' },
				{ label: 'Access', value: 'public' },
				{ label: 'Priority', value: '30' },
				{ label: 'Store paths', value: '5' },
				{ label: 'Default root TTL', value: '1,209,600s' },
				{ label: 'Grace', value: '86,400s' },
				{
					label: 'Root TTL overrides',
					value: 'github:acme/ = 604,800s; release: = 2,592,000s'
				}
			]
		]);
	});

	it('reports the grace state when the server provides it', async () => {
		const results: ResultRow[][] = [];
		const summary = cacheSummary({
			scope: { kind: 'named', name: 'builds' },
			access: 'private',
			priority: 30,
			storePaths: 5,
			graceManaged: true,
			earliestGraceDeadline: '2026-03-01T00:00:00.000Z'
		});

		await runCacheInspect(
			{ kind: 'named', name: cacheName('builds') },
			reporter(results),
			{
				get: {
					inDefaultCache: () => Promise.resolve(summary),
					inNamedCache: () => Promise.resolve(summary)
				}
			}
		);

		expect(results).toStrictEqual([
			[
				{ label: 'Cache', value: 'builds' },
				{ label: 'Access', value: 'private' },
				{ label: 'Priority', value: '30' },
				{ label: 'Store paths', value: '5' },
				{ label: 'Default root TTL', value: 'permanent' },
				{ label: 'Grace', value: 'none' },
				{ label: 'Root TTL overrides', value: 'none' },
				{ label: 'Grace managed', value: 'yes' },
				{
					label: 'Earliest grace deadline',
					value: '2026-03-01 00:00 UTC'
				}
			]
		]);
	});

	it('reports an info line when the cache does not exist', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runCacheInspect(
			{ kind: 'named', name: cacheName('missing') },
			reporter(results, infos),
			{
				get: {
					inDefaultCache: () =>
						Promise.reject(new ORPCError('NOT_FOUND', { status: 404 })),
					inNamedCache: () =>
						Promise.reject(new ORPCError('NOT_FOUND', { status: 404 }))
				}
			}
		);

		expect({ results, infos }).toStrictEqual({
			results: [],
			infos: ['No cache named missing.']
		});
	});
});
