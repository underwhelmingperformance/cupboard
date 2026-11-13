import { startCapture } from '@cupboard/logger/testing';
import {
	rootNameSchema,
	type StorePathHash,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';

import {
	deliverAlarms,
	ignoreAlarmDeliveries
} from '../alarm-fence.test-support.ts';
import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	currentNarObjectKey,
	currentServer,
	initialise,
	latestMigrationIndex,
	listRoots,
	migrateThrough,
	migrationIndexNamed,
	narBytes,
	pushPath,
	resetTestServer,
	resolvedCache,
	setRoot,
	testPushId,
	testServerFor,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { type SchemaDatabase } from './context.ts';
import { type DatabaseCostMeter } from './database-cost-meter.ts';
import {
	deletePathTargets,
	existingRootIncarnationKey,
	insertLiveRootTargets
} from './live-root-targets.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';
import { RootTargetCountBackfill } from './root-target-count-backfill.ts';
import { withRowBudget } from './row-budget.ts';

const smallRoot = 149;
const largeRoot = 10_000;

const requestCostSchema = z.object({
	route: z.string(),
	rowsRead: z.number(),
	rowsWritten: z.number()
});

const listingCost: z.infer<typeof requestCostSchema> = {
	route: '/roots',
	rowsRead: 8,
	rowsWritten: 0
};

const uncounted = 'uncounted';

// The base32 alphabet of store-path hashes.
const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';

const pushed = uploadMetadata({
	fileSize: narBytes.byteLength,
	name: 'pushed',
	storePathHash: 'z'.repeat(32)
});

const clearRoots = [
	'DELETE FROM retention_root_release WHERE cache_id = ?',
	'DELETE FROM retention_root_target WHERE cache_id = ?',
	'DELETE FROM retention_root WHERE cache_id = ?'
];

const expireRoot =
	"UPDATE retention_root SET expires_at = '2020-01-01T00:00:00.000Z' WHERE cache_id = ? AND name = ?";

const forgetCount =
	'UPDATE retention_root SET target_count = NULL WHERE cache_id = ? AND name = ?';

// The state of an object that has just applied 0085 over these roots.
const forgetCounts = 'UPDATE retention_root SET target_count = NULL';

const restartBackfill =
	'UPDATE root_target_count_backfill SET rowid_high_water = (SELECT max(rowid) FROM retention_root), cursor = 0';

// A root that an earlier version of cupboard created, with three targets.
const insertLegacyRoot =
	"INSERT INTO retention_root (cache_id, name, created_at, updated_at) VALUES (?1, 'legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')";

// Roots with names of 250 characters. Their names serialise to more than the
// 2,000,000 bytes that one bound string can contain.
const manyRoots = 8500;

const insertManyRoots = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO retention_root (cache_id, name, created_at, updated_at, target_count)
	SELECT ?1, printf('%0250d', n), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1 FROM sequence`;

const insertManyTargets = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path)
	SELECT ?1, printf('%0250d', n), ?3, ?4 FROM sequence`;

const insertLegacyTargets = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 3)
	INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path)
	SELECT ?1, 'legacy', printf('l%031d', n), printf('/nix/store/l%031d-p', n) FROM sequence`;

// A store path whose hash starts with `prefix` and ends with `index` in
// base32.
function syntheticTarget(prefix: string, index: number) {
	let digits = '';

	for (let rest = index; rest > 0; rest = Math.floor(rest / 32)) {
		digits = alphabet.charAt(rest % 32) + digits;
	}

	const hash = `${prefix}${digits.padStart(31, '0')}`;

	return {
		storePathHash: storePathHashSchema.parse(hash),
		storePath: storePathSchema.parse(`/nix/store/${hash}-synthetic`)
	};
}

// Attaches paths without narinfo rows to a root, as a commit's attach does,
// and returns the rows that the attach reads and writes.
async function attachPaths(
	name: string,
	paths: readonly ReturnType<typeof syntheticTarget>[]
) {
	return runInDurableObject(currentServer(), (instance) => {
		const cache = resolvedCache(instance.context);
		const root = existingRootIncarnationKey(
			instance.context.db,
			cache.id,
			rootNameSchema.parse(name)
		);

		expect(root).toBeDefined();

		return meteredRows(instance.context.dbCost, () => {
			if (root === undefined) {
				return;
			}

			insertLiveRootTargets(
				instance.context.db,
				new RetentionService(instance.context),
				cache,
				root,
				paths
			);
		});
	});
}

async function attachTargets(
	name: string,
	prefix: string,
	count: number
): Promise<void> {
	await attachPaths(
		name,
		Array.from({ length: count }, (_, index) => syntheticTarget(prefix, index))
	);
}

// Deletes a path's target rows, as a commit that reclaims the path's reserved
// narinfo row does.
async function deleteTargets(storePathHash: StorePathHash): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		deletePathTargets(
			instance.context.db,
			resolvedCache(instance.context).id,
			storePathHash
		);
	});
}

// Binds the run root `bound` through a negotiation without paths. The first
// bind creates the root.
async function bindRunRoot(token: string): Promise<void> {
	const response = await authorisedFetch('/uploads', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			pushId: testPushId,
			paths: [],
			attachRoot: {
				name: 'bound',
				retention: { kind: 'duration', seconds: 3600 }
			}
		})
	});

	expect(response.status).toBe(StatusCodes.OK);
}

// Each root's stored count, or `uncounted` for a root without one.
function storedCountsIn(database: SchemaDatabase) {
	return Object.fromEntries(
		database
			.select({
				name: schema.retentionRoots.name,
				targetCount: schema.retentionRoots.targetCount
			})
			.from(schema.retentionRoots)
			.orderBy(schema.retentionRoots.name)
			.all()
			.map((root) => [root.name, root.targetCount ?? uncounted])
	);
}

async function storedCounts() {
	return runInDurableObject(currentServer(), (instance) =>
		storedCountsIn(instance.context.db)
	);
}

// The rows that `body` reads and writes.
function meteredRows(meter: DatabaseCostMeter, body: () => void) {
	meter.recordOutstanding();
	const rowsRead = meter.rowsRead;
	const rowsWritten = meter.rowsWritten;
	body();
	meter.recordOutstanding();

	return {
		rowsRead: meter.rowsRead - rowsRead,
		rowsWritten: meter.rowsWritten - rowsWritten
	};
}

// Deletes the pushed path's NAR and demotes its narinfo, so every root that
// keeps it keeps a demoted target.
async function demotePushed(): Promise<void> {
	await env.BLOBS.delete(await currentNarObjectKey(pushed.narHash));
	await runInDurableObject(currentServer(), (instance) =>
		new NarInfoObjectsService(instance.context).demoteUnbacked(
			resolvedCache(instance.context),
			storePathHashSchema.parse(pushed.storePathHash),
			pushed.narHash
		)
	);
}

// Replaces the default cache's roots with `live`, which keeps the demoted
// path and `size` more, and `expired`, which keeps the same number of paths
// and has expired. An earlier incarnation of `live` keeps another `size`
// rows, and its release waits for the drain.
async function seedRoots(token: string, size: number): Promise<void> {
	await runInDurableObject(currentServer(), (instance, state) => {
		const cacheId = resolvedCache(instance.context).id;

		for (const statement of clearRoots) {
			state.storage.sql.exec(statement, cacheId);
		}
	});

	await setRoot(token, { name: 'live', targets: [pushed.storePath] });
	await attachTargets('live', 'a', size);
	await setRoot(token, { name: 'live', targets: [pushed.storePath] });
	await attachTargets('live', 'b', size);
	await setRoot(token, { name: 'expired', targets: [pushed.storePath] });
	await attachTargets('expired', 'c', size);
	await runInDurableObject(currentServer(), (instance, state) => {
		state.storage.sql.exec(
			expireRoot,
			resolvedCache(instance.context).id,
			'expired'
		);
	});
}

// Lists the roots and returns the response and the cost that the object
// logged for the request.
async function measuredListing(token: string) {
	const capture = startCapture();

	try {
		const response = await listRoots(token);
		const costs = capture.logs
			.filter((entry) => entry.message === 'request finished')
			.map((entry) => requestCostSchema.parse(entry.properties));

		return { response, costs };
	} finally {
		capture.stop();
	}
}

function listedRoots(size: number) {
	return {
		roots: [
			{
				name: 'expired',
				expiresAt: '2020-01-01T00:00:00.000Z',
				expired: true,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
				targetCount: size + 1
			},
			{
				name: 'live',
				expired: false,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
				targetCount: size + 1
			}
		]
	};
}

async function seededTenant(): Promise<string> {
	await resetTestServer();
	const token = await initialise();
	await pushPath(token, pushed);
	await demotePushed();
	// An alarm would drain the earlier incarnation before the listing.
	const id = currentServer().id;
	ignoreAlarmDeliveries(id);
	onTestFinished(() => {
		deliverAlarms(id);
	});

	return token;
}

describe('root target counts', () => {
	it('lists roots at a cost that the number of their targets does not change', async () => {
		const token = await seededTenant();
		const measure = async (size: number) => {
			await seedRoots(token, size);

			return measuredListing(token);
		};

		const small = await measure(smallRoot);
		const large = await measure(largeRoot);

		expect({ small, large }).toStrictEqual({
			small: { response: listedRoots(smallRoot), costs: [listingCost] },
			large: { response: listedRoots(largeRoot), costs: [listingCost] }
		});
	});

	// The attach keeps one path, takes one back from the earlier incarnation and
	// adds one.
	it('attaches paths at a cost that the number of the root targets does not change', async () => {
		const token = await seededTenant();
		const measure = async (size: number) => {
			await seedRoots(token, size);
			const cost = await attachPaths('live', [
				syntheticTarget('b', 0),
				syntheticTarget('a', 1),
				syntheticTarget('d', 0)
			]);

			return { cost, counts: await storedCounts() };
		};

		const small = await measure(smallRoot);
		const large = await measure(largeRoot);

		expect({ small, large }).toStrictEqual({
			small: {
				cost: { rowsRead: 28, rowsWritten: 6 },
				counts: { expired: smallRoot + 1, live: smallRoot + 3 }
			},
			large: {
				cost: { rowsRead: 28, rowsWritten: 6 },
				counts: { expired: largeRoot + 1, live: largeRoot + 3 }
			}
		});
	});

	it('keeps each stored count equal to the targets of the root through every write', async () => {
		const token = await seededTenant();
		const steps: { step: string; counts: unknown }[] = [];
		const record = async (step: string) => {
			steps.push({ step, counts: await storedCounts() });
		};

		await setRoot(token, { name: 'run', targets: [pushed.storePath] });
		await record('set');
		await attachTargets('run', 'a', 3);
		await record('attach three new paths');
		await attachPaths('run', [
			syntheticTarget('a', 0),
			syntheticTarget('a', 3),
			syntheticTarget('a', 3)
		]);
		await record('attach a kept path and one new path twice');
		await setRoot(token, { name: 'run', targets: [pushed.storePath] });
		await record('replace');
		await attachPaths('run', [
			syntheticTarget('a', 0),
			syntheticTarget('b', 0)
		]);
		await record('attach a released path and a new path');
		await setRoot(token, { name: 'other', targets: [pushed.storePath] });
		await bindRunRoot(token);
		await record('create two more roots');
		await attachPaths('bound', [syntheticTarget('c', 0)]);
		await bindRunRoot(token);
		await record('attach to the run root and bind it again');
		await runInDurableObject(currentServer(), (instance, state) => {
			state.storage.sql.exec(
				forgetCount,
				resolvedCache(instance.context).id,
				'other'
			);
		});
		await attachPaths('other', [syntheticTarget('a', 0)]);
		await record('attach to a root without a count');
		await deleteTargets(syntheticTarget('a', 0).storePathHash);
		await deleteTargets(syntheticTarget('a', 1).storePathHash);
		await record('delete a path that two roots keep and a released path');
		await setRoot(token, { name: 'other', targets: [pushed.storePath] });
		await record('set a root without a count to its targets');

		expect({ steps, listing: await listRoots(token) }).toStrictEqual({
			steps: [
				{ step: 'set', counts: { run: 1 } },
				{ step: 'attach three new paths', counts: { run: 4 } },
				{
					step: 'attach a kept path and one new path twice',
					counts: { run: 5 }
				},
				{ step: 'replace', counts: { run: 1 } },
				{ step: 'attach a released path and a new path', counts: { run: 3 } },
				{
					step: 'create two more roots',
					counts: { bound: 0, other: 1, run: 3 }
				},
				{
					step: 'attach to the run root and bind it again',
					counts: { bound: 1, other: 1, run: 3 }
				},
				{
					step: 'attach to a root without a count',
					counts: { bound: 1, other: uncounted, run: 3 }
				},
				{
					step: 'delete a path that two roots keep and a released path',
					counts: { bound: 1, other: uncounted, run: 2 }
				},
				{
					step: 'set a root without a count to its targets',
					counts: { bound: 1, other: 1, run: 2 }
				}
			],
			listing: {
				roots: [
					{
						name: 'bound',
						expiresAt: '2026-01-01T01:00:00.000Z',
						expired: false,
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-01-01T00:00:00.000Z',
						targetCount: 1
					},
					{
						name: 'other',
						expired: false,
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-01-01T00:00:00.000Z',
						targetCount: 1
					},
					{
						name: 'run',
						expired: false,
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-01-01T00:00:00.000Z',
						targetCount: 2
					}
				]
			}
		});
	});

	it('lists roots without a count by counting their targets until the backfill counts them, and keeps the counts afterwards', async () => {
		const token = await seededTenant();
		await seedRoots(token, smallRoot);
		await runInDurableObject(currentServer(), (instance, state) => {
			const cacheId = resolvedCache(instance.context).id;

			state.storage.sql.exec(insertLegacyRoot, cacheId);
			state.storage.sql.exec(insertLegacyTargets, cacheId);
			state.storage.sql.exec(forgetCounts);
			state.storage.sql.exec(restartBackfill);
		});

		const before = await measuredListing(token);
		const passes = await runInDurableObject(currentServer(), (instance) => {
			const backfill = new RootTargetCountBackfill(instance.context);
			const observed = [];

			while (backfill.hasPending()) {
				const cost = meteredRows(instance.context.dbCost, () => {
					withRowBudget(() => {
						backfill.advance();
					}, 1);
				});
				observed.push({ cost, counts: storedCountsIn(instance.context.db) });
			}

			return observed;
		});
		const after = await measuredListing(token);
		// The legacy root has no incarnation, so its rows have none either.
		await attachPaths('legacy', [syntheticTarget('f', 0)]);
		const legacyAttach = await storedCounts();
		await deleteTargets(storePathHashSchema.parse(`l${'1'.padStart(31, '0')}`));
		const legacyDelete = await storedCounts();
		const response = {
			roots: [
				listedRoots(smallRoot).roots[0],
				{
					name: 'legacy',
					expired: false,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					targetCount: 3
				},
				listedRoots(smallRoot).roots[1]
			]
		};

		// Each pass counts one root and reads its targets. Until the backfill
		// counts a root, the listing reads the root's targets.
		expect({
			before,
			passes,
			after,
			legacyAttach,
			legacyDelete
		}).toStrictEqual({
			before: {
				response,
				costs: [{ route: '/roots', rowsRead: 314, rowsWritten: 0 }]
			},
			passes: [
				{
					cost: { rowsRead: 157, rowsWritten: 2 },
					counts: { expired: uncounted, legacy: uncounted, live: smallRoot + 1 }
				},
				{
					cost: { rowsRead: 155, rowsWritten: 2 },
					counts: {
						expired: smallRoot + 1,
						legacy: uncounted,
						live: smallRoot + 1
					}
				},
				{
					cost: { rowsRead: 7, rowsWritten: 2 },
					counts: { expired: smallRoot + 1, legacy: 3, live: smallRoot + 1 }
				}
			],
			after: {
				response,
				costs: [{ route: '/roots', rowsRead: 10, rowsWritten: 0 }]
			},
			legacyAttach: {
				expired: smallRoot + 1,
				legacy: 4,
				live: smallRoot + 1
			},
			legacyDelete: {
				expired: smallRoot + 1,
				legacy: 3,
				live: smallRoot + 1
			}
		});
	});

	it('arms the alarm at start-up and counts the earlier roots in an alarm pass', async () => {
		const name = 'root-target-count-alarm';
		const stub = testServerFor(name);
		const armed: number[] = [];
		ignoreAlarmDeliveries(stub.id);
		onTestFinished(() => {
			deliverAlarms(stub.id);
		});

		await runInDurableObject(stub, async (_instance, state) => {
			const arm = state.storage.setAlarm.bind(state.storage);
			state.storage.setAlarm = (time, options) => {
				armed.push(Number(time));

				return arm(time, options);
			};
			await migrateThrough(
				state,
				migrationIndexNamed('0084_root_incarnations')
			);
			state.storage.sql.exec(insertLegacyRoot, 1);
			state.storage.sql.exec(insertLegacyTargets, 1);
			await migrateThrough(state, latestMigrationIndex);
		});
		// Configuring the tenant initialises the object.
		await useTestServer(name);
		const armedAtStart = [...armed];
		deliverAlarms(stub.id);
		const counts = await runInDurableObject(stub, async (instance) => {
			await instance.alarm();

			return storedCountsIn(instance.context.db);
		});

		expect({ armedAtStart, counts }).toStrictEqual({
			armedAtStart: [Date.parse('2026-01-01T00:00:00.000Z')],
			counts: { legacy: 3 }
		});
	});

	it('subtracts a deleted path from more roots than one bound list can name', async () => {
		await resetTestServer();
		await initialise();
		const path = syntheticTarget('g', 0);
		const remaining = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const cacheId = resolvedCache(instance.context).id;

				state.storage.sql.exec(insertManyRoots, cacheId, manyRoots);
				state.storage.sql.exec(
					insertManyTargets,
					cacheId,
					manyRoots,
					path.storePathHash,
					path.storePath
				);
				deletePathTargets(instance.context.db, cacheId, path.storePathHash);

				return {
					counts: state.storage.sql
						.exec(
							'SELECT target_count, count(*) AS roots FROM retention_root WHERE cache_id = ? GROUP BY target_count',
							cacheId
						)
						.toArray(),
					targets: state.storage.sql
						.exec(
							'SELECT count(*) AS targets FROM retention_root_target WHERE cache_id = ?',
							cacheId
						)
						.toArray()
				};
			}
		);

		expect(remaining).toStrictEqual({
			counts: [{ target_count: 0, roots: manyRoots }],
			targets: [{ targets: 0 }]
		});
	});

	it('starts the backfill at the roots that exist when 0085 runs', async () => {
		const observed = await runInDurableObject(
			testServerFor('root-target-count-migration'),
			async (instance, state) => {
				await migrateThrough(
					state,
					migrationIndexNamed('0084_root_incarnations')
				);
				state.storage.sql.exec(insertLegacyRoot, 1);
				state.storage.sql.exec(insertLegacyTargets, 1);
				await migrateThrough(state, latestMigrationIndex);
				const backfill = new RootTargetCountBackfill(instance.context);

				return {
					progress: state.storage.sql
						.exec(
							'SELECT rowid_high_water, cursor FROM root_target_count_backfill'
						)
						.toArray(),
					counts: storedCountsIn(instance.context.db),
					hasPending: backfill.hasPending()
				};
			}
		);

		expect(observed).toStrictEqual({
			progress: [{ rowid_high_water: 1, cursor: 0 }],
			counts: { legacy: uncounted },
			hasPending: true
		});
	});
});
