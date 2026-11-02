import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import {
	DatabaseCostMeter,
	meteredStorage
} from '../do/database-cost-meter.ts';
import { PublicationManifestCleanup } from '../do/publication-manifest-cleanup.ts';
import { prepareManifestWorkHolds } from '../do/publication-manifest-work-holds.ts';
import { withRowBudget } from '../do/row-budget.ts';
import { migrateThrough, testServerFor } from '../test-support.ts';

import { cacheIdSchema } from './cache.ts';
import * as schema from './schema.ts';

async function storageTest(
	name: string,
	body: (sql: SqlStorage, cleanup: PublicationManifestCleanup) => void
) {
	await runInDurableObject(
		testServerFor(`admission-storage-${name}`),
		async (_instance, state) => {
			await migrateThrough(state, 83);
			const database = drizzle(state.storage, { schema });
			body(state.storage.sql, new PublicationManifestCleanup(database));
		}
	);
}
function insert(sql: SqlStorage, id: string, name?: string) {
	if (name === undefined) {
		sql.exec(
			"INSERT INTO publication_manifest_admission VALUES (?,'default',NULL,1,NULL,'{}',?,'2026-01-01T00:00:00.000Z','2026-01-01T00:15:00.000Z')",
			id,
			`push-${id}`
		);
		return;
	}
	sql.exec(
		"INSERT INTO publication_manifest_admission VALUES (?,'named',?,1,NULL,'{}',?,'2026-01-01T00:00:00.000Z','2026-01-01T00:15:00.000Z')",
		id,
		name,
		`push-${id}`
	);
}

describe('publication manifest admission storage', () => {
	it('enforces destination shape and unique push identity without a cache or operation FK', async () => {
		await storageTest('constraints', (sql) => {
			insert(sql, 'first');
			insert(sql, 'named', 'destination');
			expect(() =>
				sql.exec(
					"INSERT INTO publication_manifest_admission SELECT 'duplicate',destination_kind,destination_name,cache_generation,cache_id,canonical_json,push_id,expires_at,prune_after FROM publication_manifest_admission WHERE operation_id = 'first'"
				)
			).toThrow();
			expect(() =>
				sql.exec(
					"UPDATE publication_manifest_admission SET destination_kind = 'default' WHERE operation_id = 'named'"
				)
			).toThrow();
			expect([
				...sql.exec('SELECT 1 FROM publication_manifest_admission')
			]).toHaveLength(2);
		});
	});
	it('uses indexed due lookup and bounded orphan-page cleanup', async () => {
		await storageTest('bounded', (sql, cleanup) => {
			insert(sql, 'orphan');
			for (let page = 0; page < 129; page += 1) {
				sql.exec(
					"INSERT INTO publication_manifest_operation_page VALUES ('orphan',?,'digest','{}')",
					page
				);
			}
			const plan = [
				...sql.exec(
					"EXPLAIN QUERY PLAN SELECT operation_id FROM publication_manifest_admission INDEXED BY publication_manifest_admission_prune_idx WHERE prune_after <= '2026-02-01' ORDER BY prune_after,operation_id LIMIT 1"
				)
			];
			expect(JSON.stringify(plan)).toContain(
				'publication_manifest_admission_prune_idx'
			);
			const now = isoTimestamp(new Date('2026-02-01T00:00:00.000Z'));
			expect(withRowBudget(() => cleanup.collect(now, 64), 0)).toBe(true);
			expect([
				...sql.exec(
					"SELECT 1 FROM publication_manifest_operation_page WHERE operation_id = 'orphan'"
				)
			]).toHaveLength(65);
			expect([
				...sql.exec('SELECT 1 FROM publication_manifest_admission')
			]).toHaveLength(1);
			withRowBudget(() => cleanup.collect(now, 64), 0);
			expect([
				...sql.exec(
					"SELECT 1 FROM publication_manifest_operation_page WHERE operation_id = 'orphan'"
				)
			]).toHaveLength(1);
			withRowBudget(() => cleanup.collect(now, 64), 0);
			expect([
				...sql.exec('SELECT 1 FROM publication_manifest_admission')
			]).toHaveLength(0);
		});
	});
	it('does not delete mapping pages of a live ensure operation', async () => {
		await storageTest('live', (sql, cleanup) => {
			insert(sql, 'live');
			sql.exec(
				"INSERT INTO publication_manifest_operation (id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) VALUES ('live','request','ensure',1,1,'{}','null','build-selection',1,'2026-03-01T00:00:00.000Z')"
			);
			sql.exec(
				"INSERT INTO publication_manifest_operation_page VALUES ('live',0,'digest','{}')"
			);
			withRowBudget(
				() =>
					cleanup.collect(
						isoTimestamp(new Date('2026-02-01T00:00:00.000Z')),
						64
					),
				0
			);
			expect([
				...sql.exec('SELECT 1 FROM publication_manifest_operation_page')
			]).toHaveLength(1);
		});
	});
	it('bounds stale work-hold evaluation independently of 100000 holds on one exact path', async () => {
		const costs = await Array.fromAsync([129, 100_000], async (count) => {
			const stub = testServerFor(`work-hold-cost-${String(count)}`);
			return runInDurableObject(stub, async (_instance, state) => {
				await migrateThrough(state, 83);
				state.storage.sql.exec(
					`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < ?) INSERT INTO publication_manifest_work_hold SELECT printf('%08d',n),printf('pub-%08d',n),1,1,'00000000000000000000000000000001','/nix/store/00000000000000000000000000000001-app','sha256:0000000000000000000000000000000000000000000000000000',1 FROM sequence`,
					count
				);
				const meter = new DatabaseCostMeter();
				const storage = meteredStorage(state.storage, meter);
				const database = drizzle(storage, { schema });
				const cache = {
					id: cacheIdSchema.parse(1),
					generation: cacheGenerationSchema.parse(1),
					scope: { kind: 'default' as const },
					access: 'public' as const
				};
				const path = {
					storePathHash: storePathHashSchema.parse(
						'00000000000000000000000000000001'
					),
					storePath: storePathSchema.parse(
						'/nix/store/00000000000000000000000000000001-app'
					),
					narHash: nixSha256HashSchema.parse(
						'sha256:0000000000000000000000000000000000000000000000000000'
					),
					generation: narInfoGenerationSchema.parse(1)
				};
				const now = isoTimestamp(new Date());
				expect(
					prepareManifestWorkHolds(database, cache, [path], now, 128)
				).toBe(0);
				meter.recordOutstanding();
				expect([
					...state.storage.sql.exec(
						'SELECT 1 FROM publication_manifest_work_hold'
					)
				]).toHaveLength(count - 128);
				return { rowsRead: meter.rowsRead, rowsWritten: meter.rowsWritten };
			});
		});
		expect(costs[0]).toEqual(costs[1]);
		expect(costs[1]?.rowsRead).toBeLessThan(3000);
		expect(costs[1]?.rowsWritten).toBe(128);
	});
	it('retires work holds in bounded pages before removing an admission', async () => {
		await storageTest('hold-retirement', (sql, cleanup) => {
			insert(sql, 'retired-holds');
			sql.exec(
				`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < 129) INSERT INTO publication_manifest_work_hold SELECT 'retired-holds',printf('pub-%08d',n),1,1,'path','/nix/store/path-app','nar',1 FROM sequence`
			);
			const now = isoTimestamp(new Date('2026-02-01T00:00:00.000Z'));
			withRowBudget(() => cleanup.collect(now, 64), 0);
			expect([
				...sql.exec('SELECT 1 FROM publication_manifest_work_hold')
			]).toHaveLength(65);
			expect([
				...sql.exec('SELECT 1 FROM publication_manifest_admission')
			]).toHaveLength(1);
			withRowBudget(() => cleanup.collect(now, 64), 0);
			expect([
				...sql.exec('SELECT 1 FROM publication_manifest_work_hold')
			]).toHaveLength(1);
			withRowBudget(() => cleanup.collect(now, 64), 0);
			expect([
				...sql.exec('SELECT 1 FROM publication_manifest_admission')
			]).toHaveLength(0);
		});
	});
});
