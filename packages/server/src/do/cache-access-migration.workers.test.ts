import {
	cacheGenerationSchema,
	cacheNameSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import { cacheScopeFromRow } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { reconcileCacheCatalogue } from '../migration/cache-access.ts';
import {
	latestMigrationIndex,
	migrateThrough,
	migrationIndexNamed,
	testServerFor
} from '../test-support.ts';

// The last migration before the one that makes every identity column
// mandatory. Rows in the legacy shape can be planted up to here, and the
// contraction runs from here on.
const beforeCacheIdentityContract =
	migrationIndexNamed('0051_cache_identity_contract_assertions') - 1;

describe('cache access migration', () => {
	it('backfills identities without guessing tenant access', async () => {
		const rows = await runInDurableObject(
			testServerFor('migration-native-cache-identity'),
			async (_instance, state) => {
				await migrateThrough(state, 41);

				state.storage.sql.exec(
					"INSERT INTO cache (name, priority, created_at) VALUES ('', 40, '2026-01-01T00:00:00.000Z'), ('builds', 41, '2026-01-02T00:00:00.000Z'), ('private/releases', 42, '2026-01-03T00:00:00.000Z')"
				);
				state.storage.sql.exec(
					"INSERT INTO narinfo (cache, store_path_hash, store_path, nar_hash, nar_size, references_json, sigs_json, created_at) VALUES ('builds', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-build', 'sha256:nar', 1, '[]', '[]', '2026-01-02T00:00:00.000Z'), ('private/releases', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-release', 'sha256:nar', 1, '[]', '[]', '2026-01-03T00:00:00.000Z')"
				);
				state.storage.sql.exec(
					"INSERT INTO generation_seq (cache, store_path_hash, next_generation) VALUES ('', '00000000000000000000000000000000', 2), ('private/releases', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 7)"
				);
				state.storage.sql.exec(
					"INSERT INTO reuse_view (name, revision, priority, created_at, updated_at) VALUES ('private/all', 1, 50, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')"
				);
				state.storage.sql.exec(
					"INSERT INTO reuse_view_selector (view, kind, pattern) VALUES ('private/all', 'prefix', '')"
				);

				await migrateThrough(state, beforeCacheIdentityContract);
				const generationRows = state.storage.sql
					.exec<{
						cache_kind: 'default' | 'named' | null;
						cache_name: string | null;
						store_path_hash: string;
						next_generation: number;
					}>(
						'SELECT cache_kind, cache_name, store_path_hash, next_generation FROM generation_seq ORDER BY store_path_hash'
					)
					.toArray();
				const generations = generationRows.map((row) => ({
					cache: cacheScopeFromRow({
						kind: row.cache_kind,
						name: row.cache_name
					}),
					store_path_hash: row.store_path_hash,
					next_generation: row.next_generation
				}));

				return {
					defaultCaches: state.storage.sql
						.exec(
							"SELECT id, kind, priority FROM cache_identity WHERE kind = 'default' ORDER BY id"
						)
						.toArray(),
					pendingNamedCaches: state.storage.sql
						.exec(
							"SELECT id, kind, name, priority FROM cache_identity WHERE kind = 'named' AND access IS NULL ORDER BY id"
						)
						.toArray(),
					privateCaches: state.storage.sql
						.exec(
							"SELECT id, kind, name, access, priority FROM cache_identity WHERE access = 'private' ORDER BY id"
						)
						.toArray(),
					generations,
					narInfos: state.storage.sql
						.exec(
							'SELECT narinfo.store_path_hash, cache_identity.kind, cache_identity.name FROM narinfo JOIN cache_identity ON cache_identity.id = narinfo.cache_id ORDER BY narinfo.store_path_hash'
						)
						.toArray(),
					view: state.storage.sql
						.exec('SELECT name, access FROM reuse_view')
						.toArray(),
					selectors: state.storage.sql
						.exec(
							"SELECT view, kind FROM reuse_view_selector_native WHERE kind = 'all-named'"
						)
						.toArray()
				};
			}
		);

		expect(rows).toStrictEqual({
			defaultCaches: [{ id: 1, kind: 'default', priority: 40 }],
			pendingNamedCaches: [
				{ id: 2, kind: 'named', name: 'builds', priority: 41 }
			],
			privateCaches: [
				{
					id: 3,
					kind: 'named',
					name: 'releases',
					access: 'private',
					priority: 42
				}
			],
			generations: [
				{
					cache: { kind: 'default' },
					store_path_hash: '00000000000000000000000000000000',
					next_generation: 2
				},
				{
					cache: { kind: 'named', name: 'releases' },
					store_path_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
					next_generation: 7
				}
			],
			narInfos: [
				{
					store_path_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					kind: 'named',
					name: 'builds'
				},
				{
					store_path_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
					kind: 'named',
					name: 'releases'
				}
			],
			view: [{ name: 'private/all', access: 'private' }],
			selectors: [
				{
					view: 'private/all',
					kind: 'all-named'
				}
			]
		});
	});

	it.each([
		{
			name: 'default',
			serverName: 'default',
			legacyCache: '',
			kind: 'default',
			cacheName: undefined,
			access: undefined,
			liveCacheRemoved: false,
			isDeleted: false
		},
		{
			name: 'public named',
			serverName: 'public',
			legacyCache: 'builds',
			kind: 'named',
			cacheName: 'builds',
			access: undefined,
			liveCacheRemoved: true,
			isDeleted: true
		},
		{
			name: 'private named',
			serverName: 'private',
			legacyCache: 'private/builds',
			kind: 'named',
			cacheName: 'builds',
			access: 'private',
			liveCacheRemoved: true,
			isDeleted: true
		}
	])(
		'links a queued narinfo deletion whose cache row has already gone, for a $name cache',
		async ({
			serverName,
			legacyCache,
			kind,
			cacheName,
			access,
			liveCacheRemoved,
			isDeleted
		}) => {
			const row = await runInDurableObject(
				testServerFor(`migration-${serverName}-teardown`),
				async (_instance, state) => {
					await migrateThrough(state, 41);
					state.storage.sql.exec(
						'INSERT INTO cache (name, priority, created_at) VALUES (?, 41, ?)',
						legacyCache,
						'2026-01-01T00:00:00.000Z'
					);
					state.storage.sql.exec(
						"INSERT INTO narinfo_deletion (cache, store_path_hash, nar_hash, generation, created_at) VALUES (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sha256:queued', 3, '2026-01-02T00:00:00.000Z')",
						legacyCache
					);

					if (liveCacheRemoved) {
						state.storage.sql.exec(
							'DELETE FROM cache WHERE name = ?',
							legacyCache
						);
					}

					await migrateThrough(state, beforeCacheIdentityContract);

					return state.storage.sql
						.exec(
							'SELECT cache_identity.kind, cache_identity.name, cache_identity.access, cache_identity.deleted_at, narinfo_deletion.store_path_hash, narinfo_deletion.generation FROM narinfo_deletion JOIN cache_identity ON cache_identity.id = narinfo_deletion.cache_id'
						)
						.one();
				}
			);

			expect({
				kind: row.kind,
				name: row.name ?? undefined,
				access: row.access ?? undefined,
				isDeleted: row.deleted_at !== null,
				storePathHash: row.store_path_hash,
				generation: row.generation
			}).toStrictEqual({
				kind,
				name: cacheName,
				access,
				isDeleted,
				storePathHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				generation: 3
			});
		}
	);

	it('refuses the contraction while a cache records no access', async () => {
		const server = testServerFor('migration-unconverted-catalogue');

		await expect(
			runInDurableObject(server, async (_instance, state) => {
				await migrateThrough(state, 41);
				state.storage.sql.exec(
					"INSERT INTO cache (name, priority, created_at) VALUES ('', 40, '2026-01-01T00:00:00.000Z'), ('builds', 41, '2026-01-01T00:00:00.000Z')"
				);
				await migrateThrough(state, beforeCacheIdentityContract);

				return migrateThrough(state, latestMigrationIndex);
			})
		).rejects.toThrow();
	});

	it('converts an unreconciled catalogue before the contraction runs', async () => {
		const tenant = tenantIdSchema.parse('migration-self-converting');
		const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
		const d1 = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

		await d1.insert(d1Schema.tenant).values({
			id: tenant,
			status: 'offboarding',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'cupboard',
			configVersion: 1,
			createdAt: now
		});
		await d1.insert(d1Schema.cacheLifecycle).values({
			tenant,
			cacheKind: 'default',
			cacheName: sql`null`,
			access: 'private',
			generation: cacheGenerationSchema.parse(1),
			updatedAt: now
		});

		const server = testServerFor(tenant);
		await runInDurableObject(server, async (_instance, state) => {
			await migrateThrough(state, 41);
			state.storage.sql.exec(
				"INSERT INTO cache (name, priority, created_at) VALUES ('', 40, ?), ('builds', 41, ?)",
				now,
				now
			);
		});

		// Nothing converts this tenant's catalogue for it: an offboarding tenant
		// takes no traffic of its own. Starting the object has to convert and
		// contract in one go, or the offboard drain could never run again.
		await server.migrateCacheCatalogue(tenant);

		const caches = await runInDurableObject(server, (_instance, state) => {
			const rows = state.storage.sql
				.exec<{
					kind: 'default' | 'named';
					name: string | null;
					access: string;
				}>('SELECT kind, name, access FROM cache_identity ORDER BY id')
				.toArray();

			return rows.map((row) => ({
				cache: cacheScopeFromRow({ kind: row.kind, name: row.name }),
				access: row.access
			}));
		});

		expect(caches).toStrictEqual([
			{ cache: { kind: 'default' }, access: 'private' },
			{ cache: { kind: 'named', name: 'builds' }, access: 'private' }
		]);
	});

	it('contracts once the reconciliation has supplied every access', async () => {
		const tenant = tenantIdSchema.parse('migration-private-tenant');
		const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
		const d1 = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

		await d1.insert(d1Schema.tenant).values({
			id: tenant,
			status: 'active',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'cupboard',
			configVersion: 1,
			createdAt: now
		});
		// The default cache's recorded access is what a cache with none of its own
		// inherits.
		await d1.insert(d1Schema.cacheLifecycle).values({
			tenant,
			cacheKind: 'default',
			cacheName: sql`null`,
			access: 'private',
			generation: cacheGenerationSchema.parse(1),
			updatedAt: now
		});

		const server = testServerFor(tenant);
		await runInDurableObject(server, async (instance, state) => {
			await migrateThrough(state, 41);
			state.storage.sql.exec(
				"INSERT INTO cache (name, priority, created_at) VALUES ('', 40, ?), ('builds', 41, ?), ('private/releases', 42, ?)",
				now,
				now,
				now
			);
			state.storage.sql.exec(
				"INSERT INTO reuse_view (name, revision, priority, created_at, updated_at) VALUES ('ordinary', 1, 50, ?, ?), ('private/secure', 1, 51, ?, ?)",
				now,
				now,
				now,
				now
			);
			await migrateThrough(state, beforeCacheIdentityContract);
			await reconcileCacheCatalogue(instance.context, tenant);
			await migrateThrough(state, latestMigrationIndex);
		});

		const local = await runInDurableObject(server, (_instance, state) => {
			const cacheRows = state.storage.sql
				.exec<{
					kind: 'default' | 'named';
					name: string | null;
					access: string;
					priority: number;
				}>(
					'SELECT kind, name, access, priority FROM cache_identity ORDER BY id'
				)
				.toArray();
			const caches = cacheRows.map((row) => ({
				cache: cacheScopeFromRow({ kind: row.kind, name: row.name }),
				access: row.access,
				priority: row.priority
			}));

			return {
				caches,
				views: state.storage.sql
					.exec('SELECT name, access FROM reuse_view ORDER BY name')
					.toArray()
			};
		});
		const lifecycleRows = await d1
			.select({
				kind: d1Schema.cacheLifecycle.cacheKind,
				name: d1Schema.cacheLifecycle.cacheName,
				access: d1Schema.cacheLifecycle.access
			})
			.from(d1Schema.cacheLifecycle)
			.where(eq(d1Schema.cacheLifecycle.tenant, tenant))
			.all();
		const lifecycles = lifecycleRows.map((row) => ({
			cache: cacheScopeFromRow({ kind: row.kind, name: row.name }),
			access: row.access
		}));

		expect({ local, lifecycles }).toStrictEqual({
			local: {
				caches: [
					{ cache: { kind: 'default' }, access: 'private', priority: 40 },
					{
						cache: { kind: 'named', name: 'builds' },
						access: 'private',
						priority: 41
					},
					{
						cache: { kind: 'named', name: 'releases' },
						access: 'private',
						priority: 42
					}
				],
				// The contraction renames a view to its local name, so the private
				// namespace no longer appears in the stored key.
				views: [
					{ name: 'ordinary', access: 'private' },
					{ name: 'secure', access: 'private' }
				]
			},
			lifecycles: [
				{ cache: { kind: 'default' }, access: 'private' },
				{ cache: { kind: 'named', name: 'builds' }, access: 'private' },
				{ cache: { kind: 'named', name: 'releases' }, access: 'private' }
			]
		});
	});

	it('revokes a live D1 cache absent from the Durable Object catalogue', async () => {
		const tenant = tenantIdSchema.parse('migration-phantom-cache');
		const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
		const d1 = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

		await d1.insert(d1Schema.tenant).values({
			id: tenant,
			status: 'active',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'cupboard',
			configVersion: 1,
			createdAt: now
		});
		await d1.insert(d1Schema.cacheLifecycle).values([
			{
				tenant,
				cacheKind: 'default',
				cacheName: sql`null`,
				access: 'public',
				generation: cacheGenerationSchema.parse(1),
				updatedAt: now
			},
			{
				tenant,
				cacheKind: 'named',
				cacheName: cacheNameSchema.parse('phantom'),
				access: 'public',
				generation: cacheGenerationSchema.parse(4),
				updatedAt: now
			}
		]);

		const server = testServerFor(tenant);
		await runInDurableObject(server, async (instance, state) => {
			await migrateThrough(state, 41);
			state.storage.sql.exec(
				"INSERT INTO cache (name, priority, created_at) VALUES ('', 40, ?)",
				now
			);
			await migrateThrough(state, beforeCacheIdentityContract);
			await reconcileCacheCatalogue(instance.context, tenant);
		});

		const rows = await d1
			.select({
				kind: d1Schema.cacheLifecycle.cacheKind,
				name: d1Schema.cacheLifecycle.cacheName,
				generation: d1Schema.cacheLifecycle.generation,
				deletedAt: d1Schema.cacheLifecycle.deletedAt
			})
			.from(d1Schema.cacheLifecycle)
			.where(eq(d1Schema.cacheLifecycle.tenant, tenant))
			.all();

		expect(
			rows.map((row) => ({
				cache: cacheScopeFromRow({ kind: row.kind, name: row.name }),
				generation: row.generation,
				isDeleted: row.deletedAt !== null
			}))
		).toStrictEqual([
			{ cache: { kind: 'default' }, generation: 1, isDeleted: false },
			{
				cache: { kind: 'named', name: cacheNameSchema.parse('phantom') },
				generation: 5,
				isDeleted: true
			}
		]);
	});
});
