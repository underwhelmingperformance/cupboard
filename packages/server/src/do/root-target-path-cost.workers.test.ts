import { startCapture } from '@cupboard/logger/testing';
import {
	type RootName,
	rootNameSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import migrations from '../../drizzle/migrations.js';
import { type CacheId, cacheIdSchema } from '../db/cache.ts';
import {
	type RootIncarnation,
	rootIncarnationSchema
} from '../db/root-incarnation.ts';
import * as schema from '../db/schema.ts';
import {
	currentServer,
	initialise,
	migrateThrough,
	migrationIndexNamed,
	namedCache,
	putTestCache,
	resetTestServer,
	resolvedCache,
	syntheticStorePathHash,
	testServerFor,
	withoutAlarmArming
} from '../test-support.ts';

import { type SchemaWriter, type ServerContext } from './context.ts';
import { DatabaseCostMeter, meteredStorage } from './database-cost-meter.ts';
import {
	collectOneUnitOfWork,
	driveScanTo,
	futureInstant,
	insertNarInfo,
	pastInstant
} from './garbage-collection.test-support.ts';
import { seedPageSelect, seedSources } from './garbage-collection-service.ts';
import { deletePathTargets, pathTargetsDelete } from './live-root-targets.ts';
import { applyMigrations, migrationsThrough } from './migrate.ts';
import {
	type OperationCostRecord,
	withOperationCost
} from './operation-cost.ts';

const pathIndexMigration = '0086_root_target_path_index';

// The rows that each state of the fixture has, and the cost of building the
// path index over them. The migration test inserts six times `size` target
// rows, plus five rows of `keptPath`, into cache 1. The build writes one
// index entry for each of them, and the migration writes three more rows
// at both sizes.
const sizes = [
	{ size: 150, indexBuild: { rowsRead: 2087, rowsWritten: 908 } },
	{ size: 10_000, indexBuild: { rowsRead: 121_479, rowsWritten: 60_008 } }
] as const;

const noBindingCalls = {
	d1Calls: 0,
	d1RowsRead: 0,
	d1RowsWritten: 0,
	d1CallsWithoutRows: 0,
	r2Head: 0,
	r2Get: 0,
	r2Put: 0,
	r2Delete: 0,
	r2List: 0
} as const;

const methodLineSchema = z.object({
	method: z.string(),
	rowsRead: z.number(),
	rowsWritten: z.number()
});

// A path with a target row in every state of the default cache and in
// another cache.
const keptPath = syntheticStorePathHash(1);
// A path without a target row.
const unkeptPath = syntheticStorePathHash(2);

const incarnations = {
	live: rootIncarnationSchema.parse(1_000_001),
	earlier: rootIncarnationSchema.parse(1_000_002),
	expired: rootIncarnationSchema.parse(1_000_003),
	removed: rootIncarnationSchema.parse(1_000_004),
	other: rootIncarnationSchema.parse(1_000_005)
} as const;

const past = isoTimestamp(new Date(pastInstant));
const future = isoTimestamp(new Date(futureInstant));

const frontierDeletion =
	'DELETE FROM garbage_collection_frontier WHERE cache_id = ?';
const selectPathTargets =
	'SELECT cache_id AS cacheId, root_name AS rootName FROM retention_root_target WHERE store_path_hash = ? ORDER BY cache_id, root_name';
const selectTargetCounts =
	'SELECT cache_id AS cacheId, name, target_count AS targetCount FROM retention_root ORDER BY cache_id, name';
const selectScan =
	'SELECT phase, cursor FROM garbage_collection_scan WHERE cache_id = ?';
const countFrontier =
	'SELECT count(*) AS count FROM garbage_collection_frontier WHERE cache_id = ?';
const selectTriggers =
	"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name";
const selectVerificationState =
	'SELECT verification_state AS verificationState FROM __drizzle_migrations WHERE hash = ?';

function rootSeedSource() {
	const source = seedSources.find((candidate) => candidate.phase === 'roots');

	if (source === undefined) {
		throw new Error('the collection scan has no root seed phase');
	}

	return source;
}

// The query plan of a statement that a Drizzle builder produces.
function queryPlan(
	sqlStorage: SqlStorage,
	statement: { readonly sql: string; readonly params: unknown[] }
): string[] {
	return Array.from(
		sqlStorage.exec<{ detail: string }>(
			`EXPLAIN QUERY PLAN ${statement.sql}`,
			...statement.params
		),
		(row) => row.detail
	);
}

interface TargetState {
	readonly name: RootName;
	readonly prefix: string;
	// The incarnation of the rows. Rows without one belong to a legacy root.
	readonly incarnation?: RootIncarnation;
	// The root row of the name, when the name has one.
	readonly root?: { readonly expiresAt?: IsoTimestamp };
	// Whether a root release of the rows is pending.
	readonly isReleased?: boolean;
	// Whether `keptPath` has a row under the name.
	readonly keepsPath: boolean;
}

// Every state that a target row of the default cache can be in. The rows of
// the earlier incarnation and of the removed root wait for the drain of
// their root release, and the expired root waits for a scan to expire it.
const targetStates: readonly TargetState[] = [
	{
		name: rootNameSchema.parse('live'),
		prefix: 'b',
		incarnation: incarnations.live,
		root: { expiresAt: future },
		keepsPath: true
	},
	{
		name: rootNameSchema.parse('live'),
		prefix: 'd',
		incarnation: incarnations.earlier,
		isReleased: true,
		keepsPath: false
	},
	{
		name: rootNameSchema.parse('expired'),
		prefix: 'f',
		incarnation: incarnations.expired,
		root: { expiresAt: past },
		keepsPath: true
	},
	{
		name: rootNameSchema.parse('legacy'),
		prefix: 'g',
		root: {},
		keepsPath: true
	},
	{
		name: rootNameSchema.parse('removed'),
		prefix: 'h',
		incarnation: incarnations.removed,
		isReleased: true,
		keepsPath: true
	},
	{
		name: rootNameSchema.parse('leftover'),
		prefix: 'i',
		keepsPath: true
	}
];

function insertState(
	database: SchemaWriter,
	cacheId: CacheId,
	state: TargetState,
	size: number
): void {
	const incarnation =
		state.incarnation === undefined ? sql`NULL` : sql`${state.incarnation}`;

	// `size` rows under the name, with hashes that start with the prefix.
	database.run(sql`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ${size})
		INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path, incarnation)
		SELECT ${cacheId}, ${state.name}, printf('%s%031d', ${state.prefix}, n), printf('/nix/store/%s%031d-p', ${state.prefix}, n), ${incarnation} FROM sequence`);

	if (state.keepsPath) {
		database
			.insert(schema.retentionRootTargets)
			.values({
				cacheId,
				rootName: state.name,
				storePathHash: keptPath,
				storePath: storePathSchema.parse(`/nix/store/${keptPath}-kept`),
				incarnation: state.incarnation
			})
			.run();
	}

	if (state.root !== undefined) {
		database
			.insert(schema.retentionRoots)
			.values({
				cacheId,
				name: state.name,
				expiresAt: state.root.expiresAt,
				createdAt: past,
				updatedAt: past,
				incarnation: state.incarnation,
				targetCount: size + (state.keepsPath ? 1 : 0)
			})
			.run();
	}

	if (state.isReleased === true) {
		database
			.insert(schema.retentionRootReleases)
			.values({
				cacheId,
				rootName: state.name,
				incarnation: state.incarnation,
				releasedAt: past
			})
			.run();
	}
}

// Seeds `size` target rows in each state of the default cache, and in a live
// root of the `other` cache.
function seedTargets(context: ServerContext, size: number): void {
	for (const state of targetStates) {
		insertState(context.db, resolvedCache(context).id, state, size);
	}

	insertState(
		context.db,
		resolvedCache(context, namedCache('other')).id,
		{
			name: rootNameSchema.parse('live'),
			prefix: 'j',
			incarnation: incarnations.other,
			root: {},
			keepsPath: true
		},
		size
	);
}

async function seededTenant(size: number): Promise<void> {
	const token = await initialise();
	await putTestCache(token, namedCache('other'));
	await runInDurableObject(currentServer(), (instance) => {
		seedTargets(instance.context, size);
	});
}

// Starts a scan of the default cache and drives it to its root seed phase,
// then seeds the targets. A scan expires roots and drains root releases
// before it seeds, so rows in those states reach a seed page only when a
// request writes them during the scan, as this fixture does. The rows that
// the collection barrier queues for the seeded targets are deleted, so the
// seed page queues its paths itself.
async function tenantInRootSeedPhase(size: number): Promise<void> {
	const token = await initialise();
	await putTestCache(token, namedCache('other'));
	await runInDurableObject(currentServer(), (instance) => {
		insertNarInfo(instance.context, syntheticStorePathHash(3), 3);
	});
	await driveScanTo(collectOneUnitOfWork, 'roots');
	await runInDurableObject(currentServer(), (instance, state) => {
		seedTargets(instance.context, size);
		state.storage.sql.exec(
			frontierDeletion,
			resolvedCache(instance.context).id
		);
	});
}

describe.each(sizes)(
	'path-keyed target queries with $size rows in each state',
	({ size, indexBuild }) => {
		beforeEach(resetTestServer);

		// Deleting the five rows of the kept path writes five rows, and the
		// three roots that keep it write their counts.
		it.each([
			{
				name: 'a path with a target row in every state',
				path: keptPath,
				cost: { rowsRead: 49, rowsWritten: 8, ...noBindingCalls },
				remaining: [{ cacheId: 2, rootName: 'live' }],
				counts: {
					expired: size,
					legacy: size,
					live: size
				}
			},
			{
				name: 'a path without a target row',
				path: unkeptPath,
				cost: { rowsRead: 1, rowsWritten: 0, ...noBindingCalls },
				remaining: [],
				counts: {
					expired: size + 1,
					legacy: size + 1,
					live: size + 1
				}
			}
		])(
			'deletes the target rows of $name at a cost that the cache size does not change',
			async (example) => {
				await seededTenant(size);

				const measured = await runInDurableObject(
					currentServer(),
					async (instance, state) => {
						const cacheId = resolvedCache(instance.context).id;
						let cost: OperationCostRecord | undefined;

						await withOperationCost(
							'reclaim',
							() => {
								deletePathTargets(instance.context.db, cacheId, example.path);

								return Promise.resolve();
							},
							(recorded) => {
								cost = recorded;
							}
						);

						return {
							cost,
							remaining: state.storage.sql
								.exec(selectPathTargets, example.path)
								.toArray(),
							counts: state.storage.sql.exec(selectTargetCounts).toArray()
						};
					}
				);

				expect(measured).toStrictEqual({
					cost: example.cost,
					remaining: example.remaining,
					counts: [
						{
							cacheId: 1,
							name: 'expired',
							targetCount: example.counts.expired
						},
						{ cacheId: 1, name: 'legacy', targetCount: example.counts.legacy },
						{ cacheId: 1, name: 'live', targetCount: example.counts.live },
						{ cacheId: 2, name: 'live', targetCount: size + 1 }
					]
				});
			}
		);

		it('reads a seed page of root targets at a cost that the cache size does not change', async () =>
			withoutAlarmArming(async () => {
				await tenantInRootSeedPhase(size);
				const capture = startCapture();

				try {
					await collectOneUnitOfWork();
				} finally {
					capture.stop();
				}

				const costs = capture.logs
					.filter((entry) => entry.message === 'method finished')
					.map((entry) => methodLineSchema.parse(entry.properties))
					.filter((line) => line.method === 'garbage-collection');
				const progress = await runInDurableObject(
					currentServer(),
					(instance, state) => {
						const cacheId = resolvedCache(instance.context).id;

						return {
							scan: state.storage.sql.exec(selectScan, cacheId).toArray(),
							frontier: state.storage.sql.exec(countFrontier, cacheId).toArray()
						};
					}
				);

				// The page queues the kept path and the first 127 paths of `live`.
				expect({ costs, ...progress }).toStrictEqual({
					costs: [
						{ method: 'garbage-collection', rowsRead: 519, rowsWritten: 257 }
					],
					scan: [{ phase: 'roots', cursor: `b${'127'.padStart(31, '0')}` }],
					frontier: [{ count: 128 }]
				});
			}));

		// SQLite maintains the index on every write, whichever build makes the
		// write, so the migration is not a barrier. The migrator records it
		// with the `verified` state, which the build that stops at 0085
		// admits. Every earlier build already refuses the store, because 0085
		// is a barrier.
		it('builds the path index over existing targets with the verified state', async () => {
			const migrated = await runInDurableObject(
				testServerFor(`migration-root-target-path-${String(size)}`),
				async (_instance, state) => {
					await migrateThrough(
						state,
						migrationIndexNamed(pathIndexMigration) - 1
					);

					const database = drizzle(state.storage, { schema });
					const cacheId = cacheIdSchema.parse(1);

					for (const target of targetStates) {
						insertState(database, cacheId, target, size);
					}

					const triggersBefore = state.storage.sql
						.exec(selectTriggers)
						.toArray();
					const meter = new DatabaseCostMeter();
					const result = await applyMigrations(
						drizzle(meteredStorage(state.storage, meter)),
						migrationsThrough(
							migrations,
							migrationIndexNamed(pathIndexMigration)
						)
					);
					meter.recordOutstanding();

					return {
						result,
						cost: { rowsRead: meter.rowsRead, rowsWritten: meter.rowsWritten },
						verification: state.storage.sql
							.exec(selectVerificationState, pathIndexMigration)
							.toArray(),
						triggersBefore,
						triggersAfter: state.storage.sql.exec(selectTriggers).toArray(),
						plans: [
							pathTargetsDelete(database, cacheId, keptPath).toSQL(),
							seedPageSelect(database, rootSeedSource(), cacheId, '').toSQL()
						].map((statement) => queryPlan(state.storage.sql, statement))
					};
				}
			);

			expect(migrated).toStrictEqual({
				result: { kind: 'complete', hasCommitted: true },
				cost: indexBuild,
				verification: [{ verificationState: 'verified' }],
				triggersBefore: migrated.triggersBefore,
				triggersAfter: migrated.triggersBefore,
				plans: [
					[
						'SEARCH retention_root_target USING COVERING INDEX retention_root_target_path_idx (cache_id=? AND store_path_hash=?)'
					],
					[
						'SEARCH retention_root_target USING COVERING INDEX retention_root_target_path_idx (cache_id=? AND store_path_hash>?)'
					]
				]
			});
		});
	}
);
