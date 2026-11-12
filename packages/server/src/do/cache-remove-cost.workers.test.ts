import { startCapture } from '@cupboard/logger/testing';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';

import {
	deliverAlarms,
	ignoreAlarmDeliveries
} from '../alarm-fence.test-support.ts';
import {
	authorisedFetch,
	currentServer,
	initialise,
	namedCache,
	putTestCache,
	resetTestServer
} from '../test-support.ts';

import {
	markCacheRemoved,
	seedCacheRows
} from './cache-teardown.test-support.ts';

const smallPaths = 200;
const largePaths = 2000;

// D1 rows written are left out: the first request of a test writes two more
// D1 rows than a later one, whatever the size of the cache.
const requestCostSchema = z.object({
	route: z.string(),
	rowsRead: z.number(),
	rowsWritten: z.number(),
	d1Calls: z.number(),
	d1RowsRead: z.number(),
	r2Delete: z.number()
});

const bodySchema = z.union([
	z.object({
		removed: z.boolean(),
		storePathsRemoved: z.number()
	}),
	z.object({ code: z.string() })
]);

interface RemovalRequest {
	readonly name: string;
	readonly query: string;
	readonly status: StatusCodes;
	readonly body: (paths: number) => z.infer<typeof bodySchema>;
	readonly cost: z.infer<typeof requestCostSchema>;
}

const removalRequests: readonly RemovalRequest[] = [
	{
		name: 'removal with force',
		query: '?force=true',
		status: StatusCodes.OK,
		body: (paths) => ({ removed: true, storePathsRemoved: paths }),
		cost: {
			route: '/caches/{cacheName}',
			rowsRead: 26,
			rowsWritten: 3,
			d1Calls: 3,
			d1RowsRead: 3,
			r2Delete: 0
		}
	},
	{
		name: 'removal without force',
		query: '',
		status: StatusCodes.CONFLICT,
		body: () => ({ code: 'CACHE_NOT_EMPTY' }),
		cost: {
			route: '/caches/{cacheName}',
			rowsRead: 16,
			rowsWritten: 0,
			d1Calls: 1,
			d1RowsRead: 1,
			r2Delete: 0
		}
	}
];

// Seeds `builds` with `paths` paths, a live cache, and a cache that was
// removed earlier and whose rows have not been drained. Every cache has rows
// in each table that a removal empties.
async function seedTenant(token: string, paths: number): Promise<void> {
	for (const name of ['old', 'builds', 'other']) {
		await putTestCache(token, namedCache(name));
	}

	await runInDurableObject(currentServer(), async (instance, state) => {
		const seeded = [
			['old', 'd', 50],
			['builds', 'b', paths],
			['other', 'f', 20]
		] as const;

		for (const [name, prefix, count] of seeded) {
			seedCacheRows(
				instance.context,
				state.storage,
				instance.context.cacheRepository.require(namedCache(name)),
				prefix,
				count
			);
		}

		await markCacheRemoved(instance.context, state.storage, namedCache('old'));
	});
}

// Seeds a fresh tenant whose `builds` has `paths` paths, sends one removal of
// `builds` and returns its status, its body and the cost that the tenant
// object logged for it.
async function measuredRemoval(request: RemovalRequest, paths: number) {
	await resetTestServer();
	const id = currentServer().id;
	ignoreAlarmDeliveries(id);
	onTestFinished(() => {
		deliverAlarms(id);
	});
	const token = await initialise();
	await seedTenant(token, paths);
	const capture = startCapture();

	try {
		const response = await authorisedFetch(
			`/caches/builds${request.query}`,
			token,
			{ method: 'DELETE' }
		);
		const body = bodySchema.parse(await response.json());
		const costs = capture.logs
			.filter((entry) => entry.message === 'request finished')
			.map((entry) => requestCostSchema.parse(entry.properties));

		return { status: response.status, body, costs };
	} finally {
		capture.stop();
	}
}

describe('cache removal cost', () => {
	it.each(removalRequests)(
		'answers a $name without reading the paths',
		async (request) => {
			const small = await measuredRemoval(request, smallPaths);
			const large = await measuredRemoval(request, largePaths);

			expect({ small, large }).toStrictEqual({
				small: {
					status: request.status,
					body: request.body(smallPaths),
					costs: [request.cost]
				},
				large: {
					status: request.status,
					body: request.body(largePaths),
					costs: [request.cost]
				}
			});
		}
	);
});
