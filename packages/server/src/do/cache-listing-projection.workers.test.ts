import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	latestMigrationIndex,
	migrateThrough,
	migrationIndexNamed,
	resetTestServer,
	testServerFor
} from '../test-support.ts';

import {
	CacheListingProjection,
	cacheListingProjectionRowsPerPass
} from './cache-listing-projection.ts';

describe('cache listing projection migration', () => {
	beforeEach(resetTestServer);

	it('backfills existing narinfo and grace rows in bounded passes', async () => {
		const observed = await runInDurableObject(
			testServerFor('cache-listing-backfill'),
			async (instance, state) => {
				await migrateThrough(
					state,
					migrationIndexNamed('0056_managed_cache_retirement')
				);
				state.storage.sql.exec(`
					WITH RECURSIVE seq(n) AS (
						SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 120
					)
					INSERT INTO narinfo
						(cache_id, store_path_hash, store_path, nar_hash, nar_size,
						 references_json, created_at)
					SELECT 1, printf('%032d', n), '/nix/store/path-' || n,
						'sha256:hash', 1, '[]', '2026-01-01T00:00:00.000Z'
					FROM seq
				`);
				state.storage.sql.exec(`
					INSERT INTO retention_grace (cache_id, store_path_hash, retain_until)
					SELECT cache_id, store_path_hash, '2099-01-01T00:00:00.000Z'
					FROM narinfo
				`);
				await migrateThrough(
					state,
					migrationIndexNamed('0057_cache_listing_projection')
				);
				const beforeIndexes = Array.from(
					state.storage.sql.exec<{ detail: string }>(
						'EXPLAIN QUERY PLAN SELECT 1 FROM pending_upload WHERE cache_id = ? LIMIT 1',
						3
					),
					(row) => row.detail
				);
				await migrateThrough(state, latestMigrationIndex);

				const projection = new CacheListingProjection(instance.context);
				const hasPendingBefore = projection.hasPending();
				projection.advance();
				const first = state.storage.sql
					.exec<{ count: number }>(
						'SELECT count FROM cache_narinfo_count WHERE cache_id = 1'
					)
					.one();
				const firstState = state.storage.sql
					.exec(
						'SELECT narinfo_cursor, narinfo_complete FROM cache_listing_projection_migration'
					)
					.one();
				state.storage.sql.exec(
					"DELETE FROM narinfo WHERE store_path_hash IN (printf('%032d', 1), printf('%032d', 100))"
				);
				state.storage.sql.exec(
					"UPDATE narinfo SET cache_id = 2 WHERE store_path_hash IN (printf('%032d', 2), printf('%032d', 99))"
				);
				state.storage.sql.exec(`
					INSERT INTO narinfo
						(cache_id, store_path_hash, store_path, nar_hash, nar_size,
						 references_json, created_at)
					VALUES (1, printf('%032d', 121), '/nix/store/path-121',
						'sha256:hash', 1, '[]', '2026-01-01T00:00:00.000Z')
				`);
				projection.advance();
				projection.advance();
				projection.advance();
				const firstGraceState = state.storage.sql
					.exec(
						'SELECT grace_cursor, grace_complete FROM cache_listing_projection_migration'
					)
					.one();
				state.storage.sql.exec(
					"DELETE FROM retention_grace WHERE store_path_hash IN (printf('%032d', 1), printf('%032d', 100))"
				);
				state.storage.sql.exec(
					"UPDATE retention_grace SET retain_until = '2098-01-01T00:00:00.000Z' WHERE store_path_hash IN (printf('%032d', 2), printf('%032d', 99))"
				);
				state.storage.sql.exec(
					"UPDATE retention_grace SET cache_id = 2 WHERE store_path_hash IN (printf('%032d', 2), printf('%032d', 99))"
				);
				state.storage.sql.exec(`
					INSERT INTO retention_grace (cache_id, store_path_hash, retain_until)
					VALUES (1, printf('%032d', 121), '2099-01-01T00:00:00.000Z')
				`);
				projection.advance();
				projection.advance();
				instance.context.dbCost.recordOutstanding();
				const rowsReadBeforeReady = instance.context.dbCost.rowsRead;
				const isReadyFirst = projection.isReady();
				instance.context.dbCost.recordOutstanding();
				const rowsReadAfterFirstReady = instance.context.dbCost.rowsRead;
				const isReadySecond = projection.isReady();
				instance.context.dbCost.recordOutstanding();
				const rowsReadAfterSecondReady = instance.context.dbCost.rowsRead;

				return {
					beforeIndexes,
					hasPendingBefore,
					first,
					firstState,
					firstGraceState,
					ready: {
						first: isReadyFirst,
						second: isReadySecond,
						firstRowsRead: rowsReadAfterFirstReady - rowsReadBeforeReady,
						secondRowsRead: rowsReadAfterSecondReady - rowsReadAfterFirstReady
					},
					state: state.storage.sql
						.exec(
							'SELECT narinfo_cursor, narinfo_complete, grace_cursor, grace_complete FROM cache_listing_projection_migration'
						)
						.one(),
					counts: state.storage.sql
						.exec('SELECT cache_id, count FROM cache_narinfo_count')
						.toArray(),
					grace: state.storage.sql
						.exec<{ count: number }>(
							'SELECT count(*) AS count FROM retention_grace_by_deadline'
						)
						.one(),
					graceDifference: state.storage.sql
						.exec<{ count: number }>(
							`
							SELECT count(*) AS count FROM (
								SELECT cache_id, store_path_hash, retain_until
								FROM retention_grace
								EXCEPT
								SELECT cache_id, store_path_hash, retain_until
								FROM retention_grace_by_deadline
							)
						`
						)
						.one()
				};
			}
		);

		expect(observed).toStrictEqual({
			beforeIndexes: [
				'SEARCH pending_upload USING COVERING INDEX pending_upload_gc_path_idx (cache_id=?)'
			],
			hasPendingBefore: true,
			first: { count: cacheListingProjectionRowsPerPass },
			firstState: { narinfo_cursor: 48, narinfo_complete: 0 },
			firstGraceState: { grace_cursor: 48, grace_complete: 0 },
			ready: {
				first: true,
				second: true,
				firstRowsRead: 1,
				secondRowsRead: 0
			},
			state: {
				narinfo_cursor: 120,
				narinfo_complete: 1,
				grace_cursor: 120,
				grace_complete: 1
			},
			counts: [
				{ cache_id: 1, count: 117 },
				{ cache_id: 2, count: 2 }
			],
			grace: { count: 119 },
			graceDifference: { count: 0 }
		});
	});
});
