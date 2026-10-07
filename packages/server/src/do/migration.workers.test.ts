import {
	firstCacheGeneration,
	graceSecondsSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { cacheSummarySchema } from '@cupboard/protocol/caches';
import { oidcSubjectSchema, trustRuleIdSchema } from '@cupboard/protocol/oidc';
import {
	reuseViewNameSchema,
	reuseViewPrioritySchema,
	reuseViewRevisionSchema
} from '@cupboard/protocol/reuse-views';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import journal from '../../drizzle/meta/_journal.json' with { type: 'json' };
import retrySnapshot from '../../drizzle/meta/0069_snapshot.json' with { type: 'json' };
import creationDefaultsSnapshot from '../../drizzle/meta/0070_snapshot.json' with { type: 'json' };
import closeSnapshot from '../../drizzle/meta/0071_snapshot.json' with { type: 'json' };
import stagingCleanupSnapshot from '../../drizzle/meta/0072_snapshot.json' with { type: 'json' };
import refreshFamilyOwnerSnapshot from '../../drizzle/meta/0073_snapshot.json' with { type: 'json' };
import migrations from '../../drizzle/migrations.js';
import { cacheIdSchema, cacheScopeFromRow } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	legacyRefreshTokenFamilies,
	legacyRefreshTokenMembers,
	oidcTrust
} from '../db/schema.ts';
import { advanceCacheRetentionMigration } from '../migration/cache-retention.ts';
import {
	beforeCacheIdentityContract,
	bootstrap,
	currentServer,
	migrateThrough,
	migrateThroughConvertedCatalogue,
	testServerFor,
	useTestServer,
	withoutAlarmArming
} from '../test-support.ts';

import { runBoundedLocalMigration } from './bounded-migration.ts';
import { chunk } from './bulk.ts';
import {
	projectLocalCacheLifecycles,
	resetCacheLifecycleProjection
} from './cache-lifecycle-projection.ts';
import { ServerContext } from './context.ts';
import { DatabaseCostMeter, meteredStorage } from './database-cost-meter.ts';
import { barrierTriggers } from './garbage-collection-service.ts';
import { applyMigrations, migrationsThrough } from './migrate.ts';
import { localMigrationRecipe } from './migration-recipes.ts';

const insertSigningKey =
	"INSERT INTO signing_key (id, private_jwk_json, public_key, created_at) VALUES ('active', '{}', 'cupboard-1:cHVi', '2026-01-01T00:00:00.000Z')";

const insertSignedNarInfo =
	"INSERT INTO narinfo (store_path_hash, store_path, nar_hash, nar_size, file_hash, file_size, compression, references_json, sig, created_at) VALUES (?, ?, 'sha256:nar', 10, 'sha256:file', 20, 'zstd', '[]', ?, '2026-01-01T00:00:00.000Z')";

const insertUnsignedNarInfo =
	"INSERT INTO narinfo (store_path_hash, store_path, nar_hash, nar_size, file_hash, file_size, compression, references_json, created_at) VALUES (?, ?, 'sha256:nar', 10, 'sha256:file', 20, 'zstd', '[]', '2026-01-01T00:00:00.000Z')";

function rootGrantsJson(resources: unknown): string {
	return JSON.stringify([
		{ type: 'cupboard_cache', actions: ['root:set'], resources }
	]);
}

function insertRootGrantRule(id: string, resources: unknown): string {
	return `INSERT INTO oidc_trust (id, issuer, audience, claims_json, permitted_grants_json, created_at) VALUES ('${id}', 'https://issuer.example', 'https://cache.example', '{}', '${rootGrantsJson(resources)}', '2026-01-01T00:00:00.000Z')`;
}

function queued(storePathHash: string): unknown {
	return { store_path_hash: storePathHash };
}

describe('migrations', () => {
	it('adds a durable staging queue without changing pending state', async () => {
		const result = await runInDurableObject(
			testServerFor('migration-staging-cleanup'),
			async (_instance, state) => {
				await migrateThrough(state, 71);
				state.storage.sql.exec(
					"INSERT INTO pending_upload(id,cache_id,nar_hash,r2_key,metadata_json,created_at,expires_at) VALUES ('pending',1,'sha256:nar','staging/pending','{}','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')"
				);
				const before = state.storage.sql
					.exec('SELECT * FROM pending_upload')
					.toArray();
				const database = drizzle(state.storage);
				const migrated = await applyMigrations(
					database,
					migrationsThrough(migrations, 72)
				);
				const repeated = await applyMigrations(
					database,
					migrationsThrough(migrations, 72)
				);
				state.storage.sql.exec(
					"INSERT INTO staging_cleanup(cache_id,r2_key) VALUES (1,'staging/pending'),(2,'staging/pending')"
				);
				return {
					before,
					after: state.storage.sql
						.exec('SELECT * FROM pending_upload')
						.toArray(),
					migrated,
					repeated,
					queue: state.storage.sql
						.exec('SELECT * FROM staging_cleanup ORDER BY cache_id,r2_key')
						.toArray()
				};
			}
		);
		expect(result).toStrictEqual({
			before: result.before,
			after: result.before,
			migrated: { kind: 'complete', hasCommitted: true },
			repeated: { kind: 'complete', hasCommitted: false },
			queue: [
				{ cache_id: 1, r2_key: 'staging/pending' },
				{ cache_id: 2, r2_key: 'staging/pending' }
			]
		});
		expect(stagingCleanupSnapshot).toStrictEqual({
			...closeSnapshot,
			id: stagingCleanupSnapshot.id,
			prevId: closeSnapshot.id,
			tables: {
				...closeSnapshot.tables,
				cache_teardown: stagingCleanupSnapshot.tables.cache_teardown,
				staging_cleanup: stagingCleanupSnapshot.tables.staging_cleanup
			}
		});
	});
	it('leaves owner fields null for refresh families created before migration 0073', async () => {
		const result = await runInDurableObject(
			testServerFor('migration-refresh-family-owner'),
			async (_instance, state) => {
				await migrateThrough(state, 72);
				state.storage.sql.exec(
					"INSERT INTO refresh_session_family(id,active_member_id,generation,created_at,expires_at) VALUES ('family','member',3,'2026-01-01T00:00:00.000Z','2026-01-31T00:00:00.000Z')"
				);
				const database = drizzle(state.storage);
				const migrated = await applyMigrations(
					database,
					migrationsThrough(migrations, 73)
				);
				const repeated = await applyMigrations(
					database,
					migrationsThrough(migrations, 73)
				);
				return {
					migrated,
					repeated,
					families: state.storage.sql
						.exec(
							'SELECT id, active_member_id, generation, created_at, expires_at, issuer IS NULL AS issuer_unknown, subject IS NULL AS subject_unknown, rule IS NULL AS rule_unknown FROM refresh_session_family'
						)
						.toArray()
				};
			}
		);
		expect(result).toStrictEqual({
			migrated: { kind: 'complete', hasCommitted: true },
			repeated: { kind: 'complete', hasCommitted: false },
			families: [
				{
					id: 'family',
					active_member_id: 'member',
					generation: 3,
					created_at: '2026-01-01T00:00:00.000Z',
					expires_at: '2026-01-31T00:00:00.000Z',
					issuer_unknown: 1,
					subject_unknown: 1,
					rule_unknown: 1
				}
			]
		});
		expect(refreshFamilyOwnerSnapshot).toStrictEqual({
			...stagingCleanupSnapshot,
			id: refreshFamilyOwnerSnapshot.id,
			prevId: stagingCleanupSnapshot.id,
			tables: {
				...stagingCleanupSnapshot.tables,
				refresh_session_family:
					refreshFamilyOwnerSnapshot.tables.refresh_session_family
			}
		});
	});
	it('adds creation defaults after retry migration without changing predecessor state', async () => {
		const result = await runInDurableObject(
			testServerFor('migration-creation-defaults-after-retries'),
			async (_instance, state) => {
				await migrateThrough(state, 69);
				state.storage.sql.exec(
					"INSERT INTO pending_upload(rowid,id,cache_id,nar_hash,r2_key,metadata_json,created_at,expires_at,verdict,session_id,claimed_at,claim_owner,grace_decision_json,attach_root_name,recorded_verdict_json,settle_failures,settle_retry_after,last_settle_error,nar_refresh_pending,accepted_sequence,accepted_expires_at,commit_started_sequence,retry_started_active_ms,settle_exhaustion) VALUES (17,'admitted',1,'sha256:nar','staging/key','{}','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','committing','session','2026-01-02T00:00:00.000Z','upload-owner','{}','build','{}',7,'2026-01-03T00:00:00.000Z','verification-failed',1,101,'2098-01-01T00:00:00.000Z',102,5000,'attempt-limit')"
				);
				state.storage.sql.exec(
					"INSERT INTO attestation_inheritance(rowid,cache_id,store_path_hash,generation,nar_hash,source_predicate_type,source_digest,attempts,not_before,accepted_upload_id,accepted_sequence,accepted_expires_at,commit_started_sequence,queued_sequence,source_end_cache_id,source_end_generation,source_cache_id,source_generation,source_reference_generation,source_reference_complete,source_reference_cache_id,source_reference_end_generation,retry_started_active_ms,claim_owner) VALUES (19,1,'00000000000000000000000000000001',3,'sha256:nar','https://predicate.invalid/type','digest',7,'2026-01-03T00:00:00.000Z','admitted',101,'2098-01-01T00:00:00.000Z',102,103,104,105,106,107,108,1,109,110,5000,'inheritance-owner')"
				);
				const definitions = () =>
					state.storage.sql
						.exec(
							"SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name <> 'cache_creation_defaults' ORDER BY name"
						)
						.toArray();
				const data = () =>
					['pending_upload', 'attestation_inheritance', 'cache_identity'].map(
						(table) => ({
							table,
							rows: state.storage.sql
								.exec(`SELECT rowid,* FROM ${table} ORDER BY rowid`)
								.toArray()
						})
					);
				const beforeDefinitions = definitions();
				const beforeData = data();
				const migrated = await applyMigrations(
					drizzle(state.storage),
					migrationsThrough(migrations, 70)
				);
				return {
					migrated,
					beforeDefinitions,
					afterDefinitions: definitions(),
					beforeData,
					afterData: data(),
					defaults: state.storage.sql
						.exec('SELECT * FROM cache_creation_defaults')
						.toArray()
				};
			}
		);
		expect(result).toStrictEqual({
			migrated: { kind: 'complete', hasCommitted: true },
			beforeDefinitions: result.beforeDefinitions,
			afterDefinitions: result.beforeDefinitions,
			beforeData: result.beforeData,
			afterData: result.beforeData,
			defaults: []
		});
		expect(creationDefaultsSnapshot).toStrictEqual({
			...retrySnapshot,
			id: creationDefaultsSnapshot.id,
			prevId: retrySnapshot.id,
			tables: {
				...retrySnapshot.tables,
				cache_creation_defaults:
					creationDefaultsSnapshot.tables.cache_creation_defaults
			}
		});
	});

	it('bounds retry index construction over a preserved pending backlog', async () => {
		const result = await runInDurableObject(
			testServerFor('migration-retry-row-budget'),
			async (_instance, state) => {
				await migrateThrough(state, 68);
				state.storage.sql.exec(
					"WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<5000) INSERT INTO pending_upload(id,cache_id,nar_hash,r2_key,metadata_json,created_at,expires_at,verdict,last_settle_error) SELECT 'pending-'||i, 1,'sha256:nar','staging/key','{}','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','pending','old-error' FROM seq"
				);
				const meter = new DatabaseCostMeter();
				const migrated = await applyMigrations(
					drizzle(meteredStorage(state.storage, meter)),
					migrationsThrough(migrations, 69),
					{
						budget: {
							sourceRowsRemaining: 1,
							structuralOperationsRemaining: 365,
							freshStore: false
						}
					}
				);
				meter.recordOutstanding();
				return {
					migrated,
					bounded: meter.rowsRead + meter.rowsWritten <= 25_000,
					recorded: state.storage.sql
						.exec(
							"SELECT hash FROM __drizzle_migrations WHERE hash = '0069_retry_limits'"
						)
						.toArray()
				};
			}
		);
		expect(result).toStrictEqual({
			migrated: {
				kind: 'pending',
				migration: '0069_retry_limits',
				stage: 'copy-pending_upload',
				cursor: 1,
				sourceRows: 1,
				declaredSourceWrites: 1,
				hasCommitted: true
			},
			bounded: true,
			recorded: []
		});
	});

	it('preserves retry reservations and resets inheritance in bounded restartable pages', async () => {
		const uploads = Array.from({ length: 5000 }, (_, index) => ({
			rowid: index * 2 + 1,
			id: `upload-${String(index)}`,
			cache_id: 1,
			nar_hash: 'sha256:nar',
			r2_key: `staging/${String(index)}`,
			metadata_json: JSON.stringify({
				storePathHash: String(index).padStart(32, '0')
			}),
			created_at: '2026-01-01T00:00:00.000Z',
			expires_at: '2099-01-01T00:00:00.000Z',
			verdict: index % 2 === 0 ? 'pending' : 'committing',
			session_id: `session-${String(index)}`,
			claimed_at: '2026-01-01T00:00:00.000Z',
			claim_owner: index % 3 === 0 ? undefined : 'previous-owner',
			grace_decision_json: '{}',
			attach_root_name: 'build',
			recorded_verdict_json: index % 3 === 0 ? '{}' : undefined,
			settle_failures: index % 5,
			settle_retry_after:
				index % 2 === 0 ? undefined : '2026-01-02T00:00:00.000Z',
			last_settle_error:
				index % 2 === 0 ? undefined : 'https://secret.invalid/token',
			nar_refresh_pending: index % 2,
			accepted_sequence: index + 100,
			accepted_expires_at: '2098-01-01T00:00:00.000Z',
			commit_started_sequence: index + 200
		}));
		const inheritance = Array.from({ length: 5000 }, (_, index) => ({
			rowid: index * 2 + 1,
			cache_id: 1,
			store_path_hash: String(index).padStart(32, '0'),
			generation: index + 1,
			nar_hash: 'sha256:nar',
			attempts: 15,
			not_before: '2026-01-02T00:00:00.000Z',
			source_digest: String(index).padStart(64, 'a'),
			source_predicate_type: 'https://predicate.invalid/type',
			accepted_upload_id: `admitted-${String(index)}`,
			accepted_sequence: index + 100,
			accepted_expires_at: '2098-01-01T00:00:00.000Z',
			commit_started_sequence: index + 200,
			queued_sequence: index + 300,
			source_end_cache_id: index + 400,
			source_end_generation: index + 500,
			source_cache_id: index + 600,
			source_generation: index + 700,
			source_reference_generation: index + 800,
			source_reference_complete: index % 2,
			source_reference_cache_id: index + 900,
			source_reference_end_generation: index + 1000
		}));
		const result = await runInDurableObject(
			testServerFor('migration-retry-preservation'),
			async (_instance, state) => {
				await migrateThrough(state, 68);
				const insert = (table: string, rows: readonly object[]): void => {
					const row = rows[0];
					if (row === undefined) {
						throw new Error('The retry migration fixture has no rows');
					}
					const columns = Object.keys(row);
					for (const page of chunk(rows, 500)) {
						state.storage.sql.exec(
							`INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(', ')}) SELECT ${columns.map((column) => `json_extract(value, '$.${column}')`).join(', ')} FROM json_each(?)`,
							JSON.stringify(page)
						);
					}
				};
				insert('pending_upload', uploads);
				insert('attestation_inheritance', inheritance);
				const triggers = () =>
					state.storage.sql
						.exec(
							"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'pending_upload' ORDER BY name"
						)
						.toArray();
				const beforeTriggers = triggers();
				const inheritedIndexes = () =>
					Array.from(
						state.storage.sql.exec<{ name: string; sql: string }>(
							"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('pending_upload_inheritance_cutoff_idx', 'pending_upload_inheritance_path_idx') ORDER BY name"
						),
						(row) => ({
							...row,
							sql: row.sql.replaceAll('"pending_upload"', '`pending_upload`')
						})
					);
				const beforeIndexes = inheritedIndexes();
				let pages = 0;
				let isBounded = true;
				const rows = (table: string) =>
					Array.from(
						state.storage.sql.exec(
							`SELECT rowid, * FROM \`${table}\` ORDER BY rowid`
						),
						(row) =>
							Object.fromEntries(
								Object.entries(row).map(([column, value]) => [
									column,
									value ?? undefined
								])
							)
					);
				for (;;) {
					const meter = new DatabaseCostMeter();
					const migrated = await applyMigrations(
						drizzle(meteredStorage(state.storage, meter)),
						migrationsThrough(migrations, 69),
						{
							budget: {
								sourceRowsRemaining: 1000,
								structuralOperationsRemaining: 365,
								freshStore: false
							}
						}
					);
					meter.recordOutstanding();
					isBounded &&= meter.rowsRead + meter.rowsWritten <= 25_000;
					if (migrated.kind === 'complete') {
						return {
							migrated,
							bounded: isBounded,
							paged: pages > 1,
							uploads: rows('pending_upload'),
							inheritance: rows('attestation_inheritance'),
							beforeIndexes,
							afterIndexes: inheritedIndexes(),
							beforeTriggers,
							afterTriggers: triggers(),
							temporary: state.storage.sql
								.exec(
									"SELECT name FROM sqlite_master WHERE name LIKE '__bounded_%' OR name LIKE '__new_%' ORDER BY name"
								)
								.toArray(),
							indexPlans: [
								'pending_upload_fresh_ready_idx',
								'pending_upload_recorded_ready_idx',
								'pending_upload_exhausted_ready_idx'
							].map((index) =>
								Array.from(
									state.storage.sql.exec<{ detail: string }>(
										`EXPLAIN QUERY PLAN SELECT id FROM pending_upload INDEXED BY ${index} WHERE ${index === 'pending_upload_fresh_ready_idx' ? "(verdict = 'pending' OR verdict = 'committing') AND (recorded_verdict_json IS NULL OR claim_owner IS NULL) AND settle_exhaustion IS NULL" : index === 'pending_upload_recorded_ready_idx' ? 'recorded_verdict_json IS NOT NULL OR settle_exhaustion IS NOT NULL' : 'settle_exhaustion IS NOT NULL'} LIMIT 1`
									),
									({ detail }) => detail
								)
							)
						};
					}
					pages += 1;
				}
			}
		);
		expect(result).toStrictEqual({
			migrated: { kind: 'complete', hasCommitted: true },
			bounded: true,
			paged: true,
			uploads: uploads.map((upload) => ({
				...upload,
				last_settle_error:
					upload.last_settle_error === undefined
						? undefined
						: 'verification-failed',
				retry_started_active_ms: undefined,
				settle_exhaustion: undefined
			})),
			inheritance: inheritance.map((entry) => ({
				...entry,
				attempts: 0,
				retry_started_active_ms: undefined,
				claim_owner: undefined
			})),
			beforeIndexes: result.beforeIndexes,
			afterIndexes: result.beforeIndexes,
			beforeTriggers: result.beforeTriggers,
			afterTriggers: result.beforeTriggers,
			temporary: [],
			indexPlans: [
				['SCAN pending_upload USING INDEX pending_upload_fresh_ready_idx'],
				['SCAN pending_upload USING INDEX pending_upload_recorded_ready_idx'],
				['SCAN pending_upload USING INDEX pending_upload_exhausted_ready_idx']
			]
		});
	});

	it.each(['copy-pending_upload', 'copy-canonical-pending_upload'])(
		'preserves upload rollback writes during %s',
		async (stage) => {
			const result = await runInDurableObject(
				testServerFor(`migration-retry-rollback-${stage}`),
				async (_instance, state) => {
					await migrateThrough(state, 68);
					state.storage.sql.exec(
						"WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<1001) INSERT INTO pending_upload(id,cache_id,nar_hash,r2_key,metadata_json,created_at,expires_at,verdict) SELECT 'pending-'||i, 1,'sha256:nar','staging/key','{}','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','pending' FROM seq"
					);
					let page = await applyMigrations(
						drizzle(state.storage),
						migrationsThrough(migrations, 69)
					);
					while (page.kind === 'pending' && page.stage !== stage) {
						page = await applyMigrations(
							drizzle(state.storage),
							migrationsThrough(migrations, 69)
						);
					}
					if (page.kind !== 'pending') {
						throw new Error(
							`The retry migration did not pause during ${stage}.`
						);
					}
					const rollback = await applyMigrations(
						drizzle(state.storage),
						migrationsThrough(migrations, 68)
					);
					state.storage.sql.exec(
						"UPDATE pending_upload SET accepted_sequence = 101, accepted_expires_at = '2098-01-01T00:00:00.000Z', commit_started_sequence = 102, settle_failures = 7, last_settle_error = 'https://secret.invalid/token', claim_owner = NULL, recorded_verdict_json = '{}' WHERE rowid = 1"
					);
					state.storage.sql.exec('DELETE FROM pending_upload WHERE rowid = 2');
					state.storage.sql.exec(
						"INSERT INTO pending_upload(id,cache_id,nar_hash,r2_key,metadata_json,created_at,expires_at,verdict,accepted_sequence,accepted_expires_at,commit_started_sequence) VALUES ('rollback-added',1,'sha256:added','staging/added','{}','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','pending',201,'2098-01-01T00:00:00.000Z',202)"
					);
					const rows = () =>
						state.storage.sql
							.exec('SELECT rowid, * FROM pending_upload ORDER BY rowid')
							.toArray();
					const before = rows();
					let migrated = await applyMigrations(
						drizzle(state.storage),
						migrationsThrough(migrations, 69)
					);
					while (migrated.kind === 'pending') {
						migrated = await applyMigrations(
							drizzle(state.storage),
							migrationsThrough(migrations, 69)
						);
					}
					return { rollback, migrated, before, after: rows() };
				}
			);
			expect(result).toStrictEqual({
				rollback: { kind: 'complete', hasCommitted: false },
				migrated: { kind: 'complete', hasCommitted: true },
				before: result.before,
				after: result.before.map((row) => ({
					...row,
					last_settle_error:
						row.last_settle_error === 'https://secret.invalid/token'
							? 'verification-failed'
							: row.last_settle_error
				}))
			});
		}
	);

	it('projects bounded lifecycle pages before contraction', async () => {
		await useTestServer('expanded-lifecycle-projection');
		await bootstrap();
		await env.CUPBOARD_DB.batch(
			[
				'DROP VIEW cache_lifecycle',
				'ALTER TABLE cache_lifecycle_storage RENAME TO cache_lifecycle',
				'CREATE VIEW cache_lifecycle_storage AS SELECT * FROM cache_lifecycle',
				"UPDATE deployment_transition SET state = 'expanded', contracted_at = NULL WHERE id = 'blob-reference-read-authority'"
			].map((query) => env.CUPBOARD_DB.prepare(query))
		);
		try {
			const result = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const costs: { read: number; written: number }[] = [];
					const wrap = (
						statement: D1PreparedStatement,
						query: string
					): D1PreparedStatement =>
						new Proxy(statement, {
							get(source, field) {
								if (field === 'bind') {
									return (...values: unknown[]) =>
										wrap(source.bind(...values), query);
								}
								if (
									field === 'run' &&
									query.startsWith('insert into "cache_lifecycle"')
								) {
									return async () => {
										const response = await source.run();
										costs.push({
											read: response.meta.rows_read,
											written: response.meta.rows_written
										});
										return response;
									};
								}
								const value: unknown = Reflect.get(source, field, source);
								return typeof value === 'function'
									? (...arguments_: unknown[]): unknown =>
											Reflect.apply(value, source, arguments_)
									: value;
							}
						});
					const binding = new Proxy(env.CUPBOARD_DB, {
						get(target, field) {
							if (field === 'prepare') {
								return (query: string) => wrap(target.prepare(query), query);
							}
							const value: unknown = Reflect.get(target, field, target);
							return typeof value === 'function'
								? (...arguments_: unknown[]): unknown =>
										Reflect.apply(value, target, arguments_)
								: value;
						}
					});
					const context = new ServerContext(state, {
						...instance.context.env,
						CUPBOARD_DB: binding
					});
					state.storage.sql
						.exec(`WITH RECURSIVE source(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM source WHERE n < 73)
					INSERT INTO cache_identity(kind,name,access,priority,created_at)
					SELECT 'named', printf('project-%03d',n), 'public', 40, '2026-01-01T00:00:00.000Z' FROM source`);
					await resetCacheLifecycleProjection(context);
					const pages = [];
					for (let page = 0; page < 3; page++) {
						pages.push(
							await projectLocalCacheLifecycles(
								context,
								context.requireTenant()
							)
						);
					}
					const count = await env.CUPBOARD_DB.prepare(
						'SELECT count(*) AS count FROM cache_lifecycle'
					).first();
					return { pages, costs, count };
				}
			);
			expect(result).toStrictEqual({
				costs: [
					{ read: 35, written: 105 },
					{ read: 36, written: 108 },
					{ read: 2, written: 6 }
				],
				pages: [
					{
						lifecycles: [
							{
								scope: { kind: 'default' },
								generation: firstCacheGeneration,
								isLive: true
							}
						],
						projected: 35,
						hasMore: true,
						progressed: true
					},
					{ lifecycles: [], projected: 36, hasMore: true, progressed: true },
					{ lifecycles: [], projected: 2, hasMore: false, progressed: true }
				],
				count: { count: 74 }
			});
		} finally {
			await env.CUPBOARD_DB.batch(
				[
					'DROP VIEW cache_lifecycle_storage',
					'ALTER TABLE cache_lifecycle RENAME TO cache_lifecycle_storage',
					'CREATE VIEW cache_lifecycle AS SELECT * FROM cache_lifecycle_storage WHERE false',
					"UPDATE deployment_transition SET state = 'complete', contracted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'blob-reference-read-authority'"
				].map((query) => env.CUPBOARD_DB.prepare(query))
			);
		}
	});

	it('pages the protected-inheritance upgrade over 25,000 legacy rows per table', async () => {
		const result = await runInDurableObject(
			testServerFor('migration-protected-inheritance-scale'),
			async (instance, state) => {
				await migrateThrough(state, 67);
				state.storage.sql
					.exec(`WITH RECURSIVE rows(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 25000)
			INSERT INTO pending_upload(id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at, verdict) SELECT printf('legacy-%d', value), 1, 'sha256:legacy', 'staging/legacy', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z', CASE WHEN value % 2 = 0 THEN 'committing' ELSE NULL END FROM rows`);
				state.storage.sql
					.exec(`WITH RECURSIVE rows(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 25000)
			INSERT INTO attestation_inheritance(cache_id, store_path_hash, generation, nar_hash, not_before) SELECT 1, printf('%032d', value), 0, 'sha256:legacy', '2026-01-01T00:00:00.000Z' FROM rows`);
				state.storage.sql
					.exec(`WITH RECURSIVE rows(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 25000)
			INSERT INTO narinfo_deletion(cache_id, store_path_hash, generation, nar_hash, created_at) SELECT 1, printf('%032d', value), 0, 'sha256:legacy', '2026-01-01T00:00:00.000Z' FROM rows`);
				state.storage.sql.exec(
					`WITH RECURSIVE rows(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 25000) INSERT INTO narinfo(cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, generation, created_at) SELECT 1, printf('%032d', value), printf('/nix/store/%032d-legacy', value), 'sha256:legacy', value, '[]', value, '2026-01-01T00:00:00.000Z' FROM rows`
				);

				const tables = [
					'pending_upload',
					'attestation_inheritance',
					'narinfo_deletion',
					'narinfo'
				];
				const snapshots = tables.map((table) =>
					state.storage.sql
						.exec(`SELECT rowid, * FROM ${table} ORDER BY rowid`)
						.toArray()
				);
				const triggers = () =>
					state.storage.sql
						.exec(
							"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('pending_upload', 'attestation_inheritance', 'narinfo_deletion', 'narinfo') ORDER BY name"
						)
						.toArray();
				const beforeTriggers = triggers();
				const meter = instance.context.dbCost;
				let maxRead = 0;
				let maxWrite = 0;
				let invocations = 0;
				const page = async () => {
					meter.recordOutstanding();
					const before = {
						rowsRead: meter.rowsRead,
						rowsWritten: meter.rowsWritten
					};
					const result = await applyMigrations(
						instance.context.db,
						migrationsThrough(migrations, 68)
					);
					meter.recordOutstanding();
					maxRead = Math.max(maxRead, meter.rowsRead - before.rowsRead);
					maxWrite = Math.max(maxWrite, meter.rowsWritten - before.rowsWritten);
					invocations += 1;
					return result;
				};
				const first = await page();
				let next = first;
				while (next.kind === 'pending') {
					next = await page();
				}
				for (const [index, table] of tables.entries()) {
					const original = snapshots[index];
					if (original === undefined) {
						throw new Error('The migration must preserve every source table.');
					}
					const expected = original.map((row) => {
						if (table === 'narinfo') {
							return row;
						}
						if (table === 'pending_upload') {
							return {
								...row,
								accepted_sequence: 0,
								accepted_expires_at: row.expires_at,
								commit_started_sequence:
									row.verdict === 'committing' ? 0 : undefined
							};
						}
						if (table === 'narinfo_deletion') {
							return {
								...row,
								explicit: 0,
								protection_cutoff: undefined,
								protection_captured_at: undefined
							};
						}
						return {
							...row,
							accepted_upload_id: undefined,
							accepted_sequence: 0,
							accepted_expires_at: undefined,
							commit_started_sequence: undefined,
							queued_sequence: 0,
							source_end_cache_id: undefined,
							source_end_generation: undefined,
							source_cache_id: 0,
							source_generation: -1,
							source_reference_cache_id: 0,
							source_reference_end_generation: undefined,
							source_reference_generation: -1,
							source_reference_complete: 0
						};
					});
					const normalise = (rows: Record<string, unknown>[]) =>
						rows.map((row) =>
							Object.fromEntries(
								Object.entries(row).map(([key, value]) => [
									key,
									value ?? undefined
								])
							)
						);
					expect(
						normalise(
							state.storage.sql
								.exec(`SELECT rowid, * FROM ${table} ORDER BY rowid`)
								.toArray()
						)
					).toStrictEqual(normalise(expected));
				}
				expect(triggers()).toStrictEqual(beforeTriggers);
				expect(
					state.storage.sql
						.exec(
							"SELECT name FROM sqlite_master WHERE name LIKE '__bounded_%' AND name != '__bounded_migration_progress' ORDER BY name"
						)
						.toArray()
				).toStrictEqual([]);
				return { first, maxRead, maxWrite, invocations };
			}
		);
		expect(result).toStrictEqual({
			first: {
				kind: 'pending',
				migration: '0068_protected_inheritance',
				stage: 'copy-pending_upload',
				cursor: 1000,
				sourceRows: 1000,
				declaredSourceWrites: 1000,
				hasCommitted: true
			},
			maxRead: 11_496,
			maxWrite: 9053,
			invocations: 401
		});
	});

	it.each([
		{
			boundary: 'before',
			operation: 'INSERT OR REPLACE INTO `__new_pending_upload`'
		},
		{
			boundary: 'after',
			operation: 'INSERT OR REPLACE INTO `__new_pending_upload`'
		},
		{
			boundary: 'before',
			operation:
				'ALTER TABLE `pending_upload` RENAME TO `__bounded_old_pending_upload`'
		},
		{
			boundary: 'after',
			operation:
				'ALTER TABLE `pending_upload` RENAME TO `__bounded_old_pending_upload`'
		},
		{
			boundary: 'before',
			operation: 'DELETE FROM `__bounded_old_pending_upload`'
		},
		{
			boundary: 'after',
			operation: 'DELETE FROM `__bounded_old_pending_upload`'
		}
	])(
		'recovers the protected upgrade at the $boundary $operation storage boundary',
		async ({ boundary, operation }) => {
			await runInDurableObject(
				testServerFor(
					`migration-protection-${boundary}-${operation.slice(0, 6).trim().toLowerCase()}`
				),
				async (instance, state) => {
					await migrateThrough(state, 67);
					state.storage.sql.exec(
						"INSERT INTO pending_upload(id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at, verdict) VALUES ('legacy', 1, 'sha256:legacy', 'staging/legacy', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z', 'committing')"
					);
					const recipe = localMigrationRecipe(
						'0068_protected_inheritance',
						z
							.string()
							.parse(migrations.migrations.m0068)
							.split('--> statement-breakpoint')
							.map((statement) => statement.trim())
							.filter(Boolean)
					);
					if (recipe === undefined) {
						throw new Error('The upgrade must use a bounded migration recipe.');
					}
					const snapshot = () => {
						const objects = state.storage.sql
							.exec(
								"SELECT type, name, sql FROM sqlite_master WHERE name != '__bounded_migration_progress' ORDER BY type, name"
							)
							.toArray();
						const tables = state.storage.sql
							.exec<{ name: string }>(
								"SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%pending_upload' OR name LIKE '%attestation_inheritance' OR name LIKE '%narinfo_deletion') ORDER BY name"
							)
							.toArray();
						return {
							objects,
							tables: tables.map(({ name }) => ({
								name,
								rows: state.storage.sql
									.exec(`SELECT rowid, * FROM ${name} ORDER BY rowid`)
									.toArray()
							}))
						};
					};
					const original = instance.context.ctx.storage.sql.exec.bind(
						instance.context.ctx.storage.sql
					);
					let reached: ReturnType<typeof snapshot> | undefined;
					const injected = new Error('upgrade storage fault');
					const failing = vi
						.spyOn(instance.context.ctx.storage.sql, 'exec')
						.mockImplementation((query: string, ...parameters: unknown[]) => {
							if (
								reached === undefined &&
								operation.startsWith('ALTER TABLE') &&
								query.startsWith('DROP TRIGGER IF EXISTS')
							) {
								reached = snapshot();
							}
							if (!query.startsWith(operation)) {
								return original(query, ...parameters);
							}
							reached ??= snapshot();
							if (boundary === 'after') {
								original(query, ...parameters);
							}
							throw injected;
						});
					try {
						expect(() =>
							runBoundedLocalMigration(instance.context.db, recipe)
						).toThrow(expect.objectContaining({ cause: injected }));
					} finally {
						failing.mockRestore();
					}
					if (reached === undefined) {
						throw new Error(
							'The test must reach the specified storage operation.'
						);
					}
					expect(snapshot()).toStrictEqual(reached);
					let result = runBoundedLocalMigration(instance.context.db, recipe);
					while (result.kind === 'pending') {
						result = runBoundedLocalMigration(instance.context.db, recipe);
					}
					expect(
						state.storage.sql
							.exec(
								'SELECT id, accepted_sequence, accepted_expires_at, commit_started_sequence FROM pending_upload'
							)
							.toArray()
					).toStrictEqual([
						{
							id: 'legacy',
							accepted_sequence: 0,
							accepted_expires_at: '2026-01-01T00:30:00.000Z',
							commit_started_sequence: 0
						}
					]);
					expect(
						state.storage.sql
							.exec(
								"SELECT name FROM sqlite_master WHERE name LIKE '__bounded_%' AND name != '__bounded_migration_progress' ORDER BY name"
							)
							.toArray()
					).toStrictEqual([]);
				}
			);
		}
	);

	it.each(['copy-pending_upload', 'copy-canonical-pending_upload'])(
		'preserves legacy committing writes during the protected upgrade stage %s',
		async (stage) => {
			const result = await runInDurableObject(
				testServerFor(stage.replaceAll('_', '-')),
				async (instance, state) => {
					await migrateThrough(state, 67);
					state.storage.sql
						.exec(`WITH RECURSIVE rows(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 1001)
			INSERT INTO pending_upload(id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at) SELECT printf('legacy-%d', value), 1, 'sha256:legacy', 'staging/legacy', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z' FROM rows`);
					let page = await applyMigrations(instance.context.db, migrations);
					while (page.kind === 'pending' && page.stage !== stage) {
						page = await applyMigrations(instance.context.db, migrations);
					}
					if (page.kind !== 'pending') {
						throw new Error(
							'The migration must pause at the requested copy stage.'
						);
					}
					await applyMigrations(
						instance.context.db,
						migrationsThrough(migrations, 67)
					);
					state.storage.sql.exec(
						"UPDATE pending_upload SET verdict = 'committing' WHERE id = 'legacy-1'"
					);
					state.storage.sql.exec(
						"DELETE FROM pending_upload WHERE id = 'legacy-2'"
					);
					state.storage.sql.exec(
						"INSERT INTO pending_upload(id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at, verdict) VALUES ('legacy-extra', 1, 'sha256:extra', 'staging/extra', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:45:00.000Z', 'committing')"
					);
					do {
						page = await applyMigrations(instance.context.db, migrations);
					} while (page.kind === 'pending');
					return {
						count: state.storage.sql
							.exec('SELECT count(*) AS count FROM pending_upload')
							.one(),
						rows: state.storage.sql
							.exec(
								"SELECT id, accepted_sequence, accepted_expires_at, commit_started_sequence FROM pending_upload WHERE id IN ('legacy-1', 'legacy-2', 'legacy-extra') ORDER BY id"
							)
							.toArray()
					};
				}
			);
			expect(result).toStrictEqual({
				count: { count: 1001 },
				rows: [
					{
						id: 'legacy-1',
						accepted_sequence: 0,
						accepted_expires_at: '2026-01-01T00:30:00.000Z',
						commit_started_sequence: 0
					},
					{
						id: 'legacy-extra',
						accepted_sequence: 0,
						accepted_expires_at: '2026-01-01T00:45:00.000Z',
						commit_started_sequence: 0
					}
				]
			});
		}
	);

	it('refuses application reads until every protected-upgrade copy and drain completes', async () => {
		const tenant = tenantIdSchema.parse('protected-upgrade-admission');
		const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
		const d1 = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		await d1.insert(d1Schema.tenant).values({
			id: tenant,
			status: 'active',
			ownerIssuer: 'https://owner.test',
			ownerSubject: 'owner',
			ownerAudience: 'https://owner.test',
			configVersion: 1,
			createdAt: now
		});
		await d1.insert(d1Schema.cacheLifecycle).values({
			tenant,
			cacheKind: 'default',
			cacheName: sql`null`,
			access: 'public',
			generation: firstCacheGeneration,
			updatedAt: now
		});
		const server = testServerFor(tenant);
		const statuses = await withoutAlarmArming(
			() =>
				runInDurableObject(server, async (instance, state) => {
					await migrateThrough(state, 67);
					state.storage.sql.exec(
						"INSERT INTO tenant_identity(id, tenant, issuer, audience, owner_issuer, owner_subject, owner_audience, config_version) VALUES ('singleton', ?, 'https://tenant.test', 'https://tenant.test', 'https://owner.test', 'owner', 'https://owner.test', 1)",
						tenant
					);
					state.storage.sql
						.exec(`WITH RECURSIVE rows(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 1001)
			INSERT INTO pending_upload(id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at) SELECT printf('legacy-%d', value), 1, 'sha256:legacy', 'staging/legacy', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z' FROM rows`);
					const responses = [];
					for (let attempt = 0; attempt < 20; attempt += 1) {
						const response = await instance.fetch(
							new Request('https://tenant.test/nix-cache-info')
						);
						responses.push({
							status: response.status,
							retryAfter: response.headers.get('retry-after') ?? undefined
						});
						if (response.status === 200) {
							break;
						}
					}
					return responses;
				}),
			server
		);
		expect(statuses).toStrictEqual([
			{ status: 503, retryAfter: '1' },
			{ status: 503, retryAfter: '1' },
			{ status: 503, retryAfter: '1' },
			{ status: 503, retryAfter: '1' },
			{ status: 503, retryAfter: '1' },
			{ status: 503, retryAfter: '1' },
			{ status: 503, retryAfter: '1' },
			{ status: 503, retryAfter: '1' },
			{ status: 503, retryAfter: '1' },
			{ status: 503, retryAfter: '1' },
			{ status: 503, retryAfter: '1' },
			{ status: 503, retryAfter: '1' },
			{ status: 200, retryAfter: undefined }
		]);
	});

	it.each([1, 2000])(
		'creates minimal refresh metadata without rewriting %i legacy sessions',
		async (count) => {
			const result = await runInDurableObject(
				testServerFor(`refresh-authority-migration-${String(count)}`),
				async (_instance, state) => {
					await migrateThrough(state, 66);
					state.storage.sql.exec(
						"INSERT INTO refresh_token_family (id, active_member_id, generation, rule_id, subject, grants_json, created_at, expires_at) SELECT value, value, 0, 'owner', 'alice', '[{\"type\":\"cupboard_wildcard\"}]', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z' FROM json_each(?)",
						JSON.stringify(
							Array.from({ length: count }, (_, index) => String(index))
						)
					);
					const meter = new DatabaseCostMeter();
					const migrated = await applyMigrations(
						drizzle(meteredStorage(state.storage, meter)),
						migrationsThrough(migrations, 67)
					);
					meter.recordOutstanding();
					return {
						migrated,
						bounded: meter.rowsRead + meter.rowsWritten <= 500,
						legacyRows: state.storage.sql
							.exec<{ count: number }>(
								'SELECT count(*) AS count FROM refresh_token_family'
							)
							.one().count,
						queryPlan: Array.from(
							state.storage.sql.exec<{ detail: string }>(
								"EXPLAIN QUERY PLAN SELECT id FROM refresh_session_member INDEXED BY refresh_session_member_successor_expiry_idx WHERE successor_expires_at IS NOT NULL AND successor_expires_at < '2026-01-01T00:00:00.000Z' ORDER BY successor_expires_at, id LIMIT 128"
							),
							({ detail }) => detail
						)
					};
				}
			);
			expect(result).toStrictEqual({
				migrated: { kind: 'complete', hasCommitted: true },
				bounded: true,
				legacyRows: count,
				queryPlan: [
					'SEARCH refresh_session_member USING COVERING INDEX refresh_session_member_successor_expiry_idx (successor_expires_at>? AND successor_expires_at<?)'
				]
			});
		}
	);

	it('indexes narinfo refresh by NAR hash after upgrading', async () => {
		const plan = await runInDurableObject(
			testServerFor('migration-narinfo-refresh-index'),
			async (_instance, state) => {
				await migrateThrough(state, 65);
				await migrateThroughConvertedCatalogue(state);
				return Array.from(
					state.storage.sql.exec<{ detail: string }>(
						'EXPLAIN QUERY PLAN SELECT cache_id, store_path_hash FROM narinfo WHERE nar_hash = ? ORDER BY cache_id, store_path_hash LIMIT 100',
						'sha256:missing'
					),
					(row) => row.detail
				);
			}
		);
		expect(plan).toStrictEqual([
			'SEARCH narinfo USING COVERING INDEX narinfo_nar_hash_cache_id_store_path_hash_idx (nar_hash=?)'
		]);
	});

	it('preserves narinfo rows, rowids and triggers during a bounded index upgrade', async () => {
		const records = Array.from({ length: 1001 }, (_, index) => ({
			rowid: index * 2 + 1,
			cache_id: 1,
			store_path_hash: String(index).padStart(32, '0'),
			store_path: `/nix/store/${String(index).padStart(32, '0')}-upgrade`,
			nar_hash: 'sha256:upgrade',
			nar_size: 10,
			references_json: '[]',
			deriver: `/nix/store/${String(index).padStart(32, '0')}-deriver`,
			ca: 'fixed:r:sha256:upgrade',
			sigs_json: '["cupboard:signature"]',
			generation: index + 1,
			signature_generation: index + 2,
			pending_signature_generation: index + 3,
			created_at: '2026-09-27T12:00:00.000Z'
		}));
		const result = await runInDurableObject(
			testServerFor('migration-bounded-narinfo-index'),
			async (_instance, state) => {
				await migrateThrough(state, 65);
				state.storage.sql.exec(
					"INSERT INTO narinfo (rowid, cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, deriver, ca, sigs_json, generation, signature_generation, pending_signature_generation, created_at) SELECT json_extract(value, '$.rowid'), json_extract(value, '$.cache_id'), json_extract(value, '$.store_path_hash'), json_extract(value, '$.store_path'), json_extract(value, '$.nar_hash'), json_extract(value, '$.nar_size'), json_extract(value, '$.references_json'), json_extract(value, '$.deriver'), json_extract(value, '$.ca'), json_extract(value, '$.sigs_json'), json_extract(value, '$.generation'), json_extract(value, '$.signature_generation'), json_extract(value, '$.pending_signature_generation'), json_extract(value, '$.created_at') FROM json_each(?)",
					JSON.stringify(records)
				);
				const triggers = () =>
					state.storage.sql
						.exec(
							"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'narinfo' ORDER BY name"
						)
						.toArray();
				const beforeTriggers = triggers();
				const counts = () =>
					state.storage.sql.exec('SELECT * FROM cache_narinfo_count').toArray();
				const beforeCounts = counts();
				const first = await applyMigrations(
					drizzle(state.storage),
					migrationsThrough(migrations, 66)
				);
				await migrateThrough(state, 66);
				return {
					first,
					rows: state.storage.sql
						.exec('SELECT rowid, * FROM narinfo ORDER BY rowid')
						.toArray(),
					beforeTriggers,
					afterTriggers: triggers(),
					beforeCounts,
					afterCounts: counts()
				};
			}
		);
		expect(result).toStrictEqual({
			first: {
				kind: 'pending',
				migration: '0066_publication_recovery',
				stage: 'copy-narinfo',
				cursor: 1999,
				sourceRows: 1000,
				declaredSourceWrites: 1000,
				hasCommitted: true
			},
			rows: records,
			beforeTriggers: result.beforeTriggers,
			afterTriggers: result.beforeTriggers,
			beforeCounts: result.beforeCounts,
			afterCounts: result.beforeCounts
		});
	});

	it.each(['copy-narinfo', 'copy-canonical-narinfo'])(
		'preserves rollback writes during %s',
		async (stage) => {
			const result = await runInDurableObject(
				testServerFor(`migration-publication-rollback-${stage}`),
				async (_instance, state) => {
					await migrateThrough(state, 65);
					state.storage.sql.exec(
						"INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) SELECT 1, printf('%032d', value), '/nix/store/rollback', 'sha256:rollback', 10, '[]', '2026-01-01T00:00:00.000Z' FROM json_each(?)",
						JSON.stringify(Array.from({ length: 1001 }, (_, index) => index))
					);
					let page = await applyMigrations(
						drizzle(state.storage),
						migrationsThrough(migrations, 66)
					);
					while (page.kind === 'pending' && page.stage !== stage) {
						page = await applyMigrations(
							drizzle(state.storage),
							migrationsThrough(migrations, 66)
						);
					}
					if (page.kind !== 'pending') {
						throw new Error(`The migration did not pause during ${stage}.`);
					}
					const rollback = await applyMigrations(
						drizzle(state.storage),
						migrationsThrough(migrations, 65)
					);
					state.storage.sql.exec(
						'UPDATE narinfo SET sigs_json = \'["rollback:signature"]\' WHERE rowid = 1'
					);
					state.storage.sql.exec('DELETE FROM narinfo WHERE rowid = 2');
					state.storage.sql.exec(
						"INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) VALUES (1, 'rollback-added', '/nix/store/added', 'sha256:added', 10, '[]', '2026-01-01T00:00:00.000Z')"
					);
					const rows = () =>
						state.storage.sql
							.exec('SELECT rowid, * FROM narinfo ORDER BY rowid')
							.toArray();
					const before = rows();
					await migrateThrough(state, 66);
					return { rollback, before, after: rows() };
				}
			);
			expect(result).toStrictEqual({
				rollback: { kind: 'complete', hasCommitted: false },
				before: result.before,
				after: result.before
			});
		}
	);

	it('seeks directly after the narinfo refresh cursor', async () => {
		const plan = await runInDurableObject(
			testServerFor('migration-narinfo-refresh-cursor'),
			async (_instance, state) => {
				await migrateThroughConvertedCatalogue(state);
				return Array.from(
					state.storage.sql.exec<{ detail: string }>(
						'EXPLAIN QUERY PLAN SELECT cache_id, store_path_hash FROM narinfo WHERE nar_hash = ? AND (cache_id, store_path_hash) > (?, ?) ORDER BY cache_id, store_path_hash LIMIT 101',
						'sha256:missing',
						1,
						'a'.repeat(32)
					),
					(row) => row.detail
				);
			}
		);
		expect(plan).toStrictEqual([
			'SEARCH narinfo USING COVERING INDEX narinfo_nar_hash_cache_id_store_path_hash_idx (nar_hash=? AND (cache_id,store_path_hash)>(?,?))'
		]);
	});

	it('bounds rows read after a late narinfo refresh cursor', async () => {
		await useTestServer('migration-refresh-cursor-cost');
		await bootstrap();
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const narHash = nixSha256HashSchema.parse(`sha256:${'a'.repeat(52)}`);
				const paths = Array.from({ length: 1001 }, (_, index) =>
					String(index).padStart(32, '0')
				);
				state.storage.sql.exec(
					"INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) SELECT 1, value, '/nix/store/' || value || '-refresh', ?, 10, '[]', '2026-09-27T12:00:00.000Z' FROM json_each(?)",
					narHash,
					JSON.stringify(paths)
				);
				instance.context.dbCost.recordOutstanding();
				const before = instance.context.dbCost.rowsRead;
				const cursor = await instance.enqueueNarInfoReconciliation(narHash, {
					cacheId: cacheIdSchema.parse(1),
					storePathHash: storePathHashSchema.parse(
						String(900).padStart(32, '0')
					)
				});
				instance.context.dbCost.recordOutstanding();
				return {
					cursor,
					bounded: instance.context.dbCost.rowsRead - before <= 120
				};
			}
		);
		expect(result).toStrictEqual({ cursor: undefined, bounded: true });
	});

	it('preserves pending uploads and committed narinfo rows through attestation migrations', async () => {
		const server = testServerFor('migration-attestation-preservation');
		const migrated = await runInDurableObject(
			server,
			async (_instance, state) => {
				await migrateThrough(state, 63);
				const narInfoSchema = () => ({
					columns: state.storage.sql
						.exec('PRAGMA table_info(narinfo)')
						.toArray(),
					indexes: state.storage.sql
						.exec('PRAGMA index_list(narinfo)')
						.toArray(),
					rows: state.storage.sql.exec('SELECT * FROM narinfo').toArray()
				});
				state.storage.sql.exec(
					"INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) VALUES (1, '11111111111111111111111111111111', '/nix/store/11111111111111111111111111111111-publication', 'sha256:nar', 10, '[]', '2026-09-27T12:00:00.000Z')"
				);
				const before = narInfoSchema();
				state.storage.sql.exec(
					"INSERT INTO pending_upload (id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at) VALUES ('publication-upload', 1, 'sha256:nar', 'staging/publication-upload', '{}', '2026-09-27T12:00:00.000Z', '2026-09-27T12:15:00.000Z')"
				);
				const pendingUploadSchema = () => ({
					columns: state.storage.sql
						.exec('PRAGMA table_info(pending_upload)')
						.toArray(),
					rows: state.storage.sql.exec('SELECT * FROM pending_upload').toArray()
				});
				const beforeUploads = pendingUploadSchema();
				await migrateThrough(state, 65);
				return {
					before,
					unchanged: narInfoSchema(),
					beforeUploads,
					unchangedUploads: pendingUploadSchema()
				};
			}
		);

		expect(migrated).toStrictEqual({
			before: migrated.before,
			unchanged: migrated.before,
			beforeUploads: migrated.beforeUploads,
			unchangedUploads: migrated.beforeUploads
		});
	});

	it('preserves queued inheritance retries when adding the source cursor', async () => {
		const server = testServerFor('migration-inheritance-cursor');
		const queued = {
			cache_id: 1,
			store_path_hash: '1'.repeat(32),
			generation: 7,
			nar_hash: `sha256:${'1'.repeat(52)}`,
			attempts: 3,
			not_before: '2026-09-28T09:00:00.000Z'
		};
		const migrated = await runInDurableObject(
			server,
			async (_instance, state) => {
				await migrateThrough(state, 64);
				state.storage.sql.exec(
					'INSERT INTO attestation_inheritance (cache_id, store_path_hash, generation, nar_hash, attempts, not_before) VALUES (?, ?, ?, ?, ?, ?)',
					queued.cache_id,
					queued.store_path_hash,
					queued.generation,
					queued.nar_hash,
					queued.attempts,
					queued.not_before
				);
				await migrateThrough(state, 65);
				return state.storage.sql
					.exec(
						'SELECT cache_id, store_path_hash, generation, nar_hash, attempts, not_before, source_predicate_type IS NULL AND source_digest IS NULL AS unstarted FROM attestation_inheritance'
					)
					.toArray();
			}
		);
		expect(migrated).toStrictEqual([{ ...queued, unstarted: 1 }]);
	});

	it('preserves pending upload expiry and staging ownership through the paged bundle migration', async () => {
		const server = testServerFor('migration-attestation-bundles');
		const records = Array.from({ length: 1001 }, (_, index) => ({
			id: `bundle-${String(index)}`,
			cache_id: 1,
			store_path_hash: '1'.repeat(32),
			digest: 'a'.repeat(64),

			r2_key: `staging/bundle-${String(index)}`,
			created_at: '2026-09-27T12:00:00.000Z',
			expires_at: '2026-09-27T12:15:00.000Z'
		}));
		const migrated = await runInDurableObject(
			server,
			async (_instance, state) => {
				await migrateThrough(state, 63);
				const triggers = () =>
					state.storage.sql
						.exec(
							"SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'pending_attestation' ORDER BY name"
						)
						.toArray();
				const originalTriggers = triggers();
				state.storage.sql.exec(
					"INSERT INTO pending_attestation (id, cache_id, store_path_hash, digest, predicate_type, r2_key, created_at, expires_at) SELECT json_extract(value, '$.id'), json_extract(value, '$.cache_id'), json_extract(value, '$.store_path_hash'), json_extract(value, '$.digest'), NULL, json_extract(value, '$.r2_key'), json_extract(value, '$.created_at'), json_extract(value, '$.expires_at') FROM json_each(?)",
					JSON.stringify(records)
				);
				const first = await applyMigrations(
					drizzle(state.storage),
					migrationsThrough(migrations, 64)
				);
				await migrateThrough(state, 64);
				return {
					first: first.kind,
					originalTriggers,
					migratedTriggers: triggers(),
					rows: state.storage.sql
						.exec(
							'SELECT id, cache_id, store_path_hash, digest, r2_key, created_at, expires_at, validated_bundle_json IS NULL AS unvalidated FROM pending_attestation ORDER BY rowid'
						)
						.toArray()
				};
			}
		);
		expect(migrated).toStrictEqual({
			first: 'pending',
			originalTriggers: [
				{ name: 'managed_retirement_pending_attestation_delete' }
			],
			migratedTriggers: [
				{ name: 'managed_retirement_pending_attestation_delete' },
				{ name: 'pending_attestation_delete_subjects' }
			],
			rows: records.map((row) => ({
				...row,
				unvalidated: 1
			}))
		});
	});

	it('preserves a pre-0007 narinfo through the 0007 and 0008 table recreations', async () => {
		const server = testServerFor('migration-recreates');
		const signedHash = 'a'.repeat(32);
		const unsignedHash = 'b'.repeat(32);

		const migrated = await runInDurableObject(
			server,
			async (_instance, state) => {
				await migrateThrough(state, 6);

				state.storage.sql.exec(insertSigningKey);
				state.storage.sql.exec(
					insertSignedNarInfo,
					signedHash,
					`/nix/store/${signedHash}-pkg`,
					'cupboard-1:abc'
				);
				state.storage.sql.exec(
					insertUnsignedNarInfo,
					unsignedHash,
					`/nix/store/${unsignedHash}-pkg`
				);

				await migrateThroughConvertedCatalogue(state);

				return {
					narInfos: state.storage.sql
						.exec(
							'SELECT narinfo.store_path_hash, cache_identity.kind, narinfo.sigs_json FROM narinfo JOIN cache_identity ON cache_identity.id = narinfo.cache_id ORDER BY narinfo.store_path_hash'
						)
						.toArray(),
					signingKeys: state.storage.sql
						.exec('SELECT id, signing, published FROM signing_key')
						.toArray()
				};
			}
		);

		expect(migrated).toStrictEqual({
			narInfos: [
				{
					store_path_hash: signedHash,
					kind: 'default',
					sigs_json: '["cupboard-1:abc"]'
				},
				{ store_path_hash: unsignedHash, kind: 'default', sigs_json: '[]' }
			],
			signingKeys: [{ id: 'active', signing: 1, published: 1 }]
		});
	});

	it('seeds the default cache registry row idempotently on init', async () => {
		await useTestServer('migration-default-cache');
		await bootstrap();
		await bootstrap();

		const caches = await runInDurableObject(
			testServerFor('migration-default-cache'),
			(_instance, state) => {
				const rows = state.storage.sql
					.exec<{
						kind: 'default' | 'named';
						name: string | null;
						access: string | null;
						priority: number;
					}>(
						'SELECT kind, name, access, priority FROM cache_identity ORDER BY id'
					)
					.toArray();

				return rows.map((row) => ({
					cache: cacheScopeFromRow({
						kind: row.kind,
						name: row.name ?? undefined
					}),
					access: row.access ?? undefined,
					priority: row.priority
				}));
			}
		);

		expect(caches).toStrictEqual([
			{ cache: { kind: 'default' }, access: 'public', priority: 40 }
		]);
	});

	it('migrates a legacy retention policy onto the contracted shape', async () => {
		const rows = await runInDurableObject(
			testServerFor('migration-retention-policy'),
			async (_instance, state) => {
				await migrateThrough(state, 35);

				state.storage.sql.exec(
					"INSERT INTO retention_policy (id, scope, pattern, default_ttl_seconds, created_at) VALUES ('p1', 'root-name-prefix', 'pr-', 1209600, '2026-01-01T00:00:00.000Z')"
				);

				await migrateThroughConvertedCatalogue(state);

				const rows = state.storage.sql
					.exec<{ cacheId: number | null }>(
						'SELECT id, kind, cache_id AS cacheId, root_name_prefix AS rootNamePrefix, default_ttl_seconds AS defaultTtlSeconds, created_at AS createdAt FROM retention_policy'
					)
					.toArray();

				return rows.map((row) => ({
					...row,
					cacheId: row.cacheId ?? undefined
				}));
			}
		);

		expect(rows).toStrictEqual([
			{
				id: 'p1',
				kind: 'root-name-prefix',
				cacheId: undefined,
				rootNamePrefix: 'pr-',
				defaultTtlSeconds: 1_209_600,
				createdAt: '2026-01-01T00:00:00.000Z'
			}
		]);
	});

	it('keeps the newest retention policy for each selector', async () => {
		const rows = await runInDurableObject(
			testServerFor('migration-retention-policy-identity'),
			async (_instance, state) => {
				await migrateThrough(state, 35);

				state.storage.sql.exec(
					"INSERT INTO retention_policy (id, scope, pattern, default_ttl_seconds, created_at) VALUES ('old', 'root-name-prefix', 'pr-', 10, '2026-01-01T00:00:00.000Z')"
				);
				state.storage.sql.exec(
					"INSERT INTO retention_policy (id, scope, pattern, default_ttl_seconds, created_at) VALUES ('new', 'root-name-prefix', 'pr-', 20, '2026-01-02T00:00:00.000Z')"
				);

				await migrateThroughConvertedCatalogue(state);

				return state.storage.sql
					.exec(
						'SELECT id, default_ttl_seconds AS defaultTtlSeconds FROM retention_policy'
					)
					.toArray();
			}
		);

		expect(rows).toStrictEqual([{ id: 'new', defaultTtlSeconds: 20 }]);
	});

	it('clears legacy refresh state while retaining the preceding table', async () => {
		const migrated = await runInDurableObject(
			testServerFor('migration-refresh-token-families'),
			async (_instance, state) => {
				await migrateThrough(state, 37);

				state.storage.sql.exec(
					"INSERT INTO refresh_token (id, secret_hash, rule_id, subject, created_at, expires_at) VALUES ('live', 'hash', 'owner', 'alice', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')"
				);
				await migrateThroughConvertedCatalogue(state);

				const database = drizzle(state.storage, {
					schema: { legacyRefreshTokenFamilies, legacyRefreshTokenMembers }
				});
				const clearedLegacyRows = state.storage.sql
					.exec('SELECT id FROM refresh_token ORDER BY id')
					.toArray();
				const newTables = {
					families: state.storage.sql
						.exec('SELECT id FROM refresh_token_family ORDER BY id')
						.toArray(),
					members: state.storage.sql
						.exec('SELECT id FROM refresh_token_member ORDER BY id')
						.toArray()
				};
				const legacySchema = {
					liveColumns: state.storage.sql
						.exec(
							'SELECT cid, name, type, "notnull", dflt_value IS NULL AS has_no_default, pk FROM pragma_table_info("refresh_token")'
						)
						.toArray(),
					liveIndexes: state.storage.sql
						.exec('PRAGMA index_list(refresh_token)')
						.toArray(),
					liveExpiryIndex: state.storage.sql
						.exec('PRAGMA index_info(refresh_token_expires_at_idx)')
						.toArray()
				};

				state.storage.sql.exec(
					"INSERT INTO refresh_token (id, secret_hash, rule_id, subject, created_at, expires_at) VALUES ('old-live', 'live-hash', 'owner', 'alice', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'), ('old-expired', 'expired-hash', 'owner', 'alice', '2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z')"
				);
				const precedingWorkerLookup = state.storage.sql
					.exec(
						"SELECT id, secret_hash, rule_id, subject, created_at, expires_at FROM refresh_token WHERE id = 'old-live'"
					)
					.toArray();
				state.storage.sql.exec(
					"DELETE FROM refresh_token WHERE expires_at <= '2026-01-01T00:00:00.000Z'"
				);
				database.transaction((transaction) => {
					transaction
						.insert(legacyRefreshTokenFamilies)
						.values({
							id: 'new-family',
							activeMemberId: 'new-member',
							generation: 0,
							ruleId: trustRuleIdSchema.parse('owner'),
							subject: oidcSubjectSchema.parse('alice'),
							grantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }]),
							createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
							expiresAt: isoTimestampSchema.parse('2026-01-31T00:00:00.000Z')
						})
						.run();
					transaction
						.insert(legacyRefreshTokenMembers)
						.values({
							id: 'new-member',
							familyId: 'new-family',
							generation: 0,
							secretHash: 'new-hash',
							createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
						})
						.run();
				});
				const members = database
					.select()
					.from(legacyRefreshTokenMembers)
					.all()
					.map((member) => ({
						...member,
						successorEnvelope: member.successorEnvelope ?? undefined
					}));

				return {
					clearedLegacyRows,
					newTables,
					legacySchema,
					precedingWorkerLookup,
					families: database.select().from(legacyRefreshTokenFamilies).all(),
					members,
					legacyRows: {
						live: state.storage.sql
							.exec('SELECT id, secret_hash FROM refresh_token ORDER BY id')
							.toArray(),
						newMemberInLegacy: state.storage.sql
							.exec("SELECT id FROM refresh_token WHERE id = 'new-member'")
							.toArray()
					}
				};
			}
		);

		expect(migrated).toStrictEqual({
			clearedLegacyRows: [],
			newTables: { families: [], members: [] },
			legacySchema: {
				liveColumns: [
					{
						cid: 0,
						name: 'id',
						type: 'TEXT',
						notnull: 1,
						has_no_default: 1,
						pk: 1
					},
					{
						cid: 1,
						name: 'secret_hash',
						type: 'TEXT',
						notnull: 1,
						has_no_default: 1,
						pk: 0
					},
					{
						cid: 2,
						name: 'rule_id',
						type: 'TEXT',
						notnull: 1,
						has_no_default: 1,
						pk: 0
					},
					{
						cid: 3,
						name: 'subject',
						type: 'TEXT',
						notnull: 1,
						has_no_default: 1,
						pk: 0
					},
					{
						cid: 4,
						name: 'created_at',
						type: 'TEXT',
						notnull: 1,
						has_no_default: 1,
						pk: 0
					},
					{
						cid: 5,
						name: 'expires_at',
						type: 'TEXT',
						notnull: 1,
						has_no_default: 1,
						pk: 0
					}
				],
				liveIndexes: [
					{
						seq: 0,
						name: 'refresh_token_expires_at_idx',
						unique: 0,
						origin: 'c',
						partial: 0
					},
					{
						seq: 1,
						name: 'sqlite_autoindex_refresh_token_1',
						unique: 1,
						origin: 'pk',
						partial: 0
					}
				],
				liveExpiryIndex: [{ seqno: 0, cid: 5, name: 'expires_at' }]
			},
			precedingWorkerLookup: [
				{
					id: 'old-live',
					secret_hash: 'live-hash',
					rule_id: 'owner',
					subject: 'alice',
					created_at: '2026-01-01T00:00:00.000Z',
					expires_at: '2099-01-01T00:00:00.000Z'
				}
			],
			families: [
				{
					id: 'new-family',
					activeMemberId: 'new-member',
					generation: 0,
					ruleId: 'owner',
					subject: 'alice',
					grantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }]),
					createdAt: '2026-01-01T00:00:00.000Z',
					expiresAt: '2026-01-31T00:00:00.000Z'
				}
			],
			members: [
				{
					id: 'new-member',
					familyId: 'new-family',
					generation: 0,
					secretHash: 'new-hash',
					successorEnvelope: undefined,
					createdAt: '2026-01-01T00:00:00.000Z'
				}
			],
			legacyRows: {
				live: [{ id: 'old-live', secret_hash: 'live-hash' }],
				newMemberInLegacy: []
			}
		});
	});

	it('migrates and round-trips the verification cursor', async () => {
		const cursor = {
			id: 'active',
			cacheId: 1,
			lastStorePathHash: 'a'.repeat(32),
			updatedAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
		};

		const rows = await runInDurableObject(
			testServerFor('migration-verification-cursor'),
			async (_instance, state) => {
				await migrateThrough(state, beforeCacheIdentityContract);
				state.storage.sql.exec(
					"INSERT INTO cache_identity (id, kind, name, access, priority, created_at) VALUES (1, 'named', 'builds', 'public', 40, '2026-01-01T00:00:00.000Z')"
				);
				await migrateThroughConvertedCatalogue(state);

				state.storage.sql.exec(
					'INSERT INTO verification_cursor (id, cache_id, last_store_path_hash, updated_at) VALUES (?, ?, ?, ?)',
					cursor.id,
					cursor.cacheId,
					cursor.lastStorePathHash,
					cursor.updatedAt
				);

				return state.storage.sql
					.exec(
						'SELECT id, cache_id AS cacheId, last_store_path_hash AS lastStorePathHash, updated_at AS updatedAt FROM verification_cursor'
					)
					.toArray();
			}
		);

		expect(rows).toStrictEqual([cursor]);
	});

	it('gains the retention grace policy table at the latest migration', async () => {
		const policy = {
			id: 'g1',
			cachePrefix: 'pr-',
			graceSeconds: graceSecondsSchema.parse(86_400),
			createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
		};

		const rows = await runInDurableObject(
			testServerFor('migration-retention-grace-policy'),
			async (_instance, state) => {
				// Stops just short of 0027, the migration that creates the
				// grace-policy table, then applies the rest, so a seeded row can
				// only round-trip if that migration created it. The anchor is
				// fixed: a relative one would silently retarget the test at
				// whatever migration lands next.
				await migrateThrough(state, 26);
				await migrateThroughConvertedCatalogue(state);

				state.storage.sql.exec(
					'INSERT INTO retention_grace_policy (id, cache_prefix, grace_seconds, created_at) VALUES (?, ?, ?, ?)',
					policy.id,
					policy.cachePrefix,
					policy.graceSeconds,
					policy.createdAt
				);

				return state.storage.sql
					.exec(
						'SELECT id, cache_prefix AS cachePrefix, grace_seconds AS graceSeconds, created_at AS createdAt FROM retention_grace_policy'
					)
					.toArray();
			}
		);

		expect(rows).toStrictEqual([policy]);
	});

	it('gains the retention grace table and cache marker at the latest migration', async () => {
		const deadline = {
			storePathHash: storePathHashSchema.parse('a'.repeat(32)),
			retainUntil: isoTimestampSchema.parse('2026-06-01T00:00:00.000Z')
		};

		const migrated = await runInDurableObject(
			testServerFor('migration-retention-grace'),
			async (_instance, state) => {
				// A cache registered before the grace work exists in the old shape;
				// 0028 must add the marker column without touching it. The anchor
				// is fixed so later migrations cannot silently retarget the test.
				await migrateThrough(state, 27);
				state.storage.sql.exec(
					"INSERT INTO cache (name, priority, created_at) VALUES ('builds', 40, '2026-01-01T00:00:00.000Z')"
				);

				await migrateThroughConvertedCatalogue(state);

				const cacheId = state.storage.sql
					.exec<{ id: number }>(
						"SELECT id FROM cache_identity WHERE kind = 'named' AND name = 'builds'"
					)
					.one().id;
				state.storage.sql.exec(
					'INSERT INTO retention_grace (cache_id, store_path_hash, retain_until) VALUES (?, ?, ?)',
					cacheId,
					deadline.storePathHash,
					deadline.retainUntil
				);

				return {
					deadlines: state.storage.sql
						.exec(
							'SELECT store_path_hash AS storePathHash, retain_until AS retainUntil FROM retention_grace'
						)
						.toArray(),
					caches: state.storage.sql
						.exec(
							"SELECT name, grace_managed FROM cache_identity WHERE kind = 'named' ORDER BY name"
						)
						.toArray()
				};
			}
		);

		expect(migrated).toStrictEqual({
			deadlines: [deadline],
			caches: [{ name: 'builds', grace_managed: 0 }]
		});
	});

	it('adds a null grace decision to a pending upload created before 0029', async () => {
		const decision = await runInDurableObject(
			testServerFor('migration-grace-decision'),
			async (_instance, state) => {
				// A pending upload from before 0029 has no grace-decision column;
				// the migration must add it as NULL. The anchor is fixed so later
				// migrations cannot silently retarget the test.
				await migrateThrough(state, 28);
				state.storage.sql.exec(
					"INSERT INTO pending_upload (id, cache, nar_hash, r2_key, metadata_json, created_at, expires_at) VALUES ('u1', '', 'sha256:nar', 'staging/p/u1', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z')"
				);

				await migrateThroughConvertedCatalogue(state);

				const rows = state.storage.sql
					.exec('SELECT id, grace_decision_json FROM pending_upload')
					.toArray();

				return rows.map((row) => ({
					id: row.id,
					hasDecision: row.grace_decision_json !== null
				}));
			}
		);

		expect(decision).toStrictEqual([{ id: 'u1', hasDecision: false }]);
	});

	it('adds a null attach root to a pending upload created before 0033', async () => {
		const insertPreAttachPendingUpload =
			"INSERT INTO pending_upload (id, cache, nar_hash, r2_key, metadata_json, created_at, expires_at) VALUES ('u1', '', 'sha256:nar', 'staging/p/u1', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z')";
		const selectAttachRootNames =
			'SELECT id, attach_root_name FROM pending_upload';

		const migrated = await runInDurableObject(
			testServerFor('migration-attach-root'),
			async (_instance, state) => {
				// A pending upload from before 0033 has no attach-root column; the
				// migration must add it as NULL, the shape of a push that named no
				// root. The anchor is fixed so later migrations cannot silently
				// retarget the test.
				await migrateThrough(state, 32);
				state.storage.sql.exec(insertPreAttachPendingUpload);

				await migrateThroughConvertedCatalogue(state);

				const rows = state.storage.sql.exec(selectAttachRootNames).toArray();

				return rows.map((row) => ({
					id: row.id,
					hasAttachRoot: row.attach_root_name !== null
				}));
			}
		);

		expect(migrated).toStrictEqual([{ id: 'u1', hasAttachRoot: false }]);
	});

	it('leaves recorded_verdict_json null for a pending upload created before 0041', async () => {
		const insertPreVerdictPendingUpload =
			"INSERT INTO pending_upload (id, cache, nar_hash, r2_key, metadata_json, created_at, expires_at, verdict) VALUES ('u1', '', 'sha256:nar', 'staging/p/u1', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z', 'pending')";
		const selectRecordedVerdicts =
			'SELECT id, recorded_verdict_json FROM pending_upload';

		const migrated = await runInDurableObject(
			testServerFor('migration-recorded-verdict'),
			async (_instance, state) => {
				// A pending upload from before 0041 has no recorded-verdict column.
				// The migration must add it as NULL. The queue consumer treats NULL as
				// an upload without a verdict and can still claim the row. The anchor
				// is fixed so later migrations cannot
				// silently retarget the test.
				await migrateThrough(state, 40);
				state.storage.sql.exec(insertPreVerdictPendingUpload);

				await migrateThroughConvertedCatalogue(state);

				const rows = state.storage.sql.exec(selectRecordedVerdicts).toArray();

				return rows.map((row) => ({
					id: row.id,
					hasRecordedVerdict: row.recorded_verdict_json !== null
				}));
			}
		);

		expect(migrated).toStrictEqual([{ id: 'u1', hasRecordedVerdict: false }]);
	});

	it('migrates a pre-0034 sweep scan to the collect phase and then clears it', async () => {
		const insertCollectingScan =
			"INSERT INTO garbage_collection_scan (cache, revision, phase, cursor, reference_cursor, allow_empty_sweep) VALUES ('builds', 7, 'sweep', 'aa', -1, 1)";
		const selectRenamedScans =
			'SELECT cache, revision, phase, cursor, allow_empty_collection FROM garbage_collection_scan';
		const selectScans =
			'SELECT cache_id, phase, cursor, allow_empty_collection FROM garbage_collection_scan';

		const migrated = await runInDurableObject(
			testServerFor('migration-collect-phase'),
			async (_instance, state) => {
				// A collection interrupted before 0034 left a scan row naming the
				// phase `sweep` and holding its allow-empty flag in
				// `allow_empty_sweep`. The migration must rename the column and
				// rewrite the phase, so the interrupted collection resumes where it
				// stopped. The anchors are fixed so later migrations cannot silently
				// retarget the test.
				await migrateThrough(state, 33);
				state.storage.sql.exec(insertCollectingScan);

				await migrateThrough(state, 34);
				const renamed = state.storage.sql.exec(selectRenamedScans).toArray();

				// The migration that removed the revision also clears the collection
				// state, because a mark made under the revision regime was not
				// maintained by the write barrier that replaced it.
				await migrateThroughConvertedCatalogue(state);

				return {
					renamed,
					scans: state.storage.sql.exec(selectScans).toArray()
				};
			}
		);

		expect(migrated).toStrictEqual({
			renamed: [
				{
					cache: 'builds',
					revision: 7,
					phase: 'collect',
					cursor: 'aa',
					allow_empty_collection: 1
				}
			],
			scans: []
		});
	});

	it('fires the collection write barrier for every write that adds reachability', async () => {
		const cacheName = 'builds';
		const rootTargetHash = 'a'.repeat(32);
		const graceHash = 'b'.repeat(32);
		const markedHash = 'c'.repeat(32);
		const movedRootTargetHash = 'd'.repeat(32);
		const movedGraceHash = 'f'.repeat(32);
		const unscannedRootTargetHash = 'g'.repeat(32);
		const unscannedGraceHash = 'h'.repeat(32);
		const unmarkedHash = 'j'.repeat(32);
		const unmarkedInsertHash = 'k'.repeat(32);
		const retainUntil = '2026-06-01T00:00:00.000Z';
		const selectBarrierTriggers =
			"SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'garbage_collection_barrier_*'";
		const insertCacheIdentity =
			"INSERT INTO cache_identity (kind, name, access, priority, created_at) VALUES ('named', ?, 'public', 50, '2026-01-01T00:00:00.000Z')";
		const selectCacheIdentity =
			"SELECT id FROM cache_identity WHERE kind = 'named' AND name = ?";
		const selectFrontier =
			'SELECT store_path_hash FROM garbage_collection_frontier WHERE cache_id = ? ORDER BY store_path_hash';
		const clearFrontier =
			'DELETE FROM garbage_collection_frontier WHERE cache_id = ?';
		const insertScan =
			"INSERT INTO garbage_collection_scan (cache_id, phase) VALUES (?, 'mark')";
		const clearScan = 'DELETE FROM garbage_collection_scan WHERE cache_id = ?';
		const insertMark =
			'INSERT INTO garbage_collection_mark (cache_id, store_path_hash) VALUES (?, ?)';
		const clearMark = 'DELETE FROM garbage_collection_mark WHERE cache_id = ?';
		const insertRootTarget =
			"INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path) VALUES (?, 'main', ?, ?)";
		const moveRootTarget =
			'UPDATE retention_root_target SET store_path_hash = ? WHERE cache_id = ? AND store_path_hash = ?';
		const insertGrace =
			'INSERT INTO retention_grace (cache_id, store_path_hash, retain_until) VALUES (?, ?, ?)';
		const moveGrace =
			'UPDATE retention_grace SET store_path_hash = ? WHERE cache_id = ? AND store_path_hash = ?';
		const extendGrace =
			'UPDATE retention_grace SET retain_until = ? WHERE cache_id = ? AND store_path_hash = ?';
		const insertNarInfo =
			"INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, sigs_json, created_at) VALUES (?, ?, ?, 'sha256:nar', 10, '[]', '[]', '2026-01-01T00:00:00.000Z')";
		const updateNarInfoReferences =
			'UPDATE narinfo SET references_json = ? WHERE cache_id = ? AND store_path_hash = ?';
		const updateNarInfoSignatures =
			'UPDATE narinfo SET sigs_json = ? WHERE cache_id = ? AND store_path_hash = ?';

		const migrated = await runInDurableObject(
			testServerFor('migration-gc-barrier'),
			async (_instance, state) => {
				await migrateThroughConvertedCatalogue(state);

				const run = (
					query: string,
					...parameters: (string | number)[]
				): void => {
					state.storage.sql.exec(query, ...parameters);
				};

				state.storage.sql.exec(insertCacheIdentity, cacheName);
				const cache = state.storage.sql
					.exec<{ id: number }>(selectCacheIdentity, cacheName)
					.toArray()[0]?.id;

				if (cache === undefined) {
					throw new Error('the cache identity row did not persist');
				}

				const frontierAfter = (writes: () => void): unknown[] => {
					writes();
					const rows = state.storage.sql.exec(selectFrontier, cache).toArray();
					run(clearFrontier, cache);

					return rows;
				};

				run(insertScan, cache);

				return {
					triggers: Object.fromEntries(
						[
							...state.storage.sql.exec<{
								name: string;
								tbl_name: string;
							}>(selectBarrierTriggers)
						].map((trigger) => [trigger.name, trigger.tbl_name])
					),
					frontier: {
						seedInserts: frontierAfter(() => {
							run(
								insertRootTarget,
								cache,
								rootTargetHash,
								`/nix/store/${rootTargetHash}-app`
							);
							run(insertGrace, cache, graceHash, retainUntil);
						}),
						narInfoInsert: frontierAfter(() => {
							run(insertMark, cache, markedHash);
							run(
								insertNarInfo,
								cache,
								markedHash,
								`/nix/store/${markedHash}-app`
							);
						}),
						narInfoInsertUnmarked: frontierAfter(() => {
							run(
								insertNarInfo,
								cache,
								unmarkedInsertHash,
								`/nix/store/${unmarkedInsertHash}-app`
							);
						}),
						seedIdentityUpdates: frontierAfter(() => {
							run(moveRootTarget, movedRootTargetHash, cache, rootTargetHash);
							run(moveGrace, movedGraceHash, cache, graceHash);
						}),
						narInfoReferencesUpdate: frontierAfter(() => {
							run(
								updateNarInfoReferences,
								JSON.stringify([`${unmarkedHash}-child`]),
								cache,
								markedHash
							);
						}),
						narInfoSignatureUpdate: frontierAfter(() => {
							run(
								updateNarInfoSignatures,
								JSON.stringify(['cupboard-1:abc']),
								cache,
								markedHash
							);
						}),
						graceDeadlineExtension: frontierAfter(() => {
							run(
								extendGrace,
								'2026-07-01T00:00:00.000Z',
								cache,
								movedGraceHash
							);
						}),
						// Between scans there is no scan row and the mark table is empty,
						// so the same writes queue nothing.
						withoutScanOrMark: frontierAfter(() => {
							run(clearScan, cache);
							run(clearMark, cache);
							run(
								insertRootTarget,
								cache,
								unscannedRootTargetHash,
								`/nix/store/${unscannedRootTargetHash}-app`
							);
							run(insertGrace, cache, unscannedGraceHash, retainUntil);
							run(
								insertNarInfo,
								cache,
								unmarkedHash,
								`/nix/store/${unmarkedHash}-app`
							);
						})
					}
				};
			}
		);

		expect(migrated).toStrictEqual({
			triggers: Object.fromEntries(
				barrierTriggers.map((trigger) => [trigger.name, trigger.table])
			),
			frontier: {
				seedInserts: [queued(rootTargetHash), queued(graceHash)],
				narInfoInsert: [queued(markedHash)],
				narInfoInsertUnmarked: [],
				seedIdentityUpdates: [
					queued(movedRootTargetHash),
					queued(movedGraceHash)
				],
				narInfoReferencesUpdate: [queued(markedHash)],
				narInfoSignatureUpdate: [],
				graceDeadlineExtension: [],
				withoutScanOrMark: []
			}
		});
	});

	it('gains the reuse-view tables and narinfo index at the latest migration, leaving an existing narinfo row untouched', async () => {
		const storePathHash = 'a'.repeat(32);
		const narInfoRow = {
			kind: 'default',
			store_path_hash: storePathHash,
			store_path: `/nix/store/${storePathHash}-app`,
			nar_hash: 'sha256:nar',
			nar_size: 10,
			references_json: '[]',
			sigs_json: '[]',
			generation: 0,
			created_at: '2026-01-01T00:00:00.000Z'
		};
		const viewName = reuseViewNameSchema.parse('reuse');
		const view = {
			name: viewName,
			revision: reuseViewRevisionSchema.parse(1),
			priority: reuseViewPrioritySchema.parse(50),
			createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
			updatedAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
		};
		const selector = {
			view: viewName,
			kind: 'named' as const,
			cacheName: 'pr-1'
		};
		const revisionSeq = {
			name: viewName,
			nextRevision: reuseViewRevisionSchema.parse(2)
		};

		const migrated = await runInDurableObject(
			testServerFor('migration-reuse-views'),
			async (_instance, state) => {
				// A narinfo row committed before the reuse-view work exists in the
				// old shape; 0030 must add the new tables and index without
				// touching it. The anchor is fixed so later migrations cannot
				// silently retarget the test.
				await migrateThrough(state, 29);
				state.storage.sql.exec(
					"INSERT INTO narinfo (cache, store_path_hash, store_path, nar_hash, nar_size, references_json, sigs_json, created_at) VALUES ('', ?, ?, ?, ?, ?, ?, ?)",
					narInfoRow.store_path_hash,
					narInfoRow.store_path,
					narInfoRow.nar_hash,
					narInfoRow.nar_size,
					narInfoRow.references_json,
					narInfoRow.sigs_json,
					narInfoRow.created_at
				);

				await migrateThroughConvertedCatalogue(state);

				state.storage.sql.exec(
					"INSERT INTO reuse_view (name, access, revision, priority, created_at, updated_at) VALUES (?, 'public', ?, ?, ?, ?)",
					view.name,
					view.revision,
					view.priority,
					view.createdAt,
					view.updatedAt
				);
				state.storage.sql.exec(
					'INSERT INTO reuse_view_selector_native (view, kind, cache_name) VALUES (?, ?, ?)',
					selector.view,
					selector.kind,
					selector.cacheName
				);
				state.storage.sql.exec(
					'INSERT INTO reuse_view_revision_seq (name, next_revision) VALUES (?, ?)',
					revisionSeq.name,
					revisionSeq.nextRevision
				);

				const narinfoIndexRows = state.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'narinfo'"
					)
					.toArray();
				const narinfoIndexNames = narinfoIndexRows.map((row) => row.name);

				return {
					narInfos: state.storage.sql
						.exec(
							'SELECT cache_identity.kind, narinfo.store_path_hash, narinfo.store_path, narinfo.nar_hash, narinfo.nar_size, narinfo.references_json, narinfo.sigs_json, narinfo.generation, narinfo.created_at FROM narinfo JOIN cache_identity ON cache_identity.id = narinfo.cache_id'
						)
						.toArray(),
					views: state.storage.sql
						.exec(
							'SELECT name, revision, priority, created_at AS createdAt, updated_at AS updatedAt FROM reuse_view'
						)
						.toArray(),
					selectors: state.storage.sql
						.exec(
							'SELECT view, kind, cache_name AS cacheName FROM reuse_view_selector_native'
						)
						.toArray(),
					revisionSeqs: state.storage.sql
						.exec(
							'SELECT name, next_revision AS nextRevision FROM reuse_view_revision_seq'
						)
						.toArray(),
					hasNarinfoIndex: narinfoIndexNames.includes(
						'narinfo_store_path_hash_cache_idx'
					)
				};
			}
		);

		expect(migrated).toStrictEqual({
			narInfos: [narInfoRow],
			views: [view],
			selectors: [selector],
			revisionSeqs: [revisionSeq],
			hasNarinfoIndex: true
		});
	});

	it('adds the root-expiry index without changing existing roots or targets', async () => {
		const migrated = await runInDurableObject(
			testServerFor('migration-root-expiry-index'),
			async (_instance, state) => {
				await migrateThrough(state, 30);
				state.storage.sql.exec(
					"INSERT INTO retention_root (cache, name, expires_at, created_at, updated_at) VALUES ('builds', 'main', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
				);
				state.storage.sql.exec(
					"INSERT INTO retention_root_target (cache, root_name, store_path_hash, store_path) VALUES ('builds', 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app')"
				);

				await migrateThroughConvertedCatalogue(state);

				return {
					roots: state.storage.sql
						.exec(
							'SELECT cache_identity.name AS cache, retention_root.name, retention_root.expires_at FROM retention_root JOIN cache_identity ON cache_identity.id = retention_root.cache_id ORDER BY cache, retention_root.name'
						)
						.toArray(),
					targets: state.storage.sql
						.exec(
							'SELECT cache_identity.name AS cache, retention_root_target.root_name, retention_root_target.store_path_hash, retention_root_target.store_path FROM retention_root_target JOIN cache_identity ON cache_identity.id = retention_root_target.cache_id ORDER BY cache, retention_root_target.root_name, retention_root_target.store_path_hash'
						)
						.toArray(),
					indexes: state.storage.sql
						.exec(
							"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'retention_root' ORDER BY name"
						)
						.toArray()
				};
			}
		);

		expect(migrated).toStrictEqual({
			roots: [
				{
					cache: 'builds',
					name: 'main',
					expires_at: '2026-02-01T00:00:00.000Z'
				}
			],
			targets: [
				{
					cache: 'builds',
					root_name: 'main',
					store_path_hash: 'a'.repeat(32),
					store_path: `/nix/store/${'a'.repeat(32)}-app`
				}
			],
			indexes: [
				{ name: 'retention_root_cache_expires_at_name_idx' },
				{ name: 'retention_root_cache_retention_epoch_idx' },
				{ name: 'retention_root_close_applied_epoch_idx' },
				{ name: 'retention_root_expires_at_idx' },
				{ name: 'sqlite_autoindex_retention_root_1' }
			]
		});
	});

	it('migrates and round-trips an OIDC trust rule', async () => {
		const rule = {
			id: trustRuleIdSchema.parse('r1'),
			issuer: 'https://token.actions.githubusercontent.com',
			audience: 'https://cache.example.workers.dev',
			claimsJson: JSON.stringify({ repository_id: '1234' }),
			permittedGrantsJson: JSON.stringify([
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: { cache: { exact: 'ci', validate: 'cacheName' } }
				}
			]),
			displayJson: JSON.stringify({ repository: 'owner/repo' }),
			createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
			disabledAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
		};

		const rows = await runInDurableObject(
			testServerFor('migration-oidc-trust'),
			async (_instance, state) => {
				await migrateThroughConvertedCatalogue(state);

				const database = drizzle(state.storage, { schema: { oidcTrust } });
				database.insert(oidcTrust).values(rule).run();

				return database.select().from(oidcTrust).all();
			}
		);

		expect(rows).toStrictEqual([rule]);
	});

	// A root could be bound to the cache the grant names, with
	// `equalsResource: 'cache'`. That spelling has left the grant grammar, so
	// 0045 replaces it with the binding it stood for. The cache binding stays in
	// the selector spelling the row was stored in; only the root changes.
	it('replaces a root bound to the cache with an explicit binding', async () => {
		const boundRoot = { equalsResource: 'cache', validate: 'rootName' };
		const substitutions = {
			ref: {
				claim: 'ref',
				capture: { pattern: '^refs/pull/(?<ref>[0-9]+)/merge$', group: 'ref' }
			}
		};
		const seeded = {
			exact: { cache: { exact: 'ci', validate: 'cacheName' } },
			private: { cache: { exact: '_private-ci', validate: 'cacheName' } },
			default: { cache: { exact: '_default', validate: 'cacheName' } },
			'templated-default': {
				cache: { equalsTemplate: '_default', validate: 'cacheName' }
			},
			template: {
				cache: {
					equalsTemplate: 'pr-{ref}',
					substitutions,
					validate: 'cacheName'
				}
			},
			'private-template': {
				cache: { equalsTemplate: '_private-pr-{ref}', validate: 'cacheName' }
			}
		};

		const rewritten = await runInDurableObject(
			testServerFor('migration-cache-grant-root-binding'),
			async (_instance, state) => {
				await migrateThrough(state, 44);

				const statements = [
					...Object.entries(seeded).map(([id, resources]) =>
						insertRootGrantRule(id, { ...resources, root: boundRoot })
					),
					insertRootGrantRule('untouched', {
						cache: { exact: 'ci', validate: 'cacheName' },
						root: { exact: 'main', validate: 'rootName' }
					})
				];

				for (const statement of statements) {
					state.storage.sql.exec(statement);
				}

				await migrateThroughConvertedCatalogue(state);

				return state.storage.sql
					.exec('SELECT id, permitted_grants_json FROM oidc_trust ORDER BY id')
					.toArray();
			}
		);

		expect(rewritten).toStrictEqual([
			{
				id: 'default',
				permitted_grants_json: rootGrantsJson(seeded.default)
			},
			{
				id: 'exact',
				permitted_grants_json: rootGrantsJson({
					...seeded.exact,
					root: { exact: 'ci', validate: 'rootName' }
				})
			},
			{
				id: 'private',
				permitted_grants_json: rootGrantsJson({
					...seeded.private,
					root: { exact: 'ci', validate: 'rootName' }
				})
			},
			{
				id: 'private-template',
				permitted_grants_json: rootGrantsJson({
					...seeded['private-template'],
					root: { equalsTemplate: 'pr-{ref}', validate: 'rootName' }
				})
			},
			{
				id: 'template',
				permitted_grants_json: rootGrantsJson({
					...seeded.template,
					root: {
						equalsTemplate: 'pr-{ref}',
						substitutions,
						validate: 'rootName'
					}
				})
			},
			{
				id: 'templated-default',
				permitted_grants_json: rootGrantsJson(seeded['templated-default'])
			},
			{
				id: 'untouched',
				permitted_grants_json: rootGrantsJson({
					cache: { exact: 'ci', validate: 'cacheName' },
					root: { exact: 'main', validate: 'rootName' }
				})
			}
		]);
	});
	it('moves legacy retention settings onto each live cache', async () => {
		const migrated = await runInDurableObject(
			testServerFor('migration-cache-retention'),
			async (_instance, state) => {
				await migrateThrough(state, 41);
				state.storage.sql.exec(
					`INSERT INTO cache (name, priority, grace_managed, created_at) VALUES
						('', 40, 0, '2026-01-01T00:00:00.000Z'),
						('builds', 30, 1, '2026-01-01T00:00:00.000Z'),
						('pr-one', 20, 0, '2026-01-01T00:00:00.000Z'),
						('private/secret', 10, 0, '2026-01-01T00:00:00.000Z')`
				);

				await migrateThrough(state, 43);
				state.storage.sql.exec(
					"UPDATE cache_identity SET access = 'public' WHERE access IS NULL"
				);
				await migrateThrough(state, 46);

				const identities = state.storage.sql
					.exec('SELECT id, kind, name FROM cache_identity ORDER BY id')
					.toArray();
				const idFor = (name?: string): number => {
					const row = identities.find((identity) =>
						name === undefined
							? identity.kind === 'default'
							: identity.name === name
					);

					if (row === undefined || typeof row.id !== 'number') {
						throw new Error(
							`The migration fixture cache ${name ?? 'default'} is missing`
						);
					}

					return row.id;
				};
				const defaultId = idFor();
				const buildsId = idFor('builds');

				state.storage.sql.exec(
					"INSERT INTO cache_identity (kind, name, access, priority, grace_managed, created_at, deleted_at) VALUES ('named', 'deleted', 'public', 5, 1, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')"
				);
				state.storage.sql.exec(
					`INSERT INTO retention_policy (id, scope, pattern, kind, cache_id, root_name_prefix, default_ttl_seconds, created_at) VALUES
						('default', 'cache', '', 'cache', ?, NULL, 3600, '2026-01-01T00:00:00.000Z'),
						('builds', 'cache', 'builds', 'cache', ?, NULL, 7200, '2026-01-01T00:00:00.000Z'),
						('dangling', 'cache', 'gone', 'cache', 999999, NULL, 42, '2026-01-01T00:00:00.000Z'),
						('ci', 'root-name-prefix', 'ci/', 'root-name-prefix', NULL, 'ci/', 100, '2026-01-01T00:00:00.000Z'),
						('pr', 'root-name-prefix', 'pr/', 'root-name-prefix', NULL, 'pr/', 200, '2026-01-01T00:00:00.000Z')`,
					defaultId,
					buildsId
				);
				// Two prefix rules the new representation cannot hold: one too long
				// for a root name, one carrying a control character. The migration
				// counts them as discarded rather than refusing the whole tenant.
				state.storage.sql.exec(
					'INSERT INTO retention_policy (id, scope, pattern, kind, cache_id, root_name_prefix, default_ttl_seconds, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
					'inert-long',
					'root-name-prefix',
					'a'.repeat(257),
					'root-name-prefix',
					'a'.repeat(257),
					300,
					'2026-01-01T00:00:00.000Z'
				);
				state.storage.sql.exec(
					'INSERT INTO retention_policy (id, scope, pattern, kind, cache_id, root_name_prefix, default_ttl_seconds, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
					'inert-control',
					'root-name-prefix',
					'bad\n',
					'root-name-prefix',
					'bad\n',
					400,
					'2026-01-01T00:00:00.000Z'
				);
				state.storage.sql.exec(
					`INSERT INTO retention_grace_policy (id, cache_prefix, grace_seconds, created_at) VALUES
						('all', '', 50, '2026-01-01T00:00:00.000Z'),
						('pr', 'pr-', 100, '2026-01-01T00:00:00.000Z'),
						('pr-one', 'pr-one', 200, '2026-01-01T00:00:00.000Z')`
				);
				state.storage.sql.exec(
					"INSERT INTO retention_root (cache, cache_id, name, expires_at, created_at, updated_at) VALUES ('builds', ?, 'keep', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
					buildsId
				);
				state.storage.sql.exec(
					"INSERT INTO retention_grace (cache, cache_id, store_path_hash, retain_until) VALUES ('builds', ?, ?, '2099-02-01T00:00:00.000Z')",
					buildsId,
					'a'.repeat(32)
				);

				await migrateThroughConvertedCatalogue(state);
				const database = drizzle(state.storage, { schema });
				// A batch of two caches and two rules, so the backfill has to resume
				// from its cursor several times before it completes.
				let retentionMigration = await advanceCacheRetentionMigration(
					database,
					2
				);

				while (retentionMigration.status === 'pending') {
					retentionMigration = await advanceCacheRetentionMigration(
						database,
						2
					);
				}

				expect(await advanceCacheRetentionMigration(database, 2)).toStrictEqual(
					retentionMigration
				);
				// A cache registered after the migration completed keeps the defaults
				// its row was created with.
				state.storage.sql.exec(
					"INSERT INTO cache_identity (kind, name, access, priority, created_at) VALUES ('named', 'future', 'public', 1, '2026-03-01T00:00:00.000Z')"
				);

				const overrides = state.storage.sql
					.exec(
						'SELECT cache_identity.id AS cache_id, root_retention_rule.root_prefix, root_retention_rule.kind, root_retention_rule.ttl_seconds FROM cache_identity JOIN root_retention_rule ON root_retention_rule.rule_set_id = cache_identity.root_retention_rule_set_id ORDER BY cache_identity.id, root_retention_rule.root_prefix'
					)
					.toArray();
				const summaryRows = state.storage.sql.exec<{
					id: number;
					kind: 'default' | 'named';
					name: string | null;
					access: SqlStorageValue;
					priority: SqlStorageValue;
					default_root_ttl_seconds: SqlStorageValue;
					grace_seconds: SqlStorageValue;
					grace_managed: SqlStorageValue;
				}>(
					'SELECT id, kind, name, access, priority, default_root_ttl_seconds, grace_seconds, grace_managed FROM cache_identity WHERE deleted_at IS NULL ORDER BY id'
				);
				const summaries = Array.from(summaryRows, (row) =>
					cacheSummarySchema.parse({
						scope: cacheScopeFromRow({
							kind: row.kind,
							name: row.name
						}),
						access: row.access,
						priority: row.priority,
						storePaths: 0,
						defaultRootRetention:
							row.default_root_ttl_seconds === null
								? { kind: 'permanent' }
								: {
										kind: 'duration',
										seconds: row.default_root_ttl_seconds
									},
						grace:
							row.grace_seconds === null
								? { kind: 'none' }
								: {
										kind: 'duration',
										graceSeconds: row.grace_seconds
									},
						rootRetentionOverrides: overrides
							.filter((override) => override.cache_id === row.id)
							.map((override) => ({
								rootPrefix: override.root_prefix,
								retention:
									override.kind === 'permanent'
										? { kind: 'permanent' }
										: {
												kind: 'duration',
												seconds: override.ttl_seconds
											}
							})),
						graceManaged: Boolean(row.grace_managed)
					})
				);

				return {
					summaries,
					roots: state.storage.sql
						.exec(
							'SELECT cache_id, name, expires_at, created_at, updated_at FROM retention_root'
						)
						.toArray(),
					deadlines: state.storage.sql
						.exec(
							'SELECT cache_id, store_path_hash, retain_until FROM retention_grace'
						)
						.toArray(),
					deleted: Array.from(
						state.storage.sql.exec<{
							default_root_ttl_seconds: SqlStorageValue;
							grace_seconds: SqlStorageValue;
						}>(
							"SELECT default_root_ttl_seconds, grace_seconds FROM cache_identity WHERE name = 'deleted'"
						),
						(row) => ({
							default_root_ttl_seconds:
								row.default_root_ttl_seconds ?? undefined,
							grace_seconds: row.grace_seconds ?? undefined
						})
					),
					legacyTables: state.storage.sql
						.exec(
							"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('retention_policy', 'retention_grace_policy') ORDER BY name"
						)
						.toArray(),
					buildsId,
					retentionMigration
				};
			}
		);

		expect(migrated).toStrictEqual({
			summaries: [
				{
					scope: { kind: 'default' },
					access: 'public',
					priority: 40,
					storePaths: 0,
					defaultRootRetention: { kind: 'duration', seconds: 3600 },
					grace: { kind: 'duration', graceSeconds: 50 },
					rootRetentionOverrides: [
						{
							rootPrefix: 'ci/',
							retention: { kind: 'duration', seconds: 100 }
						},
						{
							rootPrefix: 'pr/',
							retention: { kind: 'duration', seconds: 200 }
						}
					],
					graceManaged: false
				},
				{
					scope: { kind: 'named', name: 'builds' },
					access: 'public',
					priority: 30,
					storePaths: 0,
					defaultRootRetention: { kind: 'duration', seconds: 7200 },
					grace: { kind: 'duration', graceSeconds: 50 },
					rootRetentionOverrides: [
						{
							rootPrefix: 'ci/',
							retention: { kind: 'duration', seconds: 100 }
						},
						{
							rootPrefix: 'pr/',
							retention: { kind: 'duration', seconds: 200 }
						}
					],
					graceManaged: true
				},
				{
					scope: { kind: 'named', name: 'pr-one' },
					access: 'public',
					priority: 20,
					storePaths: 0,
					defaultRootRetention: { kind: 'permanent' },
					grace: { kind: 'duration', graceSeconds: 200 },
					rootRetentionOverrides: [
						{
							rootPrefix: 'ci/',
							retention: { kind: 'duration', seconds: 100 }
						},
						{
							rootPrefix: 'pr/',
							retention: { kind: 'duration', seconds: 200 }
						}
					],
					graceManaged: false
				},
				{
					scope: { kind: 'named', name: 'secret' },
					access: 'private',
					priority: 10,
					storePaths: 0,
					defaultRootRetention: { kind: 'permanent' },
					grace: { kind: 'none' },
					rootRetentionOverrides: [
						{
							rootPrefix: 'ci/',
							retention: { kind: 'duration', seconds: 100 }
						},
						{
							rootPrefix: 'pr/',
							retention: { kind: 'duration', seconds: 200 }
						}
					],
					graceManaged: false
				},
				{
					scope: { kind: 'named', name: 'future' },
					access: 'public',
					priority: 1,
					storePaths: 0,
					defaultRootRetention: { kind: 'permanent' },
					grace: { kind: 'none' },
					rootRetentionOverrides: [],
					graceManaged: false
				}
			],
			roots: [
				{
					cache_id: migrated.buildsId,
					name: 'keep',
					expires_at: '2099-01-01T00:00:00.000Z',
					created_at: '2026-01-01T00:00:00.000Z',
					updated_at: '2026-01-02T00:00:00.000Z'
				}
			],
			deadlines: [
				{
					cache_id: migrated.buildsId,
					store_path_hash: 'a'.repeat(32),
					retain_until: '2099-02-01T00:00:00.000Z'
				}
			],
			deleted: [
				{ default_root_ttl_seconds: undefined, grace_seconds: undefined }
			],
			legacyTables: [
				{ name: 'retention_grace_policy' },
				{ name: 'retention_policy' }
			],
			buildsId: migrated.buildsId,
			retentionMigration: { status: 'complete', discardedRuleCount: 2 }
		});
	});
});

it('adds close metadata after creation defaults without replacing predecessor schema', () => {
	const additions = new Map([
		['narinfo', { columns: ['retention_epoch'], indexes: [] }],
		[
			'cache_identity',
			{ columns: ['retention_epoch', 'close_history_cursor'], indexes: [] }
		],
		[
			'managed_cache_retirement',
			{ columns: ['retirement_started_at'], indexes: [] }
		],
		[
			'pending_upload',
			{
				columns: ['retention_epoch'],
				indexes: ['pending_upload_cache_retention_epoch_idx']
			}
		],
		[
			'retention_root',
			{
				columns: [
					'retention_epoch',
					'close_applied_epoch',
					'close_grace_until'
				],
				indexes: [
					'retention_root_cache_retention_epoch_idx',
					'retention_root_close_applied_epoch_idx'
				]
			}
		]
	]);
	const predecessorTables = Object.fromEntries(
		Object.entries(closeSnapshot.tables)
			.filter(([table]) => table !== 'cache_close_event')
			.map(([table, definition]) => {
				const added = additions.get(table);
				return [
					table,
					{
						...definition,
						columns: Object.fromEntries(
							Object.entries(definition.columns).filter(
								([column]) => !added?.columns.includes(column)
							)
						),
						indexes: Object.fromEntries(
							Object.entries(definition.indexes).filter(
								([index]) => !added?.indexes.includes(index)
							)
						)
					}
				];
			})
	);
	expect({
		...closeSnapshot,
		id: creationDefaultsSnapshot.id,
		prevId: creationDefaultsSnapshot.prevId,
		tables: predecessorTables
	}).toStrictEqual(creationDefaultsSnapshot);
	expect(closeSnapshot.prevId).toBe(creationDefaultsSnapshot.id);
	expect(
		journal.entries.filter((entry) => entry.idx <= 71).slice(-2)
	).toStrictEqual([
		{
			idx: 70,
			version: '6',
			when: 1_790_931_592_556,
			tag: '0070_cache_creation_defaults',
			breakpoints: true
		},
		{
			idx: 71,
			version: '6',
			when: 1_790_931_592_557,
			tag: '0071_cache_close',
			breakpoints: true
		}
	]);
});

it('adds admission epoch zero to existing narinfos without changing their publications', async () => {
	const result = await runInDurableObject(
		testServerFor('close-narinfo-admission'),
		async (_instance, state) => {
			await migrateThrough(state, 70);
			for (const rowid of [1, 2]) {
				const hash = String(rowid).repeat(32);
				state.storage.sql.exec(
					"INSERT INTO narinfo(rowid,cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (?,1,?,?,'sha256:old',10,'[]',?,'2026-01-01T00:00:00.000Z')",
					rowid,
					hash,
					`/nix/store/${hash}-existing`,
					rowid + 4
				);
			}
			const query =
				'SELECT rowid,cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at FROM narinfo ORDER BY rowid';
			const before = state.storage.sql.exec(query).toArray();
			await migrateThrough(state, 71);
			return {
				before,
				after: state.storage.sql.exec(query).toArray(),
				epochs: state.storage.sql
					.exec('SELECT rowid,retention_epoch FROM narinfo ORDER BY rowid')
					.toArray()
			};
		}
	);
	expect(result.after).toStrictEqual(result.before);
	expect(result.epochs).toStrictEqual([
		{ rowid: 1, retention_epoch: 0 },
		{ rowid: 2, retention_epoch: 0 }
	]);
});

it('adds close metadata within a one-row allowance for 5,000 roots, uploads and narinfos', async () => {
	const result = await runInDurableObject(
		testServerFor('close-bounded-indexes'),
		async (_instance, state) => {
			await migrateThrough(state, 70);
			const values = JSON.stringify(
				Array.from({ length: 5000 }, (_, index) => index)
			);
			state.storage.sql.exec(
				"INSERT INTO pending_upload(rowid,id,cache_id,nar_hash,r2_key,metadata_json,created_at,expires_at) SELECT value+1, 'upload-' || value, 1, 'sha256:old', 'staging/' || value, '{}', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z' FROM json_each(?)",
				values
			);
			state.storage.sql.exec(
				"INSERT INTO retention_root(rowid,cache_id,name,expires_at,created_at,updated_at) SELECT value+1,1,'root-' || value,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM json_each(?)",
				values
			);
			state.storage.sql.exec(
				"INSERT INTO narinfo(rowid,cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,created_at) SELECT value+1,1,'hash-' || value,'/nix/store/path-' || value,'sha256:old',10,'[]','2026-01-01T00:00:00.000Z' FROM json_each(?)",
				values
			);
			const indexes = () =>
				Array.from(
					state.storage.sql.exec<{ name: string; sql: string }>(
						"SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='pending_upload' AND sql IS NOT NULL AND name <> 'pending_upload_cache_retention_epoch_idx' ORDER BY name"
					),
					(row) => ({
						...row,
						sql: row.sql.replaceAll('"pending_upload"', '`pending_upload`')
					})
				);
			const beforeIndexes = indexes();
			const meter = new DatabaseCostMeter();
			const first = await applyMigrations(
				drizzle(meteredStorage(state.storage, meter)),
				migrations,
				{
					budget: { sourceRowsRemaining: 1, structuralOperationsRemaining: 365 }
				}
			);
			meter.recordOutstanding();
			const firstCost = meter.rowsRead + meter.rowsWritten;
			if (first.kind !== 'pending') {
				return { firstKind: first.kind, firstCost };
			}
			let arePassesBounded = true;
			for (;;) {
				const pageMeter = new DatabaseCostMeter();
				const page = await applyMigrations(
					drizzle(meteredStorage(state.storage, pageMeter)),
					migrations,
					{
						budget: {
							sourceRowsRemaining: 1000,
							structuralOperationsRemaining: 365,
							freshStore: false
						}
					}
				);
				pageMeter.recordOutstanding();
				arePassesBounded &&=
					pageMeter.rowsRead + pageMeter.rowsWritten <= 25_000;
				if (page.kind === 'complete') {
					break;
				}
			}
			return {
				arePassesBounded,
				firstKind: first.kind,
				firstSourceRows: first.sourceRows,
				bounded: firstCost <= 1000,
				narinfos: state.storage.sql
					.exec(
						'SELECT count(*) AS count, min(rowid) AS first, max(rowid) AS last, min(retention_epoch) AS firstEpoch, max(retention_epoch) AS lastEpoch FROM narinfo'
					)
					.toArray(),
				uploads: state.storage.sql
					.exec(
						'SELECT count(*) AS count, min(rowid) AS first, max(rowid) AS last, min(retention_epoch) AS epoch FROM pending_upload'
					)
					.toArray(),
				roots: state.storage.sql
					.exec(
						'SELECT count(*) AS count, min(rowid) AS first, max(rowid) AS last, min(retention_epoch) AS epoch, min(close_applied_epoch) AS applied, max(close_grace_until IS NOT NULL) AS hasGrace FROM retention_root'
					)
					.toArray(),
				plans: [
					'SELECT id FROM pending_upload WHERE cache_id=1 AND retention_epoch=0',
					'SELECT name FROM retention_root WHERE cache_id=1 AND retention_epoch=0',
					'SELECT name FROM retention_root WHERE cache_id=1 AND close_applied_epoch=0'
				].map((query) =>
					Array.from(
						state.storage.sql.exec<{ detail: string }>(
							`EXPLAIN QUERY PLAN ${query}`
						),
						(row) => row.detail
					)
				),
				beforeIndexes,
				afterIndexes: indexes(),
				shadows: state.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name GLOB '__new_*' OR name GLOB '__bounded_*'"
					)
					.toArray()
			};
		}
	);
	expect(result).toStrictEqual({
		arePassesBounded: true,
		firstKind: 'pending',
		firstSourceRows: 1,
		bounded: true,
		narinfos: [
			{ count: 5000, first: 1, last: 5000, firstEpoch: 0, lastEpoch: 0 }
		],
		uploads: [{ count: 5000, first: 1, last: 5000, epoch: 0 }],
		roots: [
			{ count: 5000, first: 1, last: 5000, epoch: 0, applied: 0, hasGrace: 0 }
		],
		plans: [
			[
				'SEARCH pending_upload USING INDEX pending_upload_cache_retention_epoch_idx (cache_id=? AND retention_epoch=?)'
			],
			[
				'SEARCH retention_root USING COVERING INDEX retention_root_cache_retention_epoch_idx (cache_id=? AND retention_epoch=?)'
			],
			[
				'SEARCH retention_root USING COVERING INDEX retention_root_close_applied_epoch_idx (cache_id=? AND close_applied_epoch=?)'
			]
		],
		beforeIndexes: result.beforeIndexes,
		afterIndexes: result.beforeIndexes,
		shadows: []
	});
});

it.each([
	'copy-pending_upload',
	'copy-retention_root',
	'copy-canonical-pending_upload',
	'copy-canonical-retention_root'
])('preserves rollback writes during close migration %s', async (stage) => {
	const result = await runInDurableObject(
		testServerFor(`close-rollback-${stage}`),
		async (_instance, state) => {
			await migrateThrough(state, 70);
			const sourceQueries = () =>
				['pending_upload', 'retention_root', 'narinfo'].map((table) => {
					const columns = Array.from(
						state.storage.sql.exec<{ name: string }>(
							`PRAGMA table_info(${table})`
						),
						(row) => `\`${row.name}\``
					);
					return `SELECT rowid, ${columns.join(', ')} FROM ${table} ORDER BY rowid`;
				});
			for (const rowid of [1, 2, 3]) {
				state.storage.sql.exec(
					"INSERT INTO pending_upload(rowid,id,cache_id,nar_hash,r2_key,metadata_json,created_at,expires_at) VALUES (?, ?, 1, 'sha256:old', 'staging/old', '{}', '2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')",
					rowid,
					`upload-${String(rowid)}`
				);
				state.storage.sql.exec(
					"INSERT INTO retention_root(rowid,cache_id,name,created_at,updated_at) VALUES (?,1,?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
					rowid,
					`root-${String(rowid)}`
				);
				state.storage.sql.exec(
					"INSERT INTO narinfo(rowid,cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,created_at) VALUES (?,1,?,?,'sha256:old',10,'[]','2026-01-01T00:00:00.000Z')",
					rowid,
					String(rowid).repeat(32),
					`/nix/store/${String(rowid).repeat(32)}-existing`
				);
			}
			state.storage.sql.exec(
				"UPDATE pending_upload SET verdict='committing', session_id='session', claimed_at='2026-01-01T00:00:00.000Z', claim_owner='owner', grace_decision_json='{}', attach_root_name='ci/run', recorded_verdict_json='{}', settle_failures=3, settle_retry_after='2026-01-02T00:00:00.000Z', last_settle_error='retry', nar_refresh_pending=1, accepted_sequence=101, accepted_expires_at='2098-01-01T00:00:00.000Z', commit_started_sequence=102, retry_started_active_ms=5000, settle_exhaustion='attempt-limit'"
			);
			for (let pass = 0; pass < 40; pass++) {
				const progress = await applyMigrations(
					drizzle(state.storage),
					migrations,
					{
						budget: {
							sourceRowsRemaining: 1,
							structuralOperationsRemaining: 365
						}
					}
				);
				if (
					progress.kind === 'pending' &&
					progress.stage === stage &&
					progress.cursor === 1
				) {
					break;
				}
				if (pass === 39 || progress.kind === 'complete') {
					throw new Error(
						'Expected migration to stop in the requested copy stage'
					);
				}
			}
			const rollback = await applyMigrations(
				drizzle(state.storage),
				migrationsThrough(migrations, 70)
			);
			state.storage.sql.exec(
				"UPDATE pending_upload SET metadata_json=?, accepted_sequence=201, accepted_expires_at='2097-01-01T00:00:00.000Z', commit_started_sequence=202, retry_started_active_ms=6000, settle_exhaustion='eligible-age-limit' WHERE rowid=1",
				JSON.stringify({ updated: true })
			);
			state.storage.sql.exec(
				"UPDATE retention_root SET expires_at='2099-01-01T00:00:00.000Z' WHERE rowid=1"
			);
			state.storage.sql.exec('DELETE FROM pending_upload WHERE rowid=2');
			state.storage.sql.exec('DELETE FROM retention_root WHERE rowid=2');
			state.storage.sql.exec(
				'UPDATE narinfo SET retention_epoch=19 WHERE rowid=1'
			);
			state.storage.sql.exec('DELETE FROM narinfo WHERE rowid=2');
			state.storage.sql.exec(
				"INSERT INTO narinfo(rowid,cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,created_at) VALUES (88,1,?,'/nix/store/new','sha256:new',20,'[]','2026-01-01T00:00:00.000Z')",
				'8'.repeat(32)
			);
			state.storage.sql.exec(
				"INSERT INTO pending_upload(rowid,id,cache_id,nar_hash,r2_key,metadata_json,created_at,expires_at) VALUES (88,'new',1,'sha256:new','staging/new',?,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')",
				JSON.stringify({ new: true })
			);
			state.storage.sql.exec(
				"INSERT INTO retention_root(rowid,cache_id,name,created_at,updated_at) VALUES (88,1,'new','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')"
			);
			if (stage.startsWith('copy-canonical-')) {
				state.storage.sql.exec(
					'UPDATE pending_upload SET retention_epoch=19 WHERE rowid=1'
				);
				state.storage.sql.exec(
					"UPDATE retention_root SET retention_epoch=19, close_applied_epoch=18, close_grace_until='2098-01-01T00:00:00.000Z' WHERE rowid=1"
				);
			}
			const queries = sourceQueries();
			const before = queries.map((query) =>
				state.storage.sql.exec(query).toArray()
			);
			await migrateThrough(state, 71);
			return {
				before,
				after: queries.map((query) => state.storage.sql.exec(query).toArray()),
				rollback,
				uploads: state.storage.sql
					.exec(
						'SELECT rowid,id,metadata_json FROM pending_upload ORDER BY rowid'
					)
					.toArray(),
				roots: state.storage.sql
					.exec(
						"SELECT rowid,name,coalesce(expires_at, 'permanent') AS expires_at FROM retention_root ORDER BY rowid"
					)
					.toArray()
			};
		}
	);
	const { before, after, ...reported } = result;
	expect(after).toStrictEqual(before);
	expect(reported).toStrictEqual({
		rollback: { kind: 'complete', hasCommitted: false },
		uploads: [
			{
				rowid: 1,
				id: 'upload-1',
				metadata_json: JSON.stringify({ updated: true })
			},
			{ rowid: 3, id: 'upload-3', metadata_json: '{}' },
			{ rowid: 88, id: 'new', metadata_json: JSON.stringify({ new: true }) }
		],
		roots: [
			{ rowid: 1, name: 'root-1', expires_at: '2099-01-01T00:00:00.000Z' },
			{ rowid: 3, name: 'root-3', expires_at: 'permanent' },
			{ rowid: 88, name: 'new', expires_at: 'permanent' }
		]
	});
});
