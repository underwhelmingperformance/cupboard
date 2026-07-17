import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import type {
	CacheListResponse,
	CacheRemoveResponse,
	CacheSummary
} from '@cupboard/protocol/caches';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	type CacheClient,
	runCacheCreate,
	runCacheInspect,
	runCacheList,
	runCacheRemove
} from './cache.ts';

function cacheClient(overrides: Partial<CacheClient>): CacheClient {
	return {
		list: () => Promise.resolve({ caches: [] }),
		put: ({ cacheName, priority }) =>
			Promise.resolve({ name: cacheName, priority, storePaths: 0 }),
		remove: ({ params }) =>
			Promise.resolve({
				name: params.cacheName,
				removed: false,
				storePathsRemoved: 0
			}),
		...overrides
	};
}

describe('runCacheList', () => {
	it('reports a row per cache, labelling the default and its grace state', async () => {
		const results: ResultRow[][] = [];
		const response: CacheListResponse = {
			caches: [
				{ name: '', priority: 40, storePaths: 0, graceManaged: false },
				{
					name: 'builds',
					priority: 30,
					storePaths: 5,
					graceManaged: true,
					earliestGraceDeadline: '2026-03-01T00:00:00.000Z'
				},
				{ name: 'drained', priority: 45, storePaths: 0, graceManaged: true }
			]
		};

		await runCacheList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{ label: '(default)', value: 'priority 40; 0 path(s)' },
				{
					label: 'builds',
					value:
						'priority 30; 5 path(s); grace-managed; earliest deadline 2026-03-01 00:00 UTC'
				},
				{ label: 'drained', value: 'priority 45; 0 path(s); grace-managed' }
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
	it('upserts the cache priority and reports the summary', async () => {
		const calls: { cacheName: string; priority: number }[] = [];
		const results: ResultRow[][] = [];
		const summary: CacheSummary = {
			name: 'builds',
			priority: 30,
			storePaths: 0
		};

		await runCacheCreate('builds', 30, reporter(results), {
			put(input) {
				calls.push(input);
				return Promise.resolve(summary);
			}
		});

		expect({ calls, results }).toStrictEqual({
			calls: [{ cacheName: 'builds', priority: 30 }],
			results: [
				[
					{ label: 'Cache', value: 'builds' },
					{ label: 'Priority', value: '30' },
					{ label: 'Store paths', value: '0' }
				]
			]
		});
	});
});

describe('runCacheRemove', () => {
	it('removes the cache with the force flag once confirmed', async () => {
		const calls: Parameters<CacheClient['remove']>[0][] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response: CacheRemoveResponse = {
			name: 'builds',
			removed: true,
			storePathsRemoved: 5
		};

		await runCacheRemove(
			'builds',
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

		await runCacheRemove('builds', false, ui, cacheClient({}));

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

		await runCacheInspect('builds', reporter(results), {
			list: () =>
				Promise.resolve({
					caches: [{ name: 'builds', priority: 30, storePaths: 5 }]
				})
		});

		expect(results).toStrictEqual([
			[
				{ label: 'Cache', value: 'builds' },
				{ label: 'Priority', value: '30' },
				{ label: 'Store paths', value: '5' }
			]
		]);
	});

	it('reports the grace state when the server provides it', async () => {
		const results: ResultRow[][] = [];

		await runCacheInspect('builds', reporter(results), {
			list: () =>
				Promise.resolve({
					caches: [
						{
							name: 'builds',
							priority: 30,
							storePaths: 5,
							graceManaged: true,
							earliestGraceDeadline: '2026-03-01T00:00:00.000Z'
						}
					]
				})
		});

		expect(results).toStrictEqual([
			[
				{ label: 'Cache', value: 'builds' },
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

		await runCacheInspect('missing', reporter(results, infos), {
			list: () => Promise.resolve({ caches: [] })
		});

		expect({ results, infos }).toStrictEqual({
			results: [],
			infos: ['No cache named missing.']
		});
	});
});
