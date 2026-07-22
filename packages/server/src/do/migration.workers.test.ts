import {
	cacheNameSchema,
	DEFAULT_CACHE,
	type StoredCache,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import {
	oidcTrust,
	retentionGrace,
	retentionGracePolicies,
	retentionPolicies,
	reuseViewRevisionSeq,
	reuseViews,
	reuseViewSelectors,
	verificationCursor
} from '../db/schema.ts';
import {
	bootstrap,
	latestMigrationIndex,
	migrateThrough,
	testServerFor,
	useTestServer
} from '../test-support.ts';

const defaultCache: StoredCache = DEFAULT_CACHE;

const insertSigningKey =
	"INSERT INTO signing_key (id, private_jwk_json, public_key, created_at) VALUES ('active', '{}', 'cupboard-1:cHVi', '2026-01-01T00:00:00.000Z')";

const insertSignedNarInfo =
	"INSERT INTO narinfo (store_path_hash, store_path, nar_hash, nar_size, file_hash, file_size, compression, references_json, sig, created_at) VALUES (?, ?, 'sha256:nar', 10, 'sha256:file', 20, 'zstd', '[]', ?, '2026-01-01T00:00:00.000Z')";

const insertUnsignedNarInfo =
	"INSERT INTO narinfo (store_path_hash, store_path, nar_hash, nar_size, file_hash, file_size, compression, references_json, created_at) VALUES (?, ?, 'sha256:nar', 10, 'sha256:file', 20, 'zstd', '[]', '2026-01-01T00:00:00.000Z')";

describe('migrations', () => {
	it('carries a pre-0007 narinfo through the 0007 and 0008 recreates', async () => {
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

				await migrateThrough(state, latestMigrationIndex);

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
			(_instance, state) =>
				state.storage.sql
					.exec('SELECT name, priority FROM cache ORDER BY name')
					.toArray()
		);

		expect(caches).toStrictEqual([{ name: '', priority: 40 }]);
	});

	it('migrates and round-trips a retention policy', async () => {
		const policy = {
			id: 'p1',
			scope: 'root-name-prefix' as const,
			pattern: 'pr-',
			defaultTtlSeconds: 1_209_600,
			createdAt: '2026-01-01T00:00:00.000Z'
		};

		const rows = await runInDurableObject(
			testServerFor('migration-retention-policy'),
			async (_instance, state) => {
				await migrateThrough(state, latestMigrationIndex);

				const database = drizzle(state.storage, {
					schema: { retentionPolicies }
				});
				database.insert(retentionPolicies).values(policy).run();

				return database.select().from(retentionPolicies).all();
			}
		);

		expect(rows).toStrictEqual([policy]);
	});

	it('migrates and round-trips the verification cursor', async () => {
		const cursor = {
			id: 'active',
			cache: cacheNameSchema.parse('builds'),
			lastStorePathHash: 'a'.repeat(32),
			updatedAt: '2026-01-01T00:00:00.000Z'
		};

		const rows = await runInDurableObject(
			testServerFor('migration-verification-cursor'),
			async (_instance, state) => {
				await migrateThrough(state, latestMigrationIndex);

				const database = drizzle(state.storage, {
					schema: { verificationCursor }
				});
				database.insert(verificationCursor).values(cursor).run();

				return database.select().from(verificationCursor).all();
			}
		);

		expect(rows).toStrictEqual([cursor]);
	});

	it('gains the retention grace policy table at the latest migration', async () => {
		const policy = {
			id: 'g1',
			cachePrefix: 'pr-',
			graceSeconds: 86_400,
			createdAt: '2026-01-01T00:00:00.000Z'
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
				await migrateThrough(state, latestMigrationIndex);

				const database = drizzle(state.storage, {
					schema: { retentionGracePolicies }
				});
				database.insert(retentionGracePolicies).values(policy).run();

				return database.select().from(retentionGracePolicies).all();
			}
		);

		expect(rows).toStrictEqual([policy]);
	});

	it('gains the retention grace table and cache marker at the latest migration', async () => {
		const deadline = {
			cache: defaultCache,
			storePathHash: storePathHashSchema.parse('a'.repeat(32)),
			retainUntil: '2026-06-01T00:00:00.000Z'
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

				await migrateThrough(state, latestMigrationIndex);

				const database = drizzle(state.storage, {
					schema: { retentionGrace }
				});
				database.insert(retentionGrace).values(deadline).run();

				return {
					deadlines: database.select().from(retentionGrace).all(),
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

	it('carries a pre-decision pending upload through the grace-decision column', async () => {
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

				await migrateThrough(state, latestMigrationIndex);

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
		const view = {
			name: 'reuse',
			revision: 1,
			priority: 50,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z'
		};
		const selector = { view: 'reuse', kind: 'exact' as const, pattern: 'pr-1' };
		const revisionSeq = { name: 'reuse', nextRevision: 2 };

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

				await migrateThrough(state, latestMigrationIndex);

				const after = drizzle(state.storage, {
					schema: { reuseViews, reuseViewSelectors, reuseViewRevisionSeq }
				});
				after.insert(reuseViews).values(view).run();
				after.insert(reuseViewSelectors).values(selector).run();
				after.insert(reuseViewRevisionSeq).values(revisionSeq).run();

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
					views: after.select().from(reuseViews).all(),
					selectors: after.select().from(reuseViewSelectors).all(),
					revisionSeqs: after.select().from(reuseViewRevisionSeq).all(),
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

				await migrateThrough(state, latestMigrationIndex);

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
			id: 'r1',
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
			createdAt: '2026-01-01T00:00:00.000Z',
			disabledAt: '2026-01-02T00:00:00.000Z'
		};

		const rows = await runInDurableObject(
			testServerFor('migration-oidc-trust'),
			async (_instance, state) => {
				await migrateThrough(state, latestMigrationIndex);

				const database = drizzle(state.storage, { schema: { oidcTrust } });
				database.insert(oidcTrust).values(rule).run();

				return database.select().from(oidcTrust).all();
			}
		);

		expect(rows).toStrictEqual([rule]);
	});
});
