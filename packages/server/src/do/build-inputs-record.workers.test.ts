import { startCapture } from '@cupboard/logger/testing';
import {
	type CacheScope,
	type StorePathHash,
	storePathNameMaxLength
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	buildInputsMaxJsonBytes,
	buildInputsMaxLength,
	buildInputsPageLimitErrorCode,
	buildInputsRecordBodySchema,
	buildInputsRecordMaxBuildInputs,
	buildInputsRecordMaxEntries,
	buildInputsRecordResponseSchema,
	pathEdgesMaxJsonBytes
} from '@cupboard/protocol/build-inputs';
import {
	authorizationDetailsSchema,
	cacheOperations
} from '@cupboard/protocol/grants';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
	syntheticStorePathHash
} from '../test-support.ts';

import {
	buildInputColumns,
	storeBuildInputs,
	unrecorded
} from './build-inputs.test-support.ts';
import { BuildInputsService } from './build-inputs-service.ts';
import {
	insertNarInfo,
	storePathBasename,
	storePathString
} from './garbage-collection.test-support.ts';
import { noCost } from './operation-cost.test-support.ts';
import { type OperationCostRecord } from './operation-cost.ts';

const target = syntheticStorePathHash(1);
const other = syntheticStorePathHash(2);
const missing = syntheticStorePathHash(3);

function input(index: number): string {
	return storePathBasename(syntheticStorePathHash(1000 + index));
}

// A build input whose basename has the most characters that a basename can
// have.
function longestInput(index: number): string {
	return `${String(index).padStart(32, '0')}-${'a'.repeat(storePathNameMaxLength)}`;
}

const gcc = input(1);
const source = input(2);
const make = input(3);

interface Entry {
	readonly storePath: string;
	readonly buildInputs: readonly string[];
	readonly buildInputsVersion: number;
}

function entry(
	storePathHash: StorePathHash,
	buildInputs: readonly string[],
	buildInputsVersion = 1
): Entry {
	return {
		storePath: storePathString(storePathHash),
		buildInputs,
		buildInputsVersion
	};
}

function cachePath(cache: CacheScope): string {
	return cache.kind === 'default' ? '' : `/cache/${cache.name}`;
}

function recordRequest(
	token: string,
	entries: readonly Entry[],
	cache: CacheScope = defaultCache()
): Promise<Response> {
	return authorisedFetch(`${cachePath(cache)}/build-inputs`, token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ entries })
	});
}

async function record(
	token: string,
	entries: readonly Entry[],
	cache: CacheScope = defaultCache()
) {
	const response = await recordRequest(token, entries, cache);

	expect(response.status, await response.clone().text()).toBe(StatusCodes.OK);

	return buildInputsRecordResponseSchema.parse(await response.json());
}

async function insertPaths(
	storePathHashes: readonly StorePathHash[],
	cache: CacheScope = defaultCache()
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (const [index, storePathHash] of storePathHashes.entries()) {
			insertNarInfo(instance.context, storePathHash, index + 1, cache);
		}
	});
}

const errorBodySchema = z.object({
	defined: z.boolean(),
	code: z.string(),
	status: z.number(),
	data: z.unknown()
});

async function readErrorBody(response: Response): Promise<unknown> {
	const { defined, code, status, data } = errorBodySchema.parse(
		await response.json()
	);

	return { defined, code, status, data };
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

// The cost of the one `build-inputs` request that `run` sends.
async function requestCost(
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
		.filter((parsed) => parsed.path === '/build-inputs');

	expect(rest).toStrictEqual([]);

	if (line === undefined) {
		throw new Error('Expected the cost of a build-inputs request');
	}

	const { path: _path, ...cost } = line;

	return cost;
}

describe('recording build inputs', () => {
	beforeEach(resetTestServer);

	it('records build inputs on rows without them and reports absent paths', async () => {
		const token = await initialise();
		await insertPaths([target, other]);

		const response = await record(token, [
			entry(target, [source, gcc], 2),
			entry(other, [], 1),
			entry(missing, [gcc])
		]);

		expect({
			response,
			target: await buildInputColumns(target),
			other: await buildInputColumns(other)
		}).toStrictEqual({
			response: {
				entries: [
					{ storePath: storePathString(target), status: 'recorded' },
					{ storePath: storePathString(other), status: 'recorded' },
					{ storePath: storePathString(missing), status: 'absent' }
				]
			},
			target: {
				buildInputsJson: JSON.stringify([gcc, source]),
				buildInputsVersion: 2
			},
			other: { buildInputsJson: '[]', buildInputsVersion: 1 }
		});
	});

	it.each([
		{
			change: 'adds the given build inputs to the stored ones',
			given: { buildInputs: [make], version: 2 },
			status: 'recorded',
			expected: { buildInputs: [gcc, source, make], version: 2 }
		},
		{
			change: 'keeps the higher stored version',
			given: { buildInputs: [make], version: 1 },
			status: 'recorded',
			expected: { buildInputs: [gcc, source, make], version: 2 }
		},
		{
			change: 'raises the version of an unchanged set',
			given: { buildInputs: [gcc], version: 3 },
			status: 'recorded',
			expected: { buildInputs: [gcc, source], version: 3 }
		},
		{
			change: 'writes nothing for a subset at a lower version',
			given: { buildInputs: [source], version: 1 },
			status: 'unchanged',
			expected: { buildInputs: [gcc, source], version: 2 }
		}
	])('$change', async ({ given, status, expected }) => {
		const token = await initialise();
		await insertPaths([target]);
		await storeBuildInputs(target, [gcc, source], 2);

		const response = await record(token, [
			entry(target, given.buildInputs, given.version)
		]);

		expect({
			response,
			columns: await buildInputColumns(target)
		}).toStrictEqual({
			response: { entries: [{ storePath: storePathString(target), status }] },
			columns: {
				buildInputsJson: JSON.stringify(
					expected.buildInputs.toSorted(byCodeUnit)
				),
				buildInputsVersion: expected.version
			}
		});
	});

	it('refuses to grow a stored set beyond the limit for one path', async () => {
		const token = await initialise();
		await insertPaths([target, other]);
		const full = Array.from({ length: buildInputsMaxLength }, (_, index) =>
			input(index)
		);
		await storeBuildInputs(target, full, 1);

		const response = await record(token, [
			entry(target, [storePathBasename(other)], 1),
			entry(other, [gcc], 1)
		]);

		expect({
			response,
			target: await buildInputColumns(target),
			other: await buildInputColumns(other)
		}).toStrictEqual({
			response: {
				entries: [
					{ storePath: storePathString(target), status: 'limit-exceeded' },
					{ storePath: storePathString(other), status: 'recorded' }
				]
			},
			target: { buildInputsJson: JSON.stringify(full), buildInputsVersion: 1 },
			other: { buildInputsJson: JSON.stringify([gcc]), buildInputsVersion: 1 }
		});
	});

	const pageLimitRefusal = {
		status: StatusCodes.REQUEST_TOO_LONG,
		body: {
			defined: true,
			code: buildInputsPageLimitErrorCode,
			status: StatusCodes.REQUEST_TOO_LONG,
			data: {
				maxEntries: buildInputsRecordMaxEntries,
				maxBuildInputs: buildInputsRecordMaxBuildInputs
			}
		}
	};
	const accepted = { status: StatusCodes.OK, body: undefined };

	it.each([
		{
			page: 'the most entries',
			entries: buildInputsRecordMaxEntries,
			perEntry: 1,
			expected: accepted
		},
		{
			page: 'one entry too many',
			entries: buildInputsRecordMaxEntries + 1,
			perEntry: 1,
			expected: pageLimitRefusal
		},
		{
			page: 'the most build inputs',
			entries: 2,
			perEntry: buildInputsRecordMaxBuildInputs / 2,
			expected: accepted
		},
		{
			page: 'one build input too many',
			entries: 2,
			perEntry: buildInputsRecordMaxBuildInputs / 2 + 1,
			expected: pageLimitRefusal
		}
	])(
		'answers $expected.status to a page with $page',
		async ({ entries, perEntry, expected }) => {
			const token = await initialise();
			const page = Array.from({ length: entries }, (_, index) =>
				entry(
					syntheticStorePathHash(10 + index),
					Array.from({ length: perEntry }, (_unused, offset) =>
						input(index * perEntry + offset)
					)
				)
			);

			const response = await recordRequest(token, page);
			const body = await (response.ok
				? response.body?.cancel()
				: readErrorBody(response));

			expect({ status: response.status, body }).toStrictEqual(expected);
		}
	);

	it.each([
		{
			holder: 'a token with the build-inputs:record grant',
			grants: [
				{
					type: 'cupboard_cache',
					actions: ['build-inputs:record'],
					cache: { kind: 'default' }
				}
			],
			status: StatusCodes.OK,
			columns: { buildInputsJson: JSON.stringify([gcc]), buildInputsVersion: 1 }
		},
		{
			holder: 'a token with every other cache operation',
			grants: [
				{
					type: 'cupboard_cache',
					actions: cacheOperations.filter(
						(operation) => operation !== 'build-inputs:record'
					),
					cache: { kind: 'default' }
				}
			],
			status: StatusCodes.FORBIDDEN,
			columns: unrecorded
		},
		{
			holder: 'a token with the grant for another cache',
			grants: [
				{
					type: 'cupboard_cache',
					actions: ['build-inputs:record'],
					cache: { kind: 'named', name: 'other' }
				}
			],
			status: StatusCodes.FORBIDDEN,
			columns: unrecorded
		}
	])('answers $status to $holder', async ({ grants, status, columns }) => {
		await initialise();
		await insertPaths([target]);
		const token = await issueServerSignedToken(
			authorizationDetailsSchema.parse(grants)
		);

		const response = await recordRequest(token, [entry(target, [gcc])]);
		await response.body?.cancel();

		expect({
			status: response.status,
			columns: await buildInputColumns(target)
		}).toStrictEqual({ status, columns });
	});

	it('reports every path of a removed cache as absent and writes nothing', async () => {
		const token = await initialise();
		const builds = namedCache('builds');
		await putTestCache(token, builds);
		await insertPaths([target], builds);
		const removed = await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context, builds);
			instance.context.db
				.update(schema.cacheIdentities)
				.set({ deletedAt: isoTimestamp(new Date()) })
				.where(eq(schema.cacheIdentities.id, cache.id))
				.run();

			return cache.id;
		});

		const response = await record(token, [entry(target, [gcc])], builds);

		expect({
			response,
			columns: await buildInputColumns(target, removed)
		}).toStrictEqual({
			response: {
				entries: [{ storePath: storePathString(target), status: 'absent' }]
			},
			columns: unrecorded
		});
	});

	// Each entry reads its 8,191 stored and 1 given build inputs, so four
	// entries fit in the budget of 32,768 and the fifth does not. The request
	// reads no row after the fifth, so a longer deferred suffix reads no more.
	it.each([5, 8])(
		'defers the entries from the first that the work budget cannot cover, in a page of %i',
		async (length) => {
			const token = await initialise();
			const paths = Array.from({ length }, (_, index) =>
				syntheticStorePathHash(10 + index)
			);
			const stored = Array.from(
				{ length: buildInputsMaxLength - 1 },
				(_, index) => input(index)
			);
			await insertPaths(paths);
			for (const path of paths) {
				await storeBuildInputs(path, stored, 1);
			}
			let response: unknown;

			const cost = await requestCost(async () => {
				response = await record(
					token,
					paths.map((path) => entry(path, [input(buildInputsMaxLength)], 2))
				);
			});

			expect({ response, cost }).toStrictEqual({
				response: {
					entries: paths.map((path, index) => ({
						storePath: storePathString(path),
						status: index < 4 ? 'recorded' : 'deferred'
					}))
				},
				cost: { ...noCost, rowsRead: 15, rowsWritten: 4 }
			});
		}
	);

	it('parses no stored build inputs for an entry whose store path does not match its row', async () => {
		await initialise();
		const paths = Array.from({ length: 4 }, (_, index) =>
			syntheticStorePathHash(10 + index)
		);
		const stored = Array.from({ length: buildInputsMaxLength }, (_, index) =>
			input(index)
		);
		const storedJson = JSON.stringify(stored);
		await insertPaths(paths);
		for (const path of paths) {
			await storeBuildInputs(path, stored, 1);
		}
		const body = buildInputsRecordBodySchema.parse({
			entries: paths.map((path) => ({
				storePath: `/nix/store/${path}-other`,
				buildInputs: [gcc],
				buildInputsVersion: 1
			}))
		});

		const outcome = await runInDurableObject(currentServer(), (instance) => {
			const parse = vi.spyOn(JSON, 'parse');

			try {
				const response = new BuildInputsService(instance.context).record(
					defaultCache(),
					body
				);

				return {
					response,
					storedSetsParsed: parse.mock.calls.filter(
						([source]) => source === storedJson
					).length
				};
			} finally {
				parse.mockRestore();
			}
		});

		expect(outcome).toStrictEqual({
			response: {
				entries: paths.map((path) => ({
					storePath: `/nix/store/${path}-other`,
					status: 'absent'
				}))
			},
			storedSetsParsed: 0
		});
	});

	it('reports a row that lists more build inputs than a row can have as invalid', async () => {
		const token = await initialise();
		await insertPaths([target, other]);
		const oversized = Array.from(
			{ length: buildInputsMaxLength + 1 },
			(_, index) => input(index)
		);
		await storeBuildInputs(target, oversized, 1);

		const response = await record(token, [
			entry(target, [gcc]),
			entry(other, [gcc])
		]);

		expect(response).toStrictEqual({
			entries: [
				{ storePath: storePathString(target), status: 'invalid-stored' },
				{ storePath: storePathString(other), status: 'recorded' }
			]
		});
	});

	it.each([
		{
			row: 'a version without build inputs',
			stored: { buildInputsVersion: 1 }
		},
		{
			row: 'build inputs without a version',
			stored: { buildInputsJson: JSON.stringify([gcc]) }
		}
	])('reports a row with $row as invalid', async ({ stored }) => {
		const token = await initialise();
		await insertPaths([target]);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.narInfos)
				.set(stored)
				.where(eq(schema.narInfos.storePathHash, target))
				.run();
		});

		const response = await record(token, [entry(target, [source])]);

		expect(response).toStrictEqual({
			entries: [
				{ storePath: storePathString(target), status: 'invalid-stored' }
			]
		});
	});

	it('refuses build inputs that would not fit in the row beside its references', async () => {
		const token = await initialise();
		await insertPaths([target]);
		const half = Math.ceil(pathEdgesMaxJsonBytes / 247 / 2) + 1;
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.narInfos)
				.set({
					referencesJson: JSON.stringify(
						Array.from({ length: half }, (_, index) => longestInput(index))
					)
				})
				.where(eq(schema.narInfos.storePathHash, target))
				.run();
		});

		const response = await record(token, [
			entry(
				target,
				Array.from({ length: half }, (_, index) => longestInput(half + index))
			)
		]);

		expect({
			response,
			columns: await buildInputColumns(target)
		}).toStrictEqual({
			response: {
				entries: [
					{ storePath: storePathString(target), status: 'limit-exceeded' }
				]
			},
			columns: unrecorded
		});
	});

	it.each([
		{
			change: 'only the version',
			given: [gcc],
			expected: {
				columns: {
					buildInputsJson: JSON.stringify([gcc]),
					buildInputsVersion: 2
				},
				frontier: []
			}
		},
		{
			change: 'the build inputs',
			given: [source],
			expected: {
				columns: {
					buildInputsJson: JSON.stringify([gcc, source].toSorted(byCodeUnit)),
					buildInputsVersion: 2
				},
				frontier: [target]
			}
		}
	])(
		'queues a marked path for collection when an update changes $change',
		async ({ given, expected }) => {
			const token = await initialise();
			await insertPaths([target]);
			await storeBuildInputs(target, [gcc], 1);
			const frontier = () =>
				runInDurableObject(currentServer(), (instance) =>
					instance.context.db
						.select({
							storePathHash: schema.garbageCollectionFrontier.storePathHash
						})
						.from(schema.garbageCollectionFrontier)
						.all()
						.map((row) => row.storePathHash)
				);
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.insert(schema.garbageCollectionMarks)
					.values({
						cacheId: resolvedCache(instance.context).id,
						storePathHash: target
					})
					.run();
			});

			await record(token, [entry(target, given, 2)]);

			expect({
				columns: await buildInputColumns(target),
				frontier: await frontier()
			}).toStrictEqual(expected);
		}
	);

	it('reports a row whose stored build inputs cannot be read and records the others', async () => {
		const token = await initialise();
		await insertPaths([target, other]);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.narInfos)
				.set({ buildInputsJson: '{"not":"a list"}', buildInputsVersion: 1 })
				.where(eq(schema.narInfos.storePathHash, target))
				.run();
		});

		const response = await record(token, [
			entry(target, [gcc]),
			entry(other, [gcc])
		]);

		expect({
			response,
			target: await buildInputColumns(target),
			other: await buildInputColumns(other)
		}).toStrictEqual({
			response: {
				entries: [
					{ storePath: storePathString(target), status: 'invalid-stored' },
					{ storePath: storePathString(other), status: 'recorded' }
				]
			},
			target: { buildInputsJson: '{"not":"a list"}', buildInputsVersion: 1 },
			other: { buildInputsJson: JSON.stringify([gcc]), buildInputsVersion: 1 }
		});
	});

	it('refuses to grow a stored set beyond the bytes that one path can store', async () => {
		const token = await initialise();
		await insertPaths([target]);
		const perInput = longestInput(0).length + 3;
		const half = Math.ceil(buildInputsMaxJsonBytes / perInput / 2);
		const full = Array.from({ length: half }, (_, index) =>
			longestInput(index)
		);
		await storeBuildInputs(target, full, 1);

		const response = await record(token, [
			entry(
				target,
				Array.from({ length: half }, (_, index) => longestInput(half + index))
			)
		]);

		expect({
			response,
			columns: await buildInputColumns(target)
		}).toStrictEqual({
			response: {
				entries: [
					{ storePath: storePathString(target), status: 'limit-exceeded' }
				]
			},
			columns: { buildInputsJson: JSON.stringify(full), buildInputsVersion: 1 }
		});
	});

	it('refuses a closed cache', async () => {
		const token = await initialise();
		await insertPaths([target]);
		await runInDurableObject(currentServer(), (instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO managed_cache_retirement(cache_id,eligible_after,retirement_started_at) VALUES (?, '2099-01-01T00:00:00.000Z', ?)",
				resolvedCache(instance.context).id,
				isoTimestamp(new Date())
			);
		});

		const response = await recordRequest(token, [entry(target, [gcc])]);

		expect({
			status: response.status,
			body: await readErrorBody(response),
			columns: await buildInputColumns(target)
		}).toStrictEqual({
			status: StatusCodes.CONFLICT,
			body: {
				defined: true,
				code: 'CACHE_CLOSED',
				status: StatusCodes.CONFLICT,
				data: { cache: defaultCache() }
			},
			columns: unrecorded
		});
	});

	it('reports every path of an absent named cache as absent and does not create it', async () => {
		const token = await initialise();
		const missingCache = namedCache('missing');

		const response = await record(token, [entry(target, [gcc])], missingCache);

		expect({
			response,
			cache: await runInDurableObject(currentServer(), (instance) =>
				instance.context.cacheRepository.resolve(missingCache)
			)
		}).toStrictEqual({
			response: {
				entries: [{ storePath: storePathString(target), status: 'absent' }]
			},
			cache: undefined
		});
	});

	it('writes one row for each recorded entry and none for unchanged entries', async () => {
		const token = await initialise();
		const paths = Array.from({ length: 4 }, (_, index) =>
			syntheticStorePathHash(10 + index)
		);
		await insertPaths(paths);
		const page = paths.map((path) => entry(path, [gcc, source]));

		const recorded = await requestCost(async () => {
			await record(token, page);
		});
		const unchanged = await requestCost(async () => {
			await record(token, page);
		});

		expect({ recorded, unchanged }).toStrictEqual({
			recorded: { ...noCost, rowsRead: 14, rowsWritten: 4 },
			unchanged: { ...noCost, rowsRead: 10, rowsWritten: 0 }
		});
	});
});
