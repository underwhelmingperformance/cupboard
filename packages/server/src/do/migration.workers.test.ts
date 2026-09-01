import {
	cacheNameSchema,
	graceSecondsSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { cacheSummarySchema } from '@cupboard/protocol/caches';
import {
	authorizationDetailsSchema,
	storedPermittedGrantsSchema
} from '@cupboard/protocol/grants';
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
	bootstrap,
	latestMigrationIndex,
	latestPreContractMigrationIndex,
	migrateThrough,
	testServerFor,
	useTestServer
} from '../test-support.ts';

const defaultCache = '';

const insertSigningKey =
	"INSERT INTO signing_key (id, private_jwk_json, public_key, created_at) VALUES ('active', '{}', 'cupboard-1:cHVi', '2026-01-01T00:00:00.000Z')";

const insertSignedNarInfo =
	"INSERT INTO narinfo (store_path_hash, store_path, nar_hash, nar_size, file_hash, file_size, compression, references_json, sig, created_at) VALUES (?, ?, 'sha256:nar', 10, 'sha256:file', 20, 'zstd', '[]', ?, '2026-01-01T00:00:00.000Z')";

const insertUnsignedNarInfo =
	"INSERT INTO narinfo (store_path_hash, store_path, nar_hash, nar_size, file_hash, file_size, compression, references_json, created_at) VALUES (?, ?, 'sha256:nar', 10, 'sha256:file', 20, 'zstd', '[]', '2026-01-01T00:00:00.000Z')";

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

				await migrateThrough(state, latestPreContractMigrationIndex);

				return {
					narInfos: state.storage.sql
						.exec(
							'SELECT store_path_hash, cache, sigs_json FROM narinfo ORDER BY store_path_hash'
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
					cache: '',
					sigs_json: '["cupboard-1:abc"]'
				},
				{ store_path_hash: unsignedHash, cache: '', sigs_json: '[]' }
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
					.exec(
						'SELECT kind, name, access, priority FROM cache_identity ORDER BY id'
					)
					.toArray();

				return rows.map((row) => ({
					cache: cacheScopeFromRow({ kind: row.kind, name: row.name }),
					access: row.access,
					priority: row.priority
				}));
			}
		);

		expect(caches).toStrictEqual([
			{ cache: { kind: 'default' }, access: 'public', priority: 40 }
		]);
	});

	it('migrates and round-trips a retention policy', async () => {
		const policy = {
			id: 'p1',
			scope: 'root-name-prefix' as const,
			pattern: 'pr-',
			defaultTtlSeconds: 1_209_600,
			createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
		};

		const rows = await runInDurableObject(
			testServerFor('migration-retention-policy'),
			async (_instance, state) => {
				await migrateThrough(state, latestPreContractMigrationIndex);

				state.storage.sql.exec(
					'INSERT INTO retention_policy (id, scope, pattern, default_ttl_seconds, created_at) VALUES (?, ?, ?, ?, ?)',
					policy.id,
					policy.scope,
					policy.pattern,
					policy.defaultTtlSeconds,
					policy.createdAt
				);

				return state.storage.sql
					.exec(
						'SELECT id, scope, pattern, default_ttl_seconds AS defaultTtlSeconds, created_at AS createdAt FROM retention_policy'
					)
					.toArray();
			}
		);

		expect(rows).toStrictEqual([policy]);
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

				await migrateThrough(state, latestPreContractMigrationIndex);

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
				await migrateThrough(state, latestPreContractMigrationIndex);

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
			cache: cacheNameSchema.parse('builds'),
			lastStorePathHash: 'a'.repeat(32),
			updatedAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
		};

		const rows = await runInDurableObject(
			testServerFor('migration-verification-cursor'),
			async (_instance, state) => {
				await migrateThrough(state, latestPreContractMigrationIndex);

				state.storage.sql.exec(
					'INSERT INTO verification_cursor (id, cache, last_store_path_hash, updated_at) VALUES (?, ?, ?, ?)',
					cursor.id,
					cursor.cache,
					cursor.lastStorePathHash,
					cursor.updatedAt
				);

				return state.storage.sql
					.exec(
						'SELECT id, cache, last_store_path_hash AS lastStorePathHash, updated_at AS updatedAt FROM verification_cursor'
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
				await migrateThrough(state, latestPreContractMigrationIndex);

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
			cache: defaultCache,
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

				await migrateThrough(state, latestPreContractMigrationIndex);

				state.storage.sql.exec(
					'INSERT INTO retention_grace (cache, store_path_hash, retain_until) VALUES (?, ?, ?)',
					deadline.cache,
					deadline.storePathHash,
					deadline.retainUntil
				);

				return {
					deadlines: state.storage.sql
						.exec(
							'SELECT cache, store_path_hash AS storePathHash, retain_until AS retainUntil FROM retention_grace'
						)
						.toArray(),
					caches: state.storage.sql
						.exec('SELECT name, grace_managed FROM cache ORDER BY name')
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

				await migrateThrough(state, latestPreContractMigrationIndex);

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

				await migrateThrough(state, latestPreContractMigrationIndex);

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

				await migrateThrough(state, latestPreContractMigrationIndex);

				const rows = state.storage.sql.exec(selectRecordedVerdicts).toArray();

				return rows.map((row) => ({
					id: row.id,
					hasRecordedVerdict: row.recorded_verdict_json !== null
				}));
			}
		);

		expect(migrated).toStrictEqual([{ id: 'u1', hasRecordedVerdict: false }]);
	});

	it('migrates a pre-0034 sweep scan to the collect phase', async () => {
		const insertCollectingScan =
			"INSERT INTO garbage_collection_scan (cache, revision, phase, cursor, reference_cursor, allow_empty_sweep) VALUES ('builds', 7, 'sweep', 'aa', -1, 1)";
		const selectScans =
			'SELECT cache, revision, phase, cursor, allow_empty_collection FROM garbage_collection_scan';

		const migrated = await runInDurableObject(
			testServerFor('migration-collect-phase'),
			async (_instance, state) => {
				// A collection interrupted before 0034 left a scan row naming the
				// phase `sweep` and holding its allow-empty flag in
				// `allow_empty_sweep`. The migration must rename the column and
				// rewrite the phase, so the interrupted collection resumes where it
				// stopped. The anchor is fixed so later migrations cannot silently
				// retarget the test.
				await migrateThrough(state, 33);
				state.storage.sql.exec(insertCollectingScan);

				await migrateThrough(state, latestPreContractMigrationIndex);

				return state.storage.sql.exec(selectScans).toArray();
			}
		);

		expect(migrated).toStrictEqual([
			{
				cache: 'builds',
				revision: 7,
				phase: 'collect',
				cursor: 'aa',
				allow_empty_collection: 1
			}
		]);
	});

	it('gains the reuse-view tables and narinfo index at the latest migration, leaving an existing narinfo row untouched', async () => {
		const storePathHash = 'a'.repeat(32);
		const narInfoRow = {
			cache: '',
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
			kind: 'exact' as const,
			pattern: 'pr-1'
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
					'INSERT INTO narinfo (cache, store_path_hash, store_path, nar_hash, nar_size, references_json, sigs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
					narInfoRow.cache,
					narInfoRow.store_path_hash,
					narInfoRow.store_path,
					narInfoRow.nar_hash,
					narInfoRow.nar_size,
					narInfoRow.references_json,
					narInfoRow.sigs_json,
					narInfoRow.created_at
				);

				await migrateThrough(state, latestPreContractMigrationIndex);

				state.storage.sql.exec(
					'INSERT INTO reuse_view (name, revision, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
					view.name,
					view.revision,
					view.priority,
					view.createdAt,
					view.updatedAt
				);
				state.storage.sql.exec(
					'INSERT INTO reuse_view_selector (view, kind, pattern) VALUES (?, ?, ?)',
					selector.view,
					selector.kind,
					selector.pattern
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
							'SELECT cache, store_path_hash, store_path, nar_hash, nar_size, references_json, sigs_json, generation, created_at FROM narinfo'
						)
						.toArray(),
					views: state.storage.sql
						.exec(
							'SELECT name, revision, priority, created_at AS createdAt, updated_at AS updatedAt FROM reuse_view'
						)
						.toArray(),
					selectors: state.storage.sql
						.exec('SELECT view, kind, pattern FROM reuse_view_selector')
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

				await migrateThrough(state, latestPreContractMigrationIndex);

				return {
					roots: state.storage.sql
						.exec(
							'SELECT cache, name, expires_at FROM retention_root ORDER BY cache, name'
						)
						.toArray(),
					targets: state.storage.sql
						.exec(
							'SELECT cache, root_name, store_path_hash, store_path FROM retention_root_target ORDER BY cache, root_name, store_path_hash'
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
				await migrateThrough(state, latestPreContractMigrationIndex);

				const database = drizzle(state.storage, { schema: { oidcTrust } });
				database.insert(oidcTrust).values(rule).run();

				return database.select().from(oidcTrust).all();
			}
		);

		expect(rows).toStrictEqual([rule]);
	});

	it('migrates stored cache grants to native cache scopes', async () => {
		const substitutions = {
			name: { claim: 'cache_name', slug: true }
		};
		const legacyPermittedGrants = [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				resources: {
					cache: { exact: '_default', validate: 'cacheName' },
					root: { equalsResource: 'cache', validate: 'rootName' }
				}
			},
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				resources: {
					cache: { exact: 'aprivate-builds', validate: 'cacheName' },
					root: { equalsResource: 'cache', validate: 'rootName' }
				}
			},
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				resources: {
					cache: { exact: '_private-secrets', validate: 'cacheName' },
					root: { equalsResource: 'cache', validate: 'rootName' }
				}
			},
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				resources: {
					cache: {
						equalsTemplate: 'pr-{name}',
						substitutions,
						validate: 'cacheName'
					},
					root: { equalsResource: 'cache', validate: 'rootName' }
				}
			},
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				resources: {
					cache: {
						equalsTemplate: '_private-pr-{name}',
						substitutions,
						validate: 'cacheName'
					},
					root: { equalsResource: 'cache', validate: 'rootName' }
				}
			},
			{ type: 'cupboard_domain', actions: ['cache:list'] }
		];
		const legacyRefreshGrants = [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: '_default'
			},
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: 'aprivate-builds',
				root: 'main'
			},
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: '_private-secrets',
				root: '_private-secrets'
			},
			{ type: 'cupboard_domain', actions: ['cache:list'] }
		];

		const migrated = await runInDurableObject(
			testServerFor('migration-cache-grants'),
			async (_instance, state) => {
				await migrateThrough(state, 41);
				state.storage.sql.exec(
					"INSERT INTO cache (name, priority, created_at) VALUES ('', 40, '2026-01-01T00:00:00.000Z'), ('aprivate-builds', 40, '2026-01-01T00:00:00.000Z'), ('private/secrets', 40, '2026-01-01T00:00:00.000Z')"
				);
				await migrateThrough(state, 43);
				state.storage.sql.exec(
					"UPDATE cache_identity SET access = 'public' WHERE access IS NULL"
				);

				state.storage.sql.exec(
					'INSERT INTO oidc_trust (id, issuer, audience, claims_json, permitted_grants_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
					'legacy-rule',
					'https://issuer.example',
					'https://cache.example',
					'{}',
					JSON.stringify(legacyPermittedGrants),
					'2026-01-01T00:00:00.000Z'
				);
				state.storage.sql.exec(
					'INSERT INTO refresh_token_family (id, active_member_id, generation, rule_id, subject, grants_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
					'legacy-family',
					'legacy-member',
					0,
					'legacy-rule',
					'alice',
					JSON.stringify(legacyRefreshGrants),
					'2026-01-01T00:00:00.000Z',
					'2027-01-01T00:00:00.000Z'
				);

				await migrateThrough(state, latestMigrationIndex);

				const trustRow = state.storage.sql
					.exec<{ permittedGrantsJson: string }>(
						'SELECT permitted_grants_json AS permittedGrantsJson FROM oidc_trust WHERE id = ?',
						'legacy-rule'
					)
					.one();
				const familyRow = state.storage.sql
					.exec<{ grantsJson: string }>(
						'SELECT grants_json AS grantsJson FROM refresh_token_family WHERE id = ?',
						'legacy-family'
					)
					.one();

				return {
					permitted: storedPermittedGrantsSchema.parse(
						JSON.parse(trustRow.permittedGrantsJson)
					),
					refresh: authorizationDetailsSchema.parse(
						JSON.parse(familyRow.grantsJson)
					)
				};
			}
		);

		expect(migrated).toStrictEqual({
			permitted: [
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: {
						cache: { kind: 'default' },
						root: { exact: '_default', validate: 'rootName' }
					}
				},
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: {
						cache: {
							kind: 'named',
							exact: 'aprivate-builds',
							validate: 'cacheName'
						},
						root: { exact: 'aprivate-builds', validate: 'rootName' }
					}
				},
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: {
						cache: {
							kind: 'named',
							exact: 'secrets',
							validate: 'cacheName'
						},
						root: { exact: '_private-secrets', validate: 'rootName' }
					}
				},
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: {
						cache: {
							kind: 'named',
							equalsTemplate: 'pr-{name}',
							substitutions,
							validate: 'cacheName'
						},
						root: {
							equalsTemplate: 'pr-{name}',
							substitutions,
							validate: 'rootName'
						}
					}
				},
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: {
						cache: {
							kind: 'named',
							equalsTemplate: 'pr-{name}',
							substitutions,
							validate: 'cacheName'
						},
						root: {
							equalsTemplate: '_private-pr-{name}',
							substitutions,
							validate: 'rootName'
						}
					}
				},
				{ type: 'cupboard_domain', actions: ['cache:list'] }
			],
			refresh: [
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					cache: { kind: 'default' }
				},
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					cache: { kind: 'named', name: 'aprivate-builds' },
					root: 'main'
				},
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					cache: { kind: 'named', name: 'secrets' },
					root: '_private-secrets'
				},
				{ type: 'cupboard_domain', actions: ['cache:list'] }
			]
		});
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
				state.storage.sql.exec(
					`INSERT INTO retention_policy (id, scope, pattern, default_ttl_seconds, created_at) VALUES
						('default', 'cache', '', 3600, '2026-01-01T00:00:00.000Z'),
						('builds', 'cache', 'builds', 7200, '2026-01-01T00:00:00.000Z'),
						('dangling', 'cache', 'missing', 42, '2026-01-01T00:00:00.000Z'),
						('ci', 'root-name-prefix', 'ci/', 100, '2026-01-01T00:00:00.000Z'),
						('pr', 'root-name-prefix', 'pr/', 200, '2026-01-01T00:00:00.000Z')`
				);
				state.storage.sql.exec(
					'INSERT INTO retention_policy (id, scope, pattern, default_ttl_seconds, created_at) VALUES (?, ?, ?, ?, ?)',
					'inert-long',
					'root-name-prefix',
					'a'.repeat(257),
					300,
					'2026-01-01T00:00:00.000Z'
				);
				state.storage.sql.exec(
					'INSERT INTO retention_policy (id, scope, pattern, default_ttl_seconds, created_at) VALUES (?, ?, ?, ?, ?)',
					'inert-control',
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
					"INSERT INTO retention_root (cache, name, expires_at, created_at, updated_at) VALUES ('builds', 'keep', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')"
				);
				state.storage.sql.exec(
					"INSERT INTO retention_grace (cache, store_path_hash, retain_until) VALUES ('builds', ?, '2099-02-01T00:00:00.000Z')",
					'a'.repeat(32)
				);

				await migrateThrough(state, 43);
				state.storage.sql.exec(
					"UPDATE cache_identity SET access = 'public' WHERE access IS NULL"
				);
				await migrateThrough(state, latestPreContractMigrationIndex);

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
				const buildsId = idFor('builds');

				state.storage.sql.exec(
					"INSERT INTO cache_identity (kind, name, access, priority, grace_managed, created_at, deleted_at) VALUES ('named', 'deleted', 'public', 5, 1, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')"
				);
				await migrateThrough(state, latestMigrationIndex);
				const database = drizzle(state.storage, { schema });
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
				state.storage.sql.exec(
					"INSERT INTO cache_identity (kind, name, access, priority, created_at) VALUES ('named', 'future', 'public', 1, '2026-03-01T00:00:00.000Z')"
				);

				const overrides = state.storage.sql
					.exec(
						'SELECT cache_identity.id AS cache_id, root_retention_rule.root_prefix, root_retention_rule.kind, root_retention_rule.ttl_seconds FROM cache_identity JOIN root_retention_rule ON root_retention_rule.rule_set_id = cache_identity.root_retention_rule_set_id ORDER BY cache_identity.id, root_retention_rule.root_prefix'
					)
					.toArray();
				const summaryRows = state.storage.sql.exec<{
					id: SqlStorageValue;
					kind: SqlStorageValue;
					name: SqlStorageValue;
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
					graceManaged: false,
					lifecycle: 'active',
					management: { kind: 'durable' }
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
					graceManaged: true,
					lifecycle: 'active',
					management: { kind: 'durable' }
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
					graceManaged: false,
					lifecycle: 'active',
					management: { kind: 'durable' }
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
					graceManaged: false,
					lifecycle: 'active',
					management: { kind: 'durable' }
				},
				{
					scope: { kind: 'named', name: 'future' },
					access: 'public',
					priority: 1,
					storePaths: 0,
					defaultRootRetention: { kind: 'permanent' },
					grace: { kind: 'none' },
					rootRetentionOverrides: [],
					graceManaged: false,
					lifecycle: 'active',
					management: { kind: 'durable' }
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

	it('uses the cache-prefix index for legacy grace lookup', async () => {
		const plan = await runInDurableObject(
			testServerFor('migration-cache-retention-grace-plan'),
			async (_instance, state) => {
				await migrateThrough(state, latestPreContractMigrationIndex - 1);

				return state.storage.sql
					.exec(
						`EXPLAIN QUERY PLAN
						 SELECT grace_seconds
						 FROM retention_grace_policy
						 WHERE cache_prefix IN ('', 'g', 'gh', 'gh-')
						 ORDER BY length(cache_prefix) DESC
						 LIMIT 1`
					)
					.toArray();
			}
		);

		expect(plan).toStrictEqual([
			{
				id: 5,
				parent: 0,
				notused: 67,
				detail:
					'SEARCH retention_grace_policy USING INDEX retention_grace_policy_cache_prefix_unique (cache_prefix=?)'
			},
			{
				id: 41,
				parent: 0,
				notused: 0,
				detail: 'USE TEMP B-TREE FOR ORDER BY'
			}
		]);
	});

	it('rejects a legacy cache template without a fixed scope kind', async () => {
		await expect(
			runInDurableObject(
				testServerFor('migration-ambiguous-cache-grant'),
				async (_instance, state) => {
					await migrateThrough(state, 41);
					state.storage.sql.exec(
						"INSERT INTO cache (name, priority, created_at) VALUES ('', 40, '2026-01-01T00:00:00.000Z')"
					);
					await migrateThrough(state, 43);
					state.storage.sql.exec(
						"UPDATE cache_identity SET access = 'public' WHERE access IS NULL"
					);
					state.storage.sql.exec(
						'INSERT INTO oidc_trust (id, issuer, audience, claims_json, permitted_grants_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
						'ambiguous-rule',
						'https://issuer.example',
						'https://cache.example',
						'{}',
						JSON.stringify([
							{
								type: 'cupboard_cache',
								actions: ['upload:commit'],
								resources: {
									cache: {
										equalsTemplate: '{cache}',
										substitutions: {
											cache: { claim: 'cache_name' }
										},
										validate: 'cacheName'
									}
								}
							}
						]),
						'2026-01-01T00:00:00.000Z'
					);

					await migrateThrough(state, latestMigrationIndex);
				}
			)
		).rejects.toMatchObject({
			name: 'DurableObjectMigrationError',
			tag: '0044_cache_grant_json'
		});
	});
});
