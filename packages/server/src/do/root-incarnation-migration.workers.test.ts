import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import cachePurgePrioritySnapshot from '../../drizzle/meta/0083_snapshot.json' with { type: 'json' };
import rootIncarnationsSnapshot from '../../drizzle/meta/0084_snapshot.json' with { type: 'json' };
import migrations from '../../drizzle/migrations.js';
import { migrateThrough, testServerFor } from '../test-support.ts';

import { DatabaseCostMeter, meteredStorage } from './database-cost-meter.ts';
import { applyMigrations, migrationsThrough } from './migrate.ts';

const beforeRootIncarnations = 83;
const rootIncarnations = 84;

const insertRoots =
	"INSERT INTO retention_root (cache_id, name, expires_at, created_at, updated_at) VALUES (1, 'main', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), (1, 'run', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')";

// Targets of `run`, with hashes that sort in insertion order.
const insertTargets =
	"WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM seq WHERE i < ?) INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path) SELECT 1, 'run', printf('%032d', i), '/nix/store/' || printf('%032d', i) || '-app' FROM seq";

const insertMainTarget =
	"INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path) VALUES (1, 'main', 'a', '/nix/store/a-app')";

const selectTriggers =
	"SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name";

const selectRoots =
	"SELECT cache_id, name, coalesce(expires_at, 'permanent') AS expires_at, incarnation IS NULL AS is_legacy FROM retention_root ORDER BY name";

const selectTargetSummary =
	'SELECT root_name, count(*) AS targets, count(incarnation) AS stamped, min(store_path_hash) AS first FROM retention_root_target GROUP BY root_name ORDER BY root_name';

const explainIncarnationRange =
	'EXPLAIN QUERY PLAN SELECT store_path_hash FROM retention_root_target WHERE incarnation = ? AND store_path_hash > ? ORDER BY store_path_hash LIMIT 128';

// The lookups of a name's rows without an incarnation, of a pending release
// of them, and of one drain page of that release.
const explainLegacyLookups = [
	'EXPLAIN QUERY PLAN SELECT cache_id FROM retention_root_target WHERE cache_id = ? AND root_name = ? AND incarnation IS NULL LIMIT 1',
	'EXPLAIN QUERY PLAN SELECT id FROM retention_root_release WHERE cache_id = ? AND root_name = ? AND incarnation IS NULL LIMIT 1',
	'EXPLAIN QUERY PLAN SELECT store_path_hash FROM retention_root_target WHERE cache_id = ? AND root_name = ? AND incarnation IS NULL LIMIT 128'
];

// Migrates a store with `targets` legacy targets under one root across 0084
// and returns what the migration cost and what it left.
async function migrateLegacyTargets(targets: number) {
	return runInDurableObject(
		testServerFor(`migration-root-incarnations-${String(targets)}`),
		async (_instance, state) => {
			await migrateThrough(state, beforeRootIncarnations);
			state.storage.sql.exec(insertRoots);
			state.storage.sql.exec(insertMainTarget);
			state.storage.sql.exec(insertTargets, targets);
			const triggersBefore = state.storage.sql.exec(selectTriggers).toArray();

			const meter = new DatabaseCostMeter();
			const migrated = await applyMigrations(
				drizzle(meteredStorage(state.storage, meter)),
				migrationsThrough(migrations, rootIncarnations)
			);
			meter.recordOutstanding();

			return {
				migrated,
				cost: { rowsRead: meter.rowsRead, rowsWritten: meter.rowsWritten },
				isTriggerListUnchanged:
					JSON.stringify(state.storage.sql.exec(selectTriggers).toArray()) ===
					JSON.stringify(triggersBefore),
				roots: state.storage.sql.exec(selectRoots).toArray(),
				targets: state.storage.sql.exec(selectTargetSummary).toArray(),
				releases: state.storage.sql
					.exec('SELECT * FROM retention_root_release')
					.toArray(),
				plan: Array.from(
					state.storage.sql.exec<{ detail: string }>(
						explainIncarnationRange,
						1,
						''
					),
					(row) => row.detail
				),
				legacyPlans: explainLegacyLookups.map((query) =>
					Array.from(
						state.storage.sql.exec<{ detail: string }>(query, 1, 'run'),
						(row) => row.detail
					)
				)
			};
		}
	);
}

function expectedMigration(
	targets: number,
	cost: { readonly rowsRead: number; readonly rowsWritten: number }
) {
	return {
		migrated: { kind: 'complete', hasCommitted: true },
		cost,
		isTriggerListUnchanged: true,
		roots: [
			{ cache_id: 1, name: 'main', expires_at: 'permanent', is_legacy: 1 },
			{
				cache_id: 1,
				name: 'run',
				expires_at: '2026-02-01T00:00:00.000Z',
				is_legacy: 1
			}
		],
		targets: [
			{ root_name: 'main', targets: 1, stamped: 0, first: 'a' },
			{
				root_name: 'run',
				targets,
				stamped: 0,
				first: '00000000000000000000000000000001'
			}
		],
		releases: [],
		plan: [
			'SEARCH retention_root_target USING COVERING INDEX retention_root_target_incarnation_idx (incarnation=? AND store_path_hash>?)'
		],
		legacyPlans: [
			[
				'SEARCH retention_root_target USING INDEX retention_root_target_legacy_idx (cache_id=? AND root_name=?)'
			],
			[
				'SEARCH retention_root_release USING COVERING INDEX retention_root_release_root_idx (cache_id=? AND root_name=? AND incarnation=?)'
			],
			[
				'SEARCH retention_root_target USING INDEX retention_root_target_legacy_idx (cache_id=? AND root_name=?)'
			]
		]
	};
}

describe('root incarnation migration', () => {
	it('builds the incarnation indexes over legacy targets, with one legacy-index entry for each target', async () => {
		const small = await migrateLegacyTargets(1000);
		const large = await migrateLegacyTargets(10_000);

		// Every existing target has a null incarnation, so the incarnation
		// index gets no entry and the legacy index gets one for each target.
		// The rows written are the targets plus a fixed 11.
		expect({ small, large }).toStrictEqual({
			small: expectedMigration(1000, { rowsRead: 3680, rowsWritten: 1011 }),
			large: expectedMigration(10_000, {
				rowsRead: 30_734,
				rowsWritten: 10_011
			})
		});
	});

	it('adds only the incarnation columns, their indexes and the release table', () => {
		expect(rootIncarnationsSnapshot).toStrictEqual({
			...cachePurgePrioritySnapshot,
			id: rootIncarnationsSnapshot.id,
			prevId: cachePurgePrioritySnapshot.id,
			tables: {
				...cachePurgePrioritySnapshot.tables,
				retention_root: rootIncarnationsSnapshot.tables.retention_root,
				retention_root_target:
					rootIncarnationsSnapshot.tables.retention_root_target,
				retention_root_release:
					rootIncarnationsSnapshot.tables.retention_root_release
			}
		});
		expect({
			root: rootIncarnationsSnapshot.tables.retention_root.columns.incarnation,
			target:
				rootIncarnationsSnapshot.tables.retention_root_target.columns
					.incarnation,
			index:
				rootIncarnationsSnapshot.tables.retention_root_target.indexes
					.retention_root_target_incarnation_idx,
			legacyIndex:
				rootIncarnationsSnapshot.tables.retention_root_target.indexes
					.retention_root_target_legacy_idx,
			releaseIndex:
				rootIncarnationsSnapshot.tables.retention_root_release.indexes
					.retention_root_release_root_idx
		}).toStrictEqual({
			root: {
				name: 'incarnation',
				type: 'integer',
				primaryKey: false,
				notNull: false,
				autoincrement: false
			},
			target: {
				name: 'incarnation',
				type: 'integer',
				primaryKey: false,
				notNull: false,
				autoincrement: false
			},
			index: {
				name: 'retention_root_target_incarnation_idx',
				columns: ['incarnation', 'store_path_hash'],
				isUnique: false,
				where: '"retention_root_target"."incarnation" IS NOT NULL'
			},
			legacyIndex: {
				name: 'retention_root_target_legacy_idx',
				columns: ['cache_id', 'root_name'],
				isUnique: false,
				where: '"retention_root_target"."incarnation" IS NULL'
			},
			releaseIndex: {
				name: 'retention_root_release_root_idx',
				columns: ['cache_id', 'root_name', 'incarnation'],
				isUnique: false
			}
		});
	});
});
