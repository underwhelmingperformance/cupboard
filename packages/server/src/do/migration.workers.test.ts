import {
	graceSecondsSchema,
	storePathHashSchema
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
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import { cacheScopeFromRow } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import {
	oidcTrust,
	refreshTokenFamilies,
	refreshTokenMembers
} from '../db/schema.ts';
import { advanceCacheRetentionMigration } from '../migration/cache-retention.ts';
import {
	beforeCacheIdentityContract,
	bootstrap,
	migrateThrough,
	migrateThroughConvertedCatalogue,
	testServerFor,
	useTestServer
} from '../test-support.ts';

import { barrierTriggers } from './garbage-collection-service.ts';

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

// A frontier row as the barrier test reads it back. The query filters on the
// cache, so the row names only the path.
function queued(storePathHash: string): unknown {
	return { store_path_hash: storePathHash };
}

describe('migrations', () => {
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
					schema: { refreshTokenFamilies, refreshTokenMembers }
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
						.insert(refreshTokenFamilies)
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
						.insert(refreshTokenMembers)
						.values({
							id: 'new-member',
							familyId: 'new-family',
							generation: 0,
							secretHash: 'new-hash',
							createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
						})
						.run();
				});

				return {
					clearedLegacyRows,
					newTables,
					legacySchema,
					precedingWorkerLookup,
					families: database.select().from(refreshTokenFamilies).all(),
					members: database.select().from(refreshTokenMembers).all(),
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
		const retainUntil = '2026-06-01T00:00:00.000Z';
		const selectBarrierTriggers =
			"SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'garbage_collection_barrier_*'";
		const insertCacheIdentity =
			"INSERT INTO cache_identity (kind, name, access, priority, created_at) VALUES ('named', ?, 'public', 50, '2026-01-01T00:00:00.000Z')";
		const selectCacheIdentity =
			"SELECT id FROM cache_identity WHERE kind = 'named' AND name = ?";
		// The query filters on the cache, so a row's presence already says which
		// cache queued it and the assertion below names only the path.
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

				// Each stage runs the writes one trigger covers and reports the frontier
				// rows they produced. A present trigger can still protect nothing, so
				// the rows are what proves the barrier; the names below only say which
				// trigger is missing when one is.
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

	// Before 0044 a cache grant spelled the cache as a selector: `_default` for
	// the default cache and a `_private-` prefix for a private one. The rewrite
	// leaves the access out, because a cache carries its own access.
	it('rewrites the cache selectors stored in a grant', async () => {
		const storedRule = (id: string, cache: unknown) =>
			`INSERT INTO oidc_trust (id, issuer, audience, claims_json, permitted_grants_json, created_at) VALUES ('${id}', 'https://issuer.example', 'https://cache.example', '{}', '${JSON.stringify(
				[
					{
						type: 'cupboard_cache',
						actions: ['upload:commit'],
						resources: { cache }
					}
				]
			)}', '2026-01-01T00:00:00.000Z')`;
		const storedFamily = (id: string, cache: unknown) =>
			`INSERT INTO refresh_token_family (id, active_member_id, generation, rule_id, subject, grants_json, created_at, expires_at) VALUES ('${id}', 'm-${id}', 1, 'r1', 'alice', '${JSON.stringify(
				[{ type: 'cupboard_cache', actions: ['upload:commit'], cache }]
			)}', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`;

		const rewritten = await runInDurableObject(
			testServerFor('migration-cache-grant-json'),
			async (_instance, state) => {
				await migrateThrough(state, 43);

				const statements = [
					storedRule('named', { exact: 'ci', validate: 'cacheName' }),
					storedRule('default', { exact: '_default', validate: 'cacheName' }),
					storedRule('private', {
						exact: '_private-ci',
						validate: 'cacheName'
					}),
					`INSERT INTO oidc_trust (id, issuer, audience, claims_json, permitted_grants_json, created_at) VALUES ('wildcard-only', 'https://issuer.example', 'https://cache.example', '{}', '[{"type":"cupboard_wildcard"}]', '2026-01-01T00:00:00.000Z')`,
					storedFamily('family-named', 'ci'),
					storedFamily('family-default', '_default'),
					storedFamily('family-private', '_private-ci')
				];

				for (const statement of statements) {
					state.storage.sql.exec(statement);
				}

				await migrateThroughConvertedCatalogue(state);

				return {
					rules: state.storage.sql
						.exec(
							'SELECT id, permitted_grants_json FROM oidc_trust ORDER BY id'
						)
						.toArray(),
					families: state.storage.sql
						.exec(
							'SELECT id, grants_json FROM refresh_token_family ORDER BY id'
						)
						.toArray()
				};
			}
		);

		const ruleGrant = (cache: unknown) =>
			JSON.stringify([
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: { cache }
				}
			]);
		const issuedGrant = (cache: unknown) =>
			JSON.stringify([
				{ type: 'cupboard_cache', actions: ['upload:commit'], cache }
			]);
		const namedCi = { exact: 'ci', validate: 'cacheName', kind: 'named' };

		expect(rewritten).toStrictEqual({
			rules: [
				{
					id: 'default',
					permitted_grants_json: ruleGrant({ kind: 'default' })
				},
				{ id: 'named', permitted_grants_json: ruleGrant(namedCi) },
				{ id: 'private', permitted_grants_json: ruleGrant(namedCi) },
				{
					id: 'wildcard-only',
					permitted_grants_json: JSON.stringify([{ type: 'cupboard_wildcard' }])
				}
			],
			families: [
				{ id: 'family-default', grants_json: issuedGrant({ kind: 'default' }) },
				{
					id: 'family-named',
					grants_json: issuedGrant({ kind: 'named', name: 'ci' })
				},
				{
					id: 'family-private',
					grants_json: issuedGrant({ kind: 'named', name: 'ci' })
				}
			]
		});
	});

	// A root could be bound to the cache the grant names, with
	// `equalsResource: 'cache'`. That spelling has left the grant grammar, so
	// 0046 replaces it with the binding it stood for.
	it('replaces a root bound to the cache with an explicit binding', async () => {
		const boundRoot = { equalsResource: 'cache', validate: 'rootName' };
		const substitutions = {
			ref: {
				claim: 'ref',
				capture: { pattern: '^refs/pull/(?<ref>[0-9]+)/merge$', group: 'ref' }
			}
		};

		const rewritten = await runInDurableObject(
			testServerFor('migration-cache-grant-root-binding'),
			async (_instance, state) => {
				await migrateThrough(state, 43);

				const statements = [
					insertRootGrantRule('exact', {
						cache: { exact: 'ci', validate: 'cacheName' },
						root: boundRoot
					}),
					insertRootGrantRule('default', {
						cache: { exact: '_default', validate: 'cacheName' },
						root: boundRoot
					}),
					insertRootGrantRule('template', {
						cache: {
							equalsTemplate: 'pr-{ref}',
							substitutions,
							validate: 'cacheName'
						},
						root: boundRoot
					}),
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
				permitted_grants_json: rootGrantsJson({
					cache: { kind: 'default' }
				})
			},
			{
				id: 'exact',
				permitted_grants_json: rootGrantsJson({
					cache: { exact: 'ci', validate: 'cacheName', kind: 'named' },
					root: { exact: 'ci', validate: 'rootName' }
				})
			},
			{
				id: 'template',
				permitted_grants_json: rootGrantsJson({
					cache: {
						equalsTemplate: 'pr-{ref}',
						substitutions,
						validate: 'cacheName',
						kind: 'named'
					},
					root: {
						equalsTemplate: 'pr-{ref}',
						substitutions,
						validate: 'rootName'
					}
				})
			},
			{
				id: 'untouched',
				permitted_grants_json: rootGrantsJson({
					cache: { exact: 'ci', validate: 'cacheName', kind: 'named' },
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
