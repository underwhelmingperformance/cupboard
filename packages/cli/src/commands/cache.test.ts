import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import {
	type CacheName,
	cacheNameSchema,
	cachePrioritySchema
} from '@cupboard/nix-store/scalars';
import {
	cacheListResponseSchema,
	cacheRemoveResponseSchema,
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
	runCacheCreate,
	runCacheInspect,
	runCacheList,
	runCacheRemove,
	runCacheSetAccess,
	runCacheSetPriority
} from './cache.ts';

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
					cacheSummarySchema.parse({
						scope: { kind: 'default' },
						access,
						priority,
						storePaths: 0
					})
				),
			inNamedCache: ({ cacheName, access, priority }) =>
				Promise.resolve(
					cacheSummarySchema.parse({
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
					cacheSummarySchema.parse({
						scope: { kind: 'default' },
						access: input.kind === 'access' ? input.access : 'public',
						priority: input.kind === 'priority' ? input.priority : 40,
						storePaths: 0
					})
				),
			inNamedCache: (input) =>
				Promise.resolve(
					cacheSummarySchema.parse({
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
		const response = cacheListResponseSchema.parse({
			caches: [
				{
					scope: { kind: 'default' },
					access: 'private',
					priority: 40,
					storePaths: 0,
					graceManaged: false
				},
				{
					scope: { kind: 'named', name: 'builds' },
					access: 'public',
					priority: 30,
					storePaths: 5,
					graceManaged: true,
					earliestGraceDeadline: '2026-03-01T00:00:00.000Z'
				},
				{
					scope: { kind: 'named', name: 'drained' },
					access: 'private',
					priority: 45,
					storePaths: 0,
					graceManaged: true
				}
			]
		});

		await runCacheList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{ label: '(default)', value: 'private; priority 40; 0 path(s)' },
				{
					label: 'builds',
					value:
						'public; priority 30; 5 path(s); grace-managed; earliest deadline 2026-03-01 00:00 UTC'
				},
				{
					label: 'drained',
					value: 'private; priority 45; 0 path(s); grace-managed'
				}
			]
		]);
	});

	it('lists access independently from the cache name', async () => {
		const results: ResultRow[][] = [];
		const response = cacheListResponseSchema.parse({
			caches: [
				{
					scope: { kind: 'named', name: 'release' },
					access: 'private',
					priority: 30,
					storePaths: 5
				},
				{
					scope: { kind: 'named', name: 'builds' },
					access: 'public',
					priority: 40,
					storePaths: 1
				}
			]
		});

		await runCacheList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{ label: 'release', value: 'private; priority 30; 5 path(s)' },
				{ label: 'builds', value: 'public; priority 40; 1 path(s)' }
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
		const calls: { cacheName: string; priority: number }[] = [];
		const results: ResultRow[][] = [];
		const summary = cacheSummarySchema.parse({
			scope: { kind: 'named', name: 'builds' },
			access: 'private',
			priority: 30,
			storePaths: 0
		});

		await runCacheCreate(
			{ kind: 'named', name: cacheName('builds') },
			'private',
			cachePrioritySchema.parse(30),
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
			calls: [{ cacheName: 'builds', access: 'private', priority: 30 }],
			results: [
				[
					{ label: 'Cache', value: 'builds' },
					{ label: 'Access', value: 'private' },
					{ label: 'Priority', value: '30' },
					{ label: 'Store paths', value: '0' }
				]
			]
		});
	});
});

describe('cache property updates', () => {
	it('sets only the selected cache access property', async () => {
		const calls: unknown[] = [];
		const summary = cacheSummarySchema.parse({
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
		const summary = cacheSummarySchema.parse({
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
		const summary = cacheSummarySchema.parse({
			scope: { kind: 'named', name: 'builds' },
			access: 'public',
			priority: 30,
			storePaths: 5
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
				{ label: 'Store paths', value: '5' }
			]
		]);
	});

	it('reports the grace state when the server provides it', async () => {
		const results: ResultRow[][] = [];
		const summary = cacheSummarySchema.parse({
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
