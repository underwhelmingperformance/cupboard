import { startCapture } from '@cupboard/logger/testing';
import { type CacheScope, rootNameSchema } from '@cupboard/nix-store/scalars';
import {
	rootBatchCapacity,
	rootBatchLimitErrorCode,
	rootBatchResponseSchema,
	rootEnsureResponseSchema,
	type RootRetentionRequest
} from '@cupboard/protocol/retention';
import { type UploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	cacheWriteGrants,
	currentServer,
	defaultCache,
	initialise,
	issueServerSignedToken,
	namedCache,
	narBytes,
	pushSharedNarPaths,
	putTestCache,
	resetTestServer,
	resolvedCache,
	syntheticStorePathHash,
	testBase,
	uploadMetadata
} from '../test-support.ts';

import { type ServerContext } from './context.ts';
import { noCost } from './operation-cost.test-support.ts';
import { type OperationCostRecord } from './operation-cost.ts';

const hourInSeconds = 3600;
const retention = { kind: 'duration', seconds: hourInSeconds } as const;
const fiveMinutesLater = new Date(testBase.getTime() + 5 * 60 * 1000);

function targetPath(index: number): UploadPathMetadata {
	return uploadMetadata({
		fileSize: narBytes.byteLength,
		storePathHash: syntheticStorePathHash(index),
		name: `target-${String(index)}`
	});
}

const batchLimitError = {
	defined: true,
	code: rootBatchLimitErrorCode,
	status: StatusCodes.REQUEST_TOO_LONG,
	data: { capacity: rootBatchCapacity }
};

async function readErrorBody(response: Response): Promise<unknown> {
	const { defined, code, status, data } = z
		.object({
			defined: z.boolean(),
			code: z.string(),
			status: z.number(),
			data: z.unknown()
		})
		.parse(await response.json());

	return { defined, code, status, data };
}

const served = targetPath(0);
const missing = targetPath(1);

// Each statement records every insert into and delete from the target table, so
// a test can tell an unchanged target set from one that was rewritten.
const targetWriteLog = [
	'CREATE TABLE test_root_target_write (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL)',
	"CREATE TRIGGER test_root_target_insert AFTER INSERT ON retention_root_target BEGIN INSERT INTO test_root_target_write (kind) VALUES ('insert'); END",
	"CREATE TRIGGER test_root_target_delete AFTER DELETE ON retention_root_target BEGIN INSERT INTO test_root_target_write (kind) VALUES ('delete'); END"
];

interface Entry {
	readonly action: 'set' | 'ensure';
	readonly name: string;
	readonly targets: readonly string[];
	readonly retention?: RootRetentionRequest;
}

function cachePath(cache: CacheScope): string {
	return cache.kind === 'default'
		? ''
		: `/cache/${encodeURIComponent(cache.name)}`;
}

function batchRequest(
	token: string,
	roots: readonly Entry[],
	cache: CacheScope = defaultCache()
): Promise<Response> {
	return authorisedFetch(`${cachePath(cache)}/roots/batch`, token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			roots: roots.map((entry) => ({ retention, ...entry }))
		})
	});
}

async function sendBatch(token: string, roots: readonly Entry[]) {
	const response = await batchRequest(token, roots);

	expect(response.status).toBe(StatusCodes.OK);

	return rootBatchResponseSchema.parse(await response.json());
}

function singleRequest(token: string, entry: Entry): Promise<Response> {
	const path = `/roots/${encodeURIComponent(entry.name)}`;

	return authorisedFetch(
		entry.action === 'set' ? path : `${path}/ensure`,
		token,
		{
			method: entry.action === 'set' ? 'PUT' : 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ targets: entry.targets, retention })
		}
	);
}

// The stored root and target rows of one root. The rows report the name
// `compared`, so the rows of two roots compare equal when only their names
// differ.
// Two roots have different incarnations, so the comparison records only
// whether a root has one and whether its targets have the same one.
function storedRoot(context: ServerContext, name: string) {
	const cacheId = resolvedCache(context).id;
	const storedName = rootNameSchema.parse('compared');
	const roots = context.db
		.select()
		.from(schema.retentionRoots)
		.where(eq(schema.retentionRoots.cacheId, cacheId))
		.all()
		.filter((root) => root.name === name);
	const incarnation = roots[0]?.incarnation;

	return {
		roots: roots.map(({ incarnation: rootIncarnation, ...root }) => ({
			...root,
			name: storedName,
			hasIncarnation: rootIncarnation !== null
		})),
		targets: context.db
			.select()
			.from(schema.retentionRootTargets)
			.where(eq(schema.retentionRootTargets.cacheId, cacheId))
			.all()
			.filter((target) => target.rootName === name)
			.map(({ incarnation: targetIncarnation, ...target }) => ({
				...target,
				rootName: storedName,
				isKept: targetIncarnation === incarnation
			}))
	};
}

function rootNames(
	context: ServerContext,
	cache: CacheScope = defaultCache()
): string[] {
	const cacheId = context.cacheRepository.resolve(cache)?.id;

	if (cacheId === undefined) {
		return [];
	}

	return context.db
		.select({ name: schema.retentionRoots.name })
		.from(schema.retentionRoots)
		.where(eq(schema.retentionRoots.cacheId, cacheId))
		.orderBy(schema.retentionRoots.name)
		.all()
		.map((row) => row.name);
}

function rootSummary(name: string, targets: readonly UploadPathMetadata[]) {
	return {
		name,
		expiresAt: new Date(
			testBase.getTime() + hourInSeconds * 1000
		).toISOString(),
		expired: false,
		createdAt: testBase.toISOString(),
		updatedAt: testBase.toISOString(),
		targets: targets.map((target) => ({
			storePathHash: target.storePathHash,
			storePath: target.storePath,
			present: true
		}))
	};
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

// Adds up the cost of every root request that `run` sends.
async function rootRequestCost(
	run: () => Promise<void>
): Promise<OperationCostRecord> {
	const capture = startCapture();

	try {
		await run();
	} finally {
		capture.stop();
	}

	const lines = capture.logs
		.filter((entry) => entry.message === 'request finished')
		.map((entry) => costLineSchema.parse(entry.properties))
		.filter((line) => line.path.startsWith('/roots/'));
	let total = noCost;

	for (const line of lines) {
		total = {
			rowsRead: total.rowsRead + line.rowsRead,
			rowsWritten: total.rowsWritten + line.rowsWritten,
			d1Calls: total.d1Calls + line.d1Calls,
			d1RowsRead: total.d1RowsRead + line.d1RowsRead,
			d1RowsWritten: total.d1RowsWritten + line.d1RowsWritten,
			d1CallsWithoutRows: total.d1CallsWithoutRows + line.d1CallsWithoutRows,
			r2Head: total.r2Head + line.r2Head,
			r2Get: total.r2Get + line.r2Get,
			r2Put: total.r2Put + line.r2Put,
			r2Delete: total.r2Delete + line.r2Delete,
			r2List: total.r2List + line.r2List
		};
	}

	return total;
}

// Returns the target writes recorded since the previous call.
async function takeTargetWrites(): Promise<string[]> {
	return runInDurableObject(currentServer(), (_instance, state) => {
		const kinds = Array.from(
			state.storage.sql.exec<{ kind: string }>(
				'SELECT kind FROM test_root_target_write ORDER BY seq'
			),
			(row) => row.kind
		);
		state.storage.sql.exec('DELETE FROM test_root_target_write');

		return kinds;
	});
}

async function measure(send: () => Promise<void>) {
	return {
		cost: await rootRequestCost(send),
		targetWrites: await takeTargetWrites()
	};
}

describe('batched root requests', () => {
	beforeEach(resetTestServer);

	it.each([
		{
			name: 'ensures a served target',
			action: 'ensure',
			targets: [served],
			singleStatus: StatusCodes.OK,
			result: (root: string) => ({
				name: root,
				status: 'retained',
				root: rootSummary(root, [served])
			})
		},
		{
			name: 'ensures a target that the cache cannot serve',
			action: 'ensure',
			targets: [missing],
			singleStatus: StatusCodes.OK,
			result: (root: string) => ({
				name: root,
				status: 'build-required',
				unavailable: [missing.storePath]
			})
		},
		{
			name: 'sets a served target',
			action: 'set',
			targets: [served],
			singleStatus: StatusCodes.OK,
			result: (root: string) => ({
				name: root,
				status: 'retained',
				root: rootSummary(root, [served])
			})
		},
		{
			name: 'sets a target without a committed narinfo',
			action: 'set',
			targets: [missing],
			singleStatus: StatusCodes.CONFLICT,
			result: (root: string) => ({
				name: root,
				status: 'targets-unavailable',
				unavailable: [missing.storePath]
			})
		},
		{
			name: 'sets an empty target list',
			action: 'set',
			targets: [],
			singleStatus: StatusCodes.OK,
			result: (root: string) => ({
				name: root,
				status: 'retained',
				root: rootSummary(root, [])
			})
		}
	] as const)(
		'$name and stores what the single request stores',
		async ({ action, targets, singleStatus, result }) => {
			const token = await initialise();
			await pushSharedNarPaths(token, [served]);
			const storePaths = targets.map((target) => target.storePath);

			const single = await singleRequest(token, {
				action,
				name: 'single',
				targets: storePaths
			});
			await single.text();
			const batch = await sendBatch(token, [
				{ action, name: 'batched', targets: storePaths }
			]);
			const stored = await runInDurableObject(currentServer(), (instance) => ({
				single: storedRoot(instance.context, 'single'),
				batched: storedRoot(instance.context, 'batched')
			}));

			expect({
				singleStatus: single.status,
				batch,
				stored: stored.batched
			}).toStrictEqual({
				singleStatus,
				batch: { roots: [result('batched')] },
				stored: stored.single
			});
		}
	);

	it.each(
		[defaultCache(), namedCache('builds')].flatMap((cache) =>
			[
				{
					name: 'sets every root when the grant covers all of them',
					roots: ['main/a', 'main/b'],
					status: StatusCodes.OK,
					stored: ['main/a', 'main/b']
				},
				{
					name: 'refuses the whole batch when one root is outside the grant',
					roots: ['main/a', 'other'],
					status: StatusCodes.FORBIDDEN,
					stored: []
				}
			].map((batch) => ({ ...batch, cache, cacheKind: cache.kind }))
		)
	)(
		'$name in the $cacheKind cache',
		async ({ cache, roots, status, stored }) => {
			const adminToken = await initialise();
			await putTestCache(adminToken, cache);
			const token = await issueServerSignedToken(
				cacheWriteGrants(['main/'], cache)
			);

			const response = await batchRequest(
				token,
				roots.map((name) => ({ action: 'set', name, targets: [] })),
				cache
			);
			await response.text();
			const names = await runInDurableObject(currentServer(), (instance) =>
				rootNames(instance.context, cache)
			);

			expect({ status: response.status, names }).toStrictEqual({
				status,
				names: stored
			});
		}
	);

	// The targets are committed, so the probe heads each narinfo object and NAR
	// as it would for a real batch.
	it.each([
		{
			name: 'sets every root of a batch at the capacity',
			targetCount: rootBatchCapacity - 2,
			emptyCount: 2,
			status: StatusCodes.OK,
			read: async (response: Response) =>
				rootBatchResponseSchema
					.parse(await response.json())
					.roots.map(({ name, status }) => ({ name, status })),
			body: [
				{ name: 'first', status: 'retained' },
				{ name: 'second', status: 'retained' },
				{ name: 'empty-0', status: 'retained' },
				{ name: 'empty-1', status: 'retained' }
			],
			names: ['empty-0', 'empty-1', 'first', 'second']
		},
		{
			name: 'refuses a batch of targets over the capacity before it writes',
			targetCount: rootBatchCapacity + 1,
			emptyCount: 0,
			status: StatusCodes.REQUEST_TOO_LONG,
			read: readErrorBody,
			body: batchLimitError,
			names: []
		}
	])(
		'$name',
		async ({ targetCount, emptyCount, status, read, body, names: stored }) => {
			const token = await initialise();
			const paths = Array.from({ length: targetCount }, (_, index) =>
				targetPath(index + 10)
			);
			await pushSharedNarPaths(token, paths);
			const storePaths = paths.map((path) => path.storePath);
			const half = Math.ceil(targetCount / 2);
			const empty = Array.from({ length: emptyCount }, (_, index): Entry => ({
				action: 'set',
				name: `empty-${String(index)}`,
				targets: []
			}));

			const response = await batchRequest(token, [
				{ action: 'set', name: 'first', targets: storePaths.slice(0, half) },
				{ action: 'set', name: 'second', targets: storePaths.slice(half) },
				...empty
			]);
			const received = await read(response);
			const names = await runInDurableObject(currentServer(), (instance) =>
				rootNames(instance.context)
			);

			expect({ status: response.status, body: received, names }).toStrictEqual({
				status,
				body,
				names: stored
			});
		}
	);

	it('refuses a batch of empty entries over the capacity before it writes', async () => {
		const token = await initialise();

		const response = await batchRequest(
			token,
			Array.from({ length: rootBatchCapacity + 1 }, (_, index) => ({
				action: 'set',
				name: `root-${String(index)}`,
				targets: []
			}))
		);
		const body = await readErrorBody(response);
		const names = await runInDurableObject(currentServer(), (instance) =>
			rootNames(instance.context)
		);

		expect({ status: response.status, body, names }).toStrictEqual({
			status: StatusCodes.REQUEST_TOO_LONG,
			body: batchLimitError,
			names: []
		});
	});

	it('costs less than a request per root and rewrites no targets of unchanged roots', async () => {
		const token = await initialise();
		const paths = [targetPath(0), targetPath(1), targetPath(2)];
		await pushSharedNarPaths(token, paths);
		await runInDurableObject(currentServer(), (_instance, state) => {
			for (const statement of targetWriteLog) {
				state.storage.sql.exec(statement);
			}
		});
		const entries = (prefix: string): Entry[] =>
			paths.map((path, index) => ({
				action: 'ensure',
				name: `${prefix}-${String(index)}`,
				targets: [path.storePath]
			}));

		const sendSingles = async () => {
			for (const entry of entries('single')) {
				const response = await singleRequest(token, entry);
				rootEnsureResponseSchema.parse(await response.json());
			}
		};
		const sendBatched = async () => {
			await sendBatch(token, entries('batched'));
		};
		const created = {
			singles: await measure(sendSingles),
			batch: await measure(sendBatched)
		};

		vi.setSystemTime(fiveMinutesLater);

		const unchanged = {
			singles: await measure(sendSingles),
			batch: await measure(sendBatched)
		};
		const refreshed = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({
					name: schema.retentionRoots.name,
					expiresAt: schema.retentionRoots.expiresAt,
					updatedAt: schema.retentionRoots.updatedAt
				})
				.from(schema.retentionRoots)
				.orderBy(schema.retentionRoots.name)
				.all()
		);

		// The three paths share one NAR, so the batch's single probe heads it once.
		// The first request after the clock moves publishes a new maintenance wake
		// to D1, so the unchanged singles, which run first, write its two rows.
		expect({ created, unchanged, refreshed }).toStrictEqual({
			created: {
				singles: {
					cost: {
						...noCost,
						rowsRead: 162,
						rowsWritten: 33,
						d1Calls: 9,
						d1RowsRead: 23,
						r2Head: 6
					},
					targetWrites: ['insert', 'insert', 'insert']
				},
				batch: {
					cost: {
						...noCost,
						rowsRead: 90,
						rowsWritten: 33,
						d1Calls: 3,
						d1RowsRead: 15,
						r2Head: 4
					},
					targetWrites: ['insert', 'insert', 'insert']
				}
			},
			unchanged: {
				singles: {
					cost: {
						...noCost,
						rowsRead: 159,
						rowsWritten: 9,
						d1Calls: 9,
						d1RowsRead: 23,
						d1RowsWritten: 2,
						r2Head: 6
					},
					targetWrites: []
				},
				batch: {
					cost: {
						...noCost,
						rowsRead: 86,
						rowsWritten: 9,
						d1Calls: 3,
						d1RowsRead: 15,
						r2Head: 4
					},
					targetWrites: []
				}
			},
			refreshed: ['batched', 'single'].flatMap((prefix) =>
				paths.map((_, index) => ({
					name: `${prefix}-${String(index)}`,
					expiresAt: new Date(
						fiveMinutesLater.getTime() + hourInSeconds * 1000
					).toISOString(),
					updatedAt: fiveMinutesLater.toISOString()
				}))
			)
		});
	});

	// The roots inherit their retention, so each write resolves the cache's
	// prefix overrides.
	it('reads the cache-level settings once for a batch of inheriting roots', async () => {
		const token = await initialise();
		const paths = [targetPath(0), targetPath(1), targetPath(2)];
		await pushSharedNarPaths(token, paths);

		for (const rootPrefix of ['other/', 'inherited/', 'inherited/deep/']) {
			const response = await authorisedFetch('/cache', token, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					kind: 'set-root-ttl-override',
					rootPrefix,
					retention
				})
			});

			expect(response.status).toBe(StatusCodes.OK);
		}

		const cost = await rootRequestCost(async () => {
			await sendBatch(
				token,
				paths.map((path, index) => ({
					action: 'ensure',
					name: `inherited/${String(index)}`,
					targets: [path.storePath],
					retention: { kind: 'inherit' }
				}))
			);
		});

		expect(cost).toStrictEqual({
			...noCost,
			rowsRead: 95,
			rowsWritten: 30,
			d1Calls: 3,
			d1RowsRead: 15,
			r2Head: 4
		});
	});
});
