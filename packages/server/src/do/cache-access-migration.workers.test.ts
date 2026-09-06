import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
	latestMigrationIndex,
	migrateThrough,
	testServerFor
} from '../test-support.ts';

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

				await migrateThrough(state, latestMigrationIndex);
				const generationRows = state.storage.sql
					.exec(
						'SELECT cache_kind, cache_name, store_path_hash, next_generation FROM generation_seq ORDER BY store_path_hash'
					)
					.toArray();
				const generations = generationRows.map((row) => ({
					...row,
					cache_name: row.cache_name ?? undefined
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
					cache_kind: 'default',
					cache_name: undefined,
					store_path_hash: '00000000000000000000000000000000',
					next_generation: 2
				},
				{
					cache_kind: 'named',
					cache_name: 'releases',
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
		'preserves in-progress deletion residue for a $name cache',
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

					await migrateThrough(state, latestMigrationIndex);

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
});
