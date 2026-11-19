import { startCapture } from '@cupboard/logger/testing';
import {
	type CacheScope,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	buildInputsClearMaxPaths,
	buildInputsClearResponseSchema,
	buildInputsMaxLength,
	buildInputsReadResponseSchema
} from '@cupboard/protocol/build-inputs';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	currentServer,
	defaultCache,
	initialise,
	issueServerSignedToken,
	namedCache,
	putTestCache,
	resetTestServer,
	resolvedCache,
	syntheticStorePathHash,
	withoutAlarmArming
} from '../test-support.ts';

import { buildInputColumns, unrecorded } from './build-inputs.test-support.ts';
import {
	collectionState,
	collectTenant,
	insertNarInfo,
	insertRoot,
	storePathBasename,
	useMinScanInterval
} from './garbage-collection.test-support.ts';
import { GarbageCollectionInputs } from './garbage-collection-inputs.ts';
import { noCost } from './operation-cost.test-support.ts';
import { type OperationCostRecord } from './operation-cost.ts';

const target = syntheticStorePathHash(1);
const other = syntheticStorePathHash(2);
const input = syntheticStorePathHash(3);
const missing = syntheticStorePathHash(4);

const stored = {
	buildInputsJson: JSON.stringify([storePathBasename(input)]),
	buildInputsVersion: 2
};

function cachePath(cache: CacheScope): string {
	return cache.kind === 'default' ? '' : `/cache/${cache.name}`;
}

function clearRequest(
	token: string,
	storePathHashes: readonly StorePathHash[],
	cache: CacheScope = defaultCache()
): Promise<Response> {
	return authorisedFetch(`${cachePath(cache)}/build-inputs/clear`, token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ storePathHashes })
	});
}

async function clear(
	token: string,
	storePathHashes: readonly StorePathHash[],
	cache: CacheScope = defaultCache()
) {
	const response = await clearRequest(token, storePathHashes, cache);

	expect(response.status, await response.clone().text()).toBe(StatusCodes.OK);

	return buildInputsClearResponseSchema.parse(await response.json());
}

function readRequest(
	token: string,
	storePathHash: StorePathHash
): Promise<Response> {
	return authorisedFetch(`/build-inputs/${storePathHash}`, token);
}

// Inserts rows for `storePathHashes` in a cache, and stores build inputs on
// the rows of `withBuildInputs`.
async function insertRows(
	cache: CacheScope,
	storePathHashes: readonly StorePathHash[],
	withBuildInputs: readonly StorePathHash[]
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (const [index, storePathHash] of storePathHashes.entries()) {
			insertNarInfo(instance.context, storePathHash, index + 1, cache);
		}
		for (const storePathHash of withBuildInputs) {
			instance.context.db
				.update(schema.narInfos)
				.set(stored)
				.where(eq(schema.narInfos.storePathHash, storePathHash))
				.run();
		}
	});
}

const costLineSchema = z.object({
	path: z.string(),
	rowsRead: z.number(),
	rowsWritten: z.number(),
	d1Calls: z.number(),
	d1RowsRead: z.number(),
	d1RowsWritten: z.number(),
	d1CallsWithoutRows: z.number(),
	r2Head: z.number(),
	r2Get: z.number(),
	r2Put: z.number(),
	r2Delete: z.number(),
	r2List: z.number()
});

// The cost of the clear request that `run` sends.
async function clearCost(
	run: () => Promise<void>
): Promise<OperationCostRecord> {
	const capture = startCapture();

	try {
		await run();
	} finally {
		capture.stop();
	}

	const [line, ...rest] = capture.logs
		.filter((log) => log.message === 'request finished')
		.map((log) => costLineSchema.parse(log.properties))
		.filter((parsed) => parsed.path === '/build-inputs/clear');

	expect(rest).toStrictEqual([]);

	if (line === undefined) {
		throw new Error('Expected the cost of a clear request');
	}

	const { path: _path, ...cost } = line;

	return cost;
}

describe('clearing build inputs', () => {
	beforeEach(resetTestServer);

	it.each([
		{ cacheName: 'the default cache', cache: defaultCache() },
		{ cacheName: 'a named cache', cache: namedCache('builds') }
	])(
		'reports each path of a page in $cacheName and clears those with build inputs',
		async ({ cache }) => {
			const token = await initialise();
			if (cache.kind === 'named') {
				await putTestCache(token, cache);
			}
			await insertRows(cache, [target, other], [target]);

			const response = await clear(token, [target, other, missing], cache);

			expect({
				response,
				target: await buildInputColumns(target, cache),
				other: await buildInputColumns(other, cache)
			}).toStrictEqual({
				response: {
					entries: [
						{ storePathHash: target, status: 'cleared' },
						{ storePathHash: other, status: 'unchanged' },
						{ storePathHash: missing, status: 'absent' }
					]
				},
				target: unrecorded,
				other: unrecorded
			});
		}
	);

	it('reports every path of a removed cache as absent and writes nothing', async () => {
		const token = await initialise();
		const builds = namedCache('builds');
		await putTestCache(token, builds);
		await insertRows(builds, [target], [target]);
		const removed = await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context, builds);
			instance.context.db
				.update(schema.cacheIdentities)
				.set({ deletedAt: isoTimestamp(new Date()) })
				.where(eq(schema.cacheIdentities.id, cache.id))
				.run();

			return cache.id;
		});

		const response = await clear(token, [target], builds);

		expect({
			response,
			columns: await buildInputColumns(target, removed)
		}).toStrictEqual({
			response: { entries: [{ storePathHash: target, status: 'absent' }] },
			columns: stored
		});
	});

	it('refuses a page with more paths than one request may clear', async () => {
		const token = await initialise();

		const response = await clearRequest(
			token,
			Array.from({ length: buildInputsClearMaxPaths + 1 }, (_, index) =>
				syntheticStorePathHash(10 + index)
			)
		);
		await response.body?.cancel();

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
	});

	it.each([
		{
			holder: 'a token with the narinfo:delete grant',
			actions: ['narinfo:delete'],
			status: StatusCodes.OK,
			columns: unrecorded
		},
		{
			holder: 'a token with only the build-inputs:record grant',
			actions: ['build-inputs:record'],
			status: StatusCodes.FORBIDDEN,
			columns: stored
		}
	])('answers $status to $holder', async ({ actions, status, columns }) => {
		await initialise();
		await insertRows(defaultCache(), [target], [target]);
		const token = await issueServerSignedToken(
			authorizationDetailsSchema.parse([
				{ type: 'cupboard_cache', actions, cache: defaultCache() }
			])
		);

		const response = await clearRequest(token, [target]);
		await response.body?.cancel();

		expect({
			status: response.status,
			columns: await buildInputColumns(target)
		}).toStrictEqual({ status, columns });
	});

	it('makes a scan due that collects a path kept only by the cleared build inputs', async () =>
		withoutAlarmArming(async () => {
			const token = await initialise();
			await useMinScanInterval(0);
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, target, 1, undefined, {
					buildInputs: [input]
				});
				insertNarInfo(instance.context, input, 2);
				insertRoot(instance.context, { name: 'channel', target });
			});
			await collectTenant();
			const decision = () =>
				runInDurableObject(currentServer(), (instance) =>
					new GarbageCollectionInputs(instance.context).scanDecision(
						resolvedCache(instance.context),
						isoTimestamp(new Date())
					)
				);
			const beforeClear = await decision();

			await clear(token, [target]);
			const afterClear = await decision();
			await collectTenant();

			expect({
				beforeClear,
				afterClear,
				collected: await runInDurableObject(currentServer(), (instance) =>
					collectionState(instance.context)
				)
			}).toStrictEqual({
				beforeClear: 'current',
				afterClear: 'due',
				collected: {
					narInfos: [target],
					roots: ['channel'],
					inputs: {
						inputsChanged: false,
						scanCompletedAt: isoTimestamp(new Date())
					}
				}
			});
		}));

	it('writes the collection input only when it was not already changed', async () => {
		const token = await initialise();
		await insertRows(defaultCache(), [target, other], [target, other]);
		await runInDurableObject(currentServer(), (instance) => {
			new GarbageCollectionInputs(instance.context).clearChanged(
				resolvedCache(instance.context)
			);
		});

		const first = await clearCost(async () => {
			await clear(token, [target]);
		});
		const second = await clearCost(async () => {
			await clear(token, [other]);
		});

		expect({ first, second }).toStrictEqual({
			first: {
				...noCost,
				rowsRead: 41,
				rowsWritten: 3,
				d1Calls: 1,
				d1RowsRead: 1,
				d1RowsWritten: 2
			},
			second: {
				...noCost,
				rowsRead: 41,
				rowsWritten: 1,
				d1Calls: 1,
				d1RowsRead: 1
			}
		});
	});
});

describe('reading build inputs', () => {
	beforeEach(resetTestServer);

	it.each([
		{
			row: 'a row with build inputs',
			path: target,
			set: stored,
			expected: {
				storePathHash: target,
				status: 'recorded',
				buildInputs: [storePathBasename(input)],
				buildInputsVersion: 2
			}
		},
		{
			row: 'a row without build inputs',
			path: target,
			set: undefined,
			expected: { storePathHash: target, status: 'none' }
		},
		{
			row: 'a row whose build inputs cannot be read',
			path: target,
			set: { buildInputsJson: '{"not":"a list"}', buildInputsVersion: 1 },
			expected: { storePathHash: target, status: 'invalid-stored' }
		},
		{
			row: 'a row with a version but no build inputs',
			path: target,
			set: { buildInputsVersion: 1 },
			expected: { storePathHash: target, status: 'invalid-stored' }
		},
		{
			row: 'a row with build inputs but no version',
			path: target,
			set: { buildInputsJson: JSON.stringify([storePathBasename(input)]) },
			expected: { storePathHash: target, status: 'invalid-stored' }
		},
		{
			row: 'a row with more build inputs than a row can have',
			path: target,
			set: {
				buildInputsJson: JSON.stringify(
					Array.from({ length: buildInputsMaxLength + 1 }, (_, index) =>
						storePathBasename(syntheticStorePathHash(1000 + index))
					)
				),
				buildInputsVersion: 1
			},
			expected: { storePathHash: target, status: 'invalid-stored' }
		},
		{
			row: 'no row',
			path: missing,
			set: undefined,
			expected: { storePathHash: missing, status: 'absent' }
		}
	])('reports $row', async ({ path, set, expected }) => {
		const token = await initialise();
		await insertRows(defaultCache(), [target], []);
		if (set !== undefined) {
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.update(schema.narInfos)
					.set(set)
					.where(eq(schema.narInfos.storePathHash, target))
					.run();
			});
		}

		const response = await readRequest(token, path);

		expect({
			status: response.status,
			body: buildInputsReadResponseSchema.parse(await response.json())
		}).toStrictEqual({ status: StatusCodes.OK, body: expected });
	});

	it.each([
		{
			holder: 'a token with the cache:content-read grant',
			actions: ['cache:content-read'],
			status: StatusCodes.OK
		},
		{
			holder: 'a token with only the build-inputs:record grant',
			actions: ['build-inputs:record'],
			status: StatusCodes.FORBIDDEN
		}
	])('answers $status to $holder', async ({ actions, status }) => {
		await initialise();
		await insertRows(defaultCache(), [target], [target]);
		const token = await issueServerSignedToken(
			authorizationDetailsSchema.parse([
				{ type: 'cupboard_cache', actions, cache: defaultCache() }
			])
		);

		const response = await readRequest(token, target);
		await response.body?.cancel();

		expect(response.status).toBe(status);
	});
});
