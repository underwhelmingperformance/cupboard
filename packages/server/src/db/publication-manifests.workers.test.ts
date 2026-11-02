import { cacheGenerationSchema } from '@cupboard/nix-store/scalars';
import { publicationOperationIdSchema } from '@cupboard/protocol/publication-manifests';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import previousSnapshot from '../../drizzle/meta/0082_snapshot.json' with { type: 'json' };
import snapshot from '../../drizzle/meta/0083_snapshot.json' with { type: 'json' };
import { collectionTriggers } from '../do/garbage-collection-service.ts';
import { PublicationManifestAvailabilityStore } from '../do/publication-manifest-availability-store.ts';
import { withRowBudget } from '../do/row-budget.ts';
import { migrateThrough, testServerFor } from '../test-support.ts';

import { cacheIdSchema } from './cache.ts';
import * as schema from './schema.ts';

// Whole-row expectations retain SQLite's exact NULL representation.
const sqlNull: unknown = expect.toSatisfy((value: unknown) => value === null);

const cacheId = 10;
const cacheGeneration = 3;
const resultHash = 'result';
const memberHash = 'tool';
const resultPath = '/nix/store/result-app';
const memberPath = '/nix/store/tool-compiler';

function insertCache(
	storage: SqlStorage,
	id = cacheId,
	generation = cacheGeneration
): void {
	storage.exec(
		"INSERT INTO cache_identity(id,kind,name,access,priority,generation,created_at) VALUES (?,'named',?,'public',40,?,'2026-01-01T00:00:00.000Z')",
		id,
		`cache-${id.toString()}`,
		generation
	);
}

function insertNarInfo(
	storage: SqlStorage,
	hash: string,
	path: string,
	generation = 7,
	cache = cacheId
): void {
	storage.exec(
		"INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (?,?,?,?,10,'[]',?,'2026-01-01T00:00:00.000Z')",
		cache,
		hash,
		path,
		'sha256:nar',
		generation
	);
}

function insertAssociation(
	storage: SqlStorage,
	hash = resultHash,
	generation = 7,
	cache = cacheId,
	cacheVersion = cacheGeneration,
	materialisationId = `selected-${cache.toString()}-${cacheVersion.toString()}-${hash}-${generation.toString()}`
): void {
	storage.exec(
		"INSERT OR IGNORE INTO publication_manifest(digest,version,member_count) VALUES ('digest',1,2)"
	);
	storage.exec(
		"INSERT INTO result_publication(cache_id,cache_generation,result_hash,result_path,result_generation,result_nar_hash,digest,origin,complete,materialisation_id) VALUES (?,?,?,?,?,'sha256:nar','digest','build-selection',1,?)",
		cache,
		cacheVersion,
		hash,
		`/nix/store/${hash}-app`,
		generation,
		materialisationId
	);
}

function insertEdge(
	storage: SqlStorage,
	owner = resultHash,
	nar = 'sha256:nar',
	version = 7,
	cache = cacheId,
	cacheVersion = cacheGeneration,
	path = memberPath,
	materialisationId = `selected-${cache.toString()}-${cacheVersion.toString()}-${owner}-7`
): void {
	storage.exec(
		'INSERT INTO result_publication_member(cache_id,cache_generation,result_hash,result_generation,member_hash,member_path,member_nar_hash,member_generation,materialisation_id) VALUES (?,?,?,?,?,?,?,?,?)',
		cache,
		cacheVersion,
		owner,
		7,
		memberHash,
		path,
		nar,
		version,
		materialisationId
	);
}

function associations(storage: SqlStorage) {
	return storage
		.exec(
			'SELECT cache_id,cache_generation,result_hash,result_generation,complete FROM result_publication ORDER BY cache_id,cache_generation,result_hash,result_generation'
		)
		.toArray();
}

function retirements(storage: SqlStorage) {
	return storage
		.exec(
			'SELECT materialisation_id,digest FROM publication_manifest_retirement ORDER BY materialisation_id'
		)
		.toArray();
}

function publicationStorageState(storage: SqlStorage) {
	return {
		associations: storage
			.exec('SELECT * FROM result_publication ORDER BY materialisation_id')
			.toArray(),
		proofs: storage
			.exec(
				'SELECT * FROM result_publication_member ORDER BY materialisation_id,member_hash'
			)
			.toArray(),
		retirements: retirements(storage),
		clock: storage
			.exec('SELECT * FROM publication_manifest_availability_clock')
			.toArray(),
		revisions: storage
			.exec(
				'SELECT * FROM publication_manifest_availability_revision ORDER BY revision'
			)
			.toArray(),
		intents: storage
			.exec(
				'SELECT * FROM publication_manifest_availability_intent ORDER BY revision'
			)
			.toArray(),
		lifecycleIntents: storage
			.exec(
				'SELECT * FROM publication_manifest_lifecycle_intent ORDER BY revision'
			)
			.toArray(),
		identities: storage
			.exec(
				'SELECT * FROM publication_manifest_local_identity ORDER BY cache_id,store_path_hash'
			)
			.toArray(),
		cardinalities: storage
			.exec('SELECT * FROM publication_manifest_cardinality ORDER BY kind,id')
			.toArray(),
		gcScan: storage
			.exec('SELECT * FROM garbage_collection_scan ORDER BY cache_id')
			.toArray(),
		gcInput: storage
			.exec('SELECT * FROM garbage_collection_input ORDER BY cache_id')
			.toArray(),
		gcFrontier: storage
			.exec(
				'SELECT * FROM garbage_collection_frontier ORDER BY cache_id,store_path_hash'
			)
			.toArray(),
		gcMark: storage
			.exec(
				'SELECT * FROM garbage_collection_mark ORDER BY cache_id,store_path_hash'
			)
			.toArray()
	};
}

function frontier(storage: SqlStorage) {
	return storage
		.exec(
			'SELECT store_path_hash FROM garbage_collection_frontier ORDER BY store_path_hash'
		)
		.toArray();
}

async function withStorage(
	name: string,
	check: (
		storage: SqlStorage,
		store: PublicationManifestAvailabilityStore
	) => void
): Promise<void> {
	await runInDurableObject(
		testServerFor(`publication-manifests-${name}`),
		async (_instance, state) => {
			await migrateThrough(state, 83);
			insertCache(state.storage.sql);
			insertNarInfo(state.storage.sql, resultHash, resultPath);
			insertNarInfo(state.storage.sql, memberHash, memberPath);
			check(
				state.storage.sql,
				new PublicationManifestAvailabilityStore(
					drizzle(state.storage, { schema })
				)
			);
		}
	);
}

describe('publication manifest storage', () => {
	it('catalogues constant-size legacy preparation triggers without advancing proof fences', async () => {
		await withStorage('legacy-prepare-plans', (storage) => {
			expect(
				storage
					.exec(
						"SELECT name,tbl_name FROM sqlite_master WHERE name IN ('result_publication_narinfo_prepare_insert','result_publication_narinfo_prepare_update') ORDER BY name"
					)
					.toArray()
			).toStrictEqual([
				{
					name: 'result_publication_narinfo_prepare_insert',
					tbl_name: 'narinfo'
				},
				{
					name: 'result_publication_narinfo_prepare_update',
					tbl_name: 'narinfo'
				}
			]);
			for (const event of ['insert', 'update']) {
				const definition = storage
					.exec<{ sql: string }>(
						'SELECT sql FROM sqlite_master WHERE name=?',
						`result_publication_narinfo_prepare_${event}`
					)
					.one().sql;
				const body = definition
					.slice(definition.indexOf('BEGIN') + 5, definition.lastIndexOf('END'))
					.trim();
				expect(body).not.toContain('publication_manifest_availability');
				expect(body).not.toContain('result_publication');
				expect(body).not.toContain('publication_manifest_operation');
				const statement = body
					.replaceAll('NEW.`cache_id`', '10')
					.replaceAll('NEW.`store_path_hash`', "'tool'");
				const plan = Array.from(
					storage.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement}`),
					(row) => row.detail
				).join('\n');
				expect(plan).toContain('sqlite_autoindex_narinfo_1');
				expect(plan).toContain(
					'sqlite_autoindex_publication_manifest_local_identity_1'
				);
				expect(plan).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
			}
		});
	});

	it('matches the migration snapshot columns and indexes for availability, local identity and lifecycle storage', async () => {
		await withStorage('snapshot-catalogue', (storage) => {
			for (const name of [
				'publication_manifest_availability_clock',
				'publication_manifest_availability_revision',
				'publication_manifest_availability_intent',
				'publication_manifest_local_identity',
				'publication_manifest_lifecycle_intent',
				'publication_manifest_operation',
				'publication_operation'
			] as const) {
				const table = snapshot.tables[name];
				const expected = Object.values(table.columns).map((column) => ({
					name: column.name,
					type: column.type,
					notNull: column.notNull
				}));
				const actual = Array.from(
					storage.exec<{ name: string; type: string; notnull: number }>(
						`PRAGMA table_info('${name}')`
					),
					(column) => ({
						name: column.name,
						type: column.type.toLowerCase(),
						notNull: column.notnull === 1
					})
				);
				expect(actual, name).toStrictEqual(expected);
				const actualIndexes = [
					...storage.exec<{ name: string; origin: string }>(
						`PRAGMA index_list('${name}')`
					)
				]
					.filter((index) => index.origin === 'c')
					.map((index) => ({
						name: index.name,
						columns: Array.from(
							storage.exec<{ name: string }>(
								`PRAGMA index_info('${index.name}')`
							),
							(column) => column.name
						)
					}))
					.toSorted((left, right) => left.name.localeCompare(right.name));
				const expectedIndexes = Object.values(table.indexes)
					.map((index) => ({ name: index.name, columns: index.columns }))
					.toSorted((left, right) => left.name.localeCompare(right.name));
				expect(actualIndexes, name).toStrictEqual(expectedIndexes);
			}
		});
	});

	it('defaults ordinary publication origins to NULL and persists a manifest origin without changing the declaration', async () => {
		await runInDurableObject(
			testServerFor('manifest-publication-origin'),
			async (_instance, state) => {
				await migrateThrough(state, 82);
				const storage = state.storage.sql;
				const insert =
					"INSERT INTO publication_operation(id,cache_id,cache_generation,push_id,canonical_json,accepted_at,push_expires_at,recovery_deadline,prune_after,grace_decision_json) VALUES (?,10,3,'push','{\"storePath\":\"/nix/store/result-app\",\"narHash\":\"sha256:nar\"}','2026-01-01T00:00:00.000Z','2026-01-01T01:00:00.000Z','2026-01-02T00:00:00.000Z','2026-01-02T00:15:00.000Z','{}')";
				storage.exec(insert, 'legacy');
				const legacy = storage
					.exec('SELECT * FROM publication_operation')
					.one();
				await migrateThrough(state, 83);
				expect(
					storage.exec('SELECT * FROM publication_operation').toArray()
				).toStrictEqual([{ ...legacy, manifest_operation_id: sqlNull }]);
				storage.exec(insert, 'ordinary');
				storage.exec(insert, 'manifest');
				const manifestOperationId = publicationOperationIdSchema.parse(
					'00000000-0000-4000-8000-000000000001'
				);
				const database = drizzle(state.storage, { schema });
				database
					.update(schema.publicationOperations)
					.set({ manifestOperationId })
					.where(
						eq(
							schema.publicationOperations.id,
							uploadIdSchema.parse('manifest')
						)
					)
					.run();
				expect(
					storage
						.exec('SELECT * FROM publication_operation ORDER BY id')
						.toArray()
				).toStrictEqual([
					{ ...legacy, manifest_operation_id: sqlNull },
					{
						...legacy,
						id: 'manifest',
						manifest_operation_id: manifestOperationId
					},
					{ ...legacy, id: 'ordinary', manifest_operation_id: sqlNull }
				]);
			}
		);
	});

	it('adds fifteen tables, resumable GC fields and an ordinary publication origin without changing accepted versions', async () => {
		expect(snapshot).toStrictEqual({
			...previousSnapshot,
			id: snapshot.id,
			prevId: previousSnapshot.id,
			tables: {
				...previousSnapshot.tables,
				garbage_collection_scan: snapshot.tables.garbage_collection_scan,
				publication_operation: {
					...previousSnapshot.tables.publication_operation,
					columns: {
						...previousSnapshot.tables.publication_operation.columns,
						manifest_operation_id: {
							name: 'manifest_operation_id',
							type: 'text',
							primaryKey: false,
							notNull: false,
							autoincrement: false
						}
					}
				},
				publication_manifest: snapshot.tables.publication_manifest,
				publication_manifest_local_identity:
					snapshot.tables.publication_manifest_local_identity,
				publication_manifest_lifecycle_intent:
					snapshot.tables.publication_manifest_lifecycle_intent,
				publication_manifest_availability_clock:
					snapshot.tables.publication_manifest_availability_clock,
				publication_manifest_availability_revision:
					snapshot.tables.publication_manifest_availability_revision,
				publication_manifest_availability_intent:
					snapshot.tables.publication_manifest_availability_intent,
				publication_manifest_cardinality:
					snapshot.tables.publication_manifest_cardinality,
				publication_manifest_admission:
					snapshot.tables.publication_manifest_admission,
				publication_manifest_work_hold:
					snapshot.tables.publication_manifest_work_hold,
				publication_manifest_member:
					snapshot.tables.publication_manifest_member,
				result_publication: snapshot.tables.result_publication,
				result_publication_member: snapshot.tables.result_publication_member,
				publication_manifest_operation:
					snapshot.tables.publication_manifest_operation,
				publication_manifest_operation_page:
					snapshot.tables.publication_manifest_operation_page,
				publication_manifest_retirement:
					snapshot.tables.publication_manifest_retirement
			}
		});
		await runInDurableObject(
			testServerFor('publication-manifests-upgrade'),
			async (_instance, state) => {
				await migrateThrough(state, 82);
				insertCache(state.storage.sql);
				insertNarInfo(state.storage.sql, resultHash, resultPath);
				state.storage.sql.exec(
					"INSERT INTO generation_seq(cache_kind,cache_name,store_path_hash,next_generation) VALUES ('named','cache-10','result',8)"
				);
				const before = state.storage.sql
					.exec('SELECT * FROM narinfo')
					.toArray();
				const sequences = state.storage.sql
					.exec('SELECT * FROM generation_seq')
					.toArray();
				await migrateThrough(state, 83);
				await migrateThrough(state, 83);
				expect(
					state.storage.sql.exec('SELECT * FROM narinfo').toArray()
				).toStrictEqual(before);
				expect(
					state.storage.sql.exec('SELECT * FROM generation_seq').toArray()
				).toStrictEqual(sequences);
				expect(
					state.storage.sql
						.exec(
							'SELECT cache_id,store_path_hash,generation,store_path,nar_hash FROM publication_manifest_local_identity'
						)
						.toArray()
				).toStrictEqual([]);
				const database = drizzle(state.storage, { schema });
				expect(
					database.select().from(schema.resultPublications).all()
				).toStrictEqual([]);
				expect(
					database.select().from(schema.publicationManifests).all()
				).toStrictEqual([]);
				database
					.insert(schema.publicationManifestRetirements)
					.values({ materialisationId: 'private' })
					.run();
				const retirement = database
					.select()
					.from(schema.publicationManifestRetirements)
					.get();
				expect(retirement?.materialisationId).toBe('private');
				expect(retirement?.digest).toBeNull();
			}
		);
		await withStorage('fresh', (storage) => {
			const triggers = new Map(
				Array.from(
					storage.exec<{ name: string; tbl_name: string }>(
						"SELECT name,tbl_name FROM sqlite_master WHERE type='trigger'"
					),
					(row) => [row.name, row.tbl_name] as const
				)
			);
			for (const trigger of collectionTriggers) {
				expect(triggers.get(trigger.name)).toBe(trigger.table);
			}
		});
	});

	it.each([
		'delete',
		'cache',
		'hash',
		'path',
		'nar',
		'generation',
		'replace'
	] as const)(
		'invalidates only exact referencing associations on member %s',
		async (mutation) => {
			await withStorage(`member-${mutation}`, (storage, store) => {
				insertCache(storage, 11);
				for (const owner of [
					'exact',
					'other-nar',
					'other-version',
					'other-path',
					'matches-replacement'
				]) {
					insertAssociation(storage, owner);
				}
				insertAssociation(storage, 'other-cache', 7, 11);
				insertAssociation(storage, 'other-cache-version', 7, cacheId, 2);
				insertEdge(storage, 'exact');
				insertEdge(storage, 'other-nar', 'sha256:other');
				insertEdge(storage, 'other-version', 'sha256:nar', 8);
				insertEdge(
					storage,
					'other-path',
					'sha256:nar',
					7,
					cacheId,
					cacheGeneration,
					'/nix/store/tool-unrelated'
				);
				insertEdge(storage, 'matches-replacement', 'sha256:replacement', 8);
				insertEdge(storage, 'other-cache', 'sha256:nar', 7, 11);
				insertEdge(storage, 'other-cache-version', 'sha256:nar', 7, cacheId, 2);
				const before = associations(storage);
				const mutations = {
					delete:
						"DELETE FROM narinfo WHERE cache_id=10 AND store_path_hash='tool'",
					cache:
						"UPDATE narinfo SET cache_id=11 WHERE cache_id=10 AND store_path_hash='tool'",
					hash: "UPDATE narinfo SET store_path_hash='moved' WHERE cache_id=10 AND store_path_hash='tool'",
					path: "UPDATE narinfo SET store_path='/nix/store/tool-replaced' WHERE cache_id=10 AND store_path_hash='tool'",
					nar: "UPDATE narinfo SET nar_hash='sha256:replacement' WHERE cache_id=10 AND store_path_hash='tool'",
					generation:
						"UPDATE narinfo SET generation=8 WHERE cache_id=10 AND store_path_hash='tool'",
					replace:
						"INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (10,'tool','/nix/store/tool-compiler','sha256:replacement',10,'[]',8,'2026-01-01T00:00:00.000Z')"
				};
				if (mutation === 'replace') {
					expect(
						storage.exec('PRAGMA recursive_triggers').one().recursive_triggers
					).toBe(0);
				}
				storage.exec(mutations[mutation]);
				expect(associations(storage)).toStrictEqual(before);
				expect(
					store.hasPending({
						cacheId: cacheIdSchema.parse(cacheId),
						cacheGeneration: cacheGenerationSchema.parse(cacheGeneration)
					})
				).toBe(true);
				expect(store.nextIntent(true)).toBeUndefined();
				expect(withRowBudget(() => store.drain())).toBe(false);
				expect(associations(storage)).toStrictEqual(
					before.map((row) =>
						row.result_hash === 'exact' ||
						(mutation === 'replace' &&
							row.cache_id === cacheId &&
							row.cache_generation === cacheGeneration &&
							row.result_hash !== 'matches-replacement')
							? { ...row, complete: 0 }
							: row
					)
				);
				expect(
					storage.exec('SELECT * FROM result_publication_member').toArray()
				).toHaveLength(7);
				expect(
					storage.exec('SELECT * FROM publication_manifest').toArray()
				).toHaveLength(1);
			});
		}
	);

	it('removes only the exact owning result and queues its edges, preserving other desired manifests', async () => {
		await withStorage('owner-delete', (storage) => {
			insertAssociation(storage);
			insertAssociation(storage, resultHash, 8);
			insertAssociation(storage, 'other');
			insertEdge(storage);
			insertEdge(storage, 'other');
			storage.exec(
				"DELETE FROM narinfo WHERE cache_id=10 AND store_path_hash='result'"
			);
			expect(
				associations(storage).map((row) => [
					row.result_hash,
					row.result_generation
				])
			).toStrictEqual([
				['other', 7],
				['result', 8]
			]);
			expect(
				storage
					.exec(
						'SELECT result_hash FROM result_publication_member ORDER BY result_hash'
					)
					.toArray()
			).toStrictEqual([{ result_hash: 'other' }, { result_hash: 'result' }]);
			expect(retirements(storage)).toStrictEqual([
				{ materialisation_id: 'selected-10-3-result-7', digest: 'digest' }
			]);
			expect(
				storage.exec('SELECT * FROM publication_manifest').toArray()
			).toHaveLength(1);
		});
	});

	it.each(['generation', 'path', 'nar'] as const)(
		'removes incompatible owning-result snapshots after a real %s replacement',
		async (changed) => {
			await withStorage(`owner-replace-${changed}`, (storage, store) => {
				insertCache(storage, 11);
				insertAssociation(storage);
				insertEdge(storage);
				insertAssociation(storage, resultHash, 8);
				insertAssociation(storage, resultHash, 7, cacheId, 2);
				insertEdge(storage, resultHash, 'sha256:nar', 7, cacheId, 2);
				insertAssociation(storage, resultHash, 7, 11);
				insertEdge(storage, resultHash, 'sha256:nar', 7, 11);
				insertAssociation(storage, 'other');
				insertEdge(storage, 'other');
				const generation = changed === 'generation' ? 8 : 7;
				const path =
					changed === 'path' ? '/nix/store/result-replaced' : resultPath;
				const narHash = changed === 'nar' ? 'sha256:replacement' : 'sha256:nar';
				storage.exec(
					"INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (10,'result',?,?,10,'[]',?,'2026-01-01T00:00:00.000Z')",
					path,
					narHash,
					generation
				);
				expect(store.nextIntent(false)?.kind).toBe('local-replace');
				expect(withRowBudget(() => store.drain())).toBe(false);
				expect(
					associations(storage).map((row) => [
						row.cache_id,
						row.cache_generation,
						row.result_hash,
						row.result_generation
					])
				).toStrictEqual([
					[10, 2, 'result', 7],
					[10, 3, 'other', 7],
					...(changed === 'generation' ? [[10, 3, 'result', 8]] : []),
					[11, 3, 'result', 7]
				]);
				expect(
					storage
						.exec(
							'SELECT cache_id,cache_generation,result_hash FROM result_publication_member ORDER BY cache_id,cache_generation,result_hash'
						)
						.toArray()
				).toStrictEqual([
					{ cache_id: 10, cache_generation: 2, result_hash: 'result' },
					{ cache_id: 10, cache_generation: 3, result_hash: 'other' },
					{ cache_id: 10, cache_generation: 3, result_hash: 'result' },
					{ cache_id: 11, cache_generation: 3, result_hash: 'result' }
				]);
				expect(retirements(storage)).toStrictEqual([
					{ materialisation_id: 'selected-10-3-result-7', digest: 'digest' },
					...(changed === 'generation'
						? []
						: [
								{
									materialisation_id: 'selected-10-3-result-8',
									digest: 'digest'
								}
							])
				]);
				expect(
					storage.exec('SELECT * FROM publication_manifest').toArray()
				).toHaveLength(1);
			});
		}
	);

	it('retires only old lifecycle selections and never adopts them across cache recreation', async () => {
		await withStorage('cache-recreation', (storage, store) => {
			insertAssociation(storage);
			insertEdge(storage);
			const old = associations(storage);
			storage.exec('UPDATE cache_identity SET generation=4 WHERE id=10');
			expect(associations(storage)).toStrictEqual(old);
			expect(store.nextLifecycleIntent()).toStrictEqual({
				revision: 1,
				cacheId: 10,
				cacheGeneration: 3,
				phase: 'associations',
				cursorResultHash: sqlNull,
				cursorResultGeneration: sqlNull,
				cursorOperationId: sqlNull
			});
			insertAssociation(storage, resultHash, 7, cacheId, 4);
			storage.exec(
				'UPDATE result_publication SET complete=0 WHERE cache_generation=4'
			);
			expect(withRowBudget(() => store.drain())).toBe(false);
			expect(associations(storage)).toStrictEqual([
				{
					cache_id: 10,
					cache_generation: 4,
					result_hash: resultHash,
					result_generation: 7,
					complete: 0
				}
			]);
			expect(retirements(storage)).toStrictEqual([
				{ materialisation_id: 'selected-10-3-result-7', digest: 'digest' }
			]);
			storage.exec(
				"UPDATE cache_identity SET deleted_at='2026-02-01T00:00:00.000Z' WHERE id=10"
			);
			expect(store.nextLifecycleIntent()?.cacheGeneration).toBe(4);
			expect(withRowBudget(() => store.drain())).toBe(false);
			expect(associations(storage)).toStrictEqual([]);
			insertCache(storage, 11, 5);
			storage.exec("UPDATE cache_identity SET name='cache-10' WHERE id=11");
			expect(
				storage
					.exec(
						"SELECT id,generation FROM cache_identity WHERE name='cache-10' AND deleted_at IS NULL"
					)
					.toArray()
			).toStrictEqual([{ id: 11, generation: 5 }]);
			insertNarInfo(storage, resultHash, resultPath, 8, 11);
			expect(
				storage
					.exec('SELECT * FROM result_publication WHERE cache_id=11')
					.toArray()
			).toStrictEqual([]);
		});
	});

	it('fences physical cache deletion then retires its pointers without removing immutable members', async () => {
		await withStorage('cache-delete', (storage, store) => {
			insertAssociation(storage);
			insertEdge(storage);
			const before = {
				associations: associations(storage),
				members: storage
					.exec('SELECT * FROM result_publication_member')
					.toArray()
			};
			storage.exec('DELETE FROM cache_identity WHERE id=10');
			expect(associations(storage)).toStrictEqual(before.associations);
			expect(store.nextLifecycleIntent()?.cacheId).toBe(10);
			expect(withRowBudget(() => store.drain())).toBe(false);
			expect(associations(storage)).toStrictEqual([]);
			expect(
				storage.exec('SELECT * FROM result_publication_member').toArray()
			).toStrictEqual(before.members);
			expect(retirements(storage)).toStrictEqual([
				{ materialisation_id: 'selected-10-3-result-7', digest: 'digest' }
			]);
		});
	});

	it.each([false, true])(
		'preserves whole selections, GC edges and fences on identical narinfo replays with recursive triggers %s',
		async (recursive) => {
			await withStorage(
				`identical-narinfo-${recursive.toString()}`,
				(storage) => {
					storage.exec(`PRAGMA recursive_triggers=${recursive ? 'ON' : 'OFF'}`);
					storage.exec(
						"INSERT INTO garbage_collection_scan(cache_id,phase) VALUES (10,'collect')"
					);
					storage.exec(
						"INSERT INTO garbage_collection_mark(cache_id,store_path_hash) VALUES (10,'result')"
					);
					insertAssociation(storage);
					insertEdge(storage);
					insertAssociation(storage, 'other');
					insertEdge(storage, 'other');
					storage.exec(
						`UPDATE narinfo SET sigs_json='["signature"]',references_json='["runtime-child"]' WHERE cache_id=10`
					);
					const before = publicationStorageState(storage);
					const narinfos = storage
						.exec('SELECT * FROM narinfo ORDER BY cache_id,store_path_hash')
						.toArray();
					for (const statement of [
						'INSERT INTO narinfo SELECT * FROM narinfo WHERE cache_id=10 ON CONFLICT DO NOTHING',
						"INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (10,'result','/nix/store/result-app','sha256:nar',10,'[]',8,'2026-01-01T00:00:00.000Z') ON CONFLICT DO NOTHING",
						"INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (10,'tool','/nix/store/tool-different','sha256:replacement',10,'[]',8,'2026-01-01T00:00:00.000Z') ON CONFLICT DO NOTHING",
						"INSERT OR REPLACE INTO narinfo SELECT * FROM narinfo WHERE cache_id=10 AND store_path_hash IN ('result','tool')"
					]) {
						storage.exec(statement);
						expect(publicationStorageState(storage), statement).toStrictEqual(
							before
						);
						expect(
							storage
								.exec('SELECT * FROM narinfo ORDER BY cache_id,store_path_hash')
								.toArray()
						).toStrictEqual(narinfos);
					}
					insertNarInfo(storage, 'unrelated', '/nix/store/unrelated-app');
					storage.exec("DELETE FROM narinfo WHERE store_path_hash='unrelated'");
					expect(
						storage
							.exec(
								'SELECT * FROM result_publication ORDER BY materialisation_id'
							)
							.toArray()
					).toStrictEqual(before.associations);
					expect(
						storage
							.exec(
								'SELECT * FROM result_publication_member ORDER BY materialisation_id,member_hash'
							)
							.toArray()
					).toStrictEqual(before.proofs);
				}
			);
		}
	);

	it('guards every narinfo column through one indexed identical-row lookup', async () => {
		await withStorage('identical-narinfo-plan', (storage) => {
			const definition = storage
				.exec<{ sql: string }>(
					"SELECT sql FROM sqlite_master WHERE name='result_publication_narinfo_identical_insert' AND tbl_name='narinfo'"
				)
				.one().sql;
			const predicate = definition
				.slice(definition.indexOf('WHEN ') + 5, definition.indexOf('BEGIN'))
				.trim();
			const columns = Array.from(
				storage.exec<{ name: string }>('PRAGMA table_info(narinfo)'),
				(row) => row.name
			).toSorted((left, right) => left.localeCompare(right));
			expect(
				definition
					.matchAll(/NEW\.`(\w+)`/g)
					.flatMap((match) => match.slice(1))
					.toArray()
					.toSorted((left, right) => left.localeCompare(right))
			).toStrictEqual(columns);
			const query = `SELECT ${predicate.replaceAll(/NEW\.`(\w+)`/g, 'n.`$1`')} AS identical FROM narinfo AS n WHERE n.cache_id=10 AND n.store_path_hash='result'`;
			const plan = Array.from(
				storage.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`),
				(row) => row.detail
			).join('\n');
			expect(plan).toContain('sqlite_autoindex_narinfo_1');
			expect(plan).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
			expect(storage.exec(query).toArray()).toStrictEqual([{ identical: 1 }]);
		});
	});

	it.each(
		(
			[
				['nar_size', 20],
				['references_json', '["runtime-child"]'],
				['deriver', '/nix/store/deriver.drv'],
				['ca', 'fixed:r:sha256:content'],
				['sigs_json', '["signature"]'],
				['signature_generation', 1],
				['pending_signature_generation', 1],
				['created_at', '2026-02-01T00:00:00.000Z'],
				['retention_epoch', 1],
				['inheritance_exhausted', 1]
			] as const
		).flatMap(([column, value]) =>
			[false, true].map((recursive) => ({ column, value, recursive }))
		)
	)(
		'accepts a non-identical $column REPLACE with recursive triggers $recursive',
		async ({ column, value, recursive }) => {
			await withStorage(`meta-${column}-${recursive.toString()}`, (storage) => {
				storage.exec(`PRAGMA recursive_triggers=${recursive ? 'ON' : 'OFF'}`);
				insertAssociation(storage);
				insertEdge(storage);
				insertAssociation(storage, 'unrelated');
				insertEdge(storage, 'unrelated');
				const before = publicationStorageState(storage);
				const narinfos = storage
					.exec('SELECT * FROM narinfo ORDER BY cache_id,store_path_hash')
					.toArray();
				const columns = Array.from(
					storage.exec<{ name: string }>('PRAGMA table_info(narinfo)'),
					(row) => row.name
				);
				storage.exec(
					`INSERT OR REPLACE INTO narinfo SELECT ${columns.map((name) => (name === column ? '?' : name)).join(',')} FROM narinfo WHERE cache_id=10 AND store_path_hash='result'`,
					value
				);
				expect(
					storage
						.exec('SELECT * FROM narinfo ORDER BY cache_id,store_path_hash')
						.toArray()
				).toStrictEqual(
					narinfos.map((row) =>
						row.store_path_hash === 'result' ? { ...row, [column]: value } : row
					)
				);
				const version = {
					cache_id: 10,
					cache_generation: 3,
					store_path_hash: 'result',
					generation: 7,
					store_path: resultPath,
					nar_hash: 'sha256:nar',
					revision: 1
				};
				expect(publicationStorageState(storage)).toStrictEqual(
					recursive
						? {
								...before,
								associations: before.associations.filter(
									(row) => row.result_hash !== resultHash
								),
								retirements: [
									{
										materialisation_id: 'selected-10-3-result-7',
										digest: 'digest'
									}
								],
								clock: [{ id: 1, revision: 1, lifecycle_revision: 0 }],
								revisions: [version],
								intents: [
									{
										...version,
										kind: 'local',
										remote_pending: 0,
										cursor_materialisation_id: sqlNull,
										cursor_member_generation: sqlNull,
										cursor_member_path: sqlNull,
										cursor_member_nar_hash: sqlNull,
										cursor_owner_generation: sqlNull,
										phase: 'proofs',
										replacement_generation: sqlNull,
										replacement_path: sqlNull,
										replacement_nar_hash: sqlNull
									}
								]
							}
						: before
				);
			});
		}
	);

	it.each([false, true])(
		'invalidates both selected certificates on a colliding proof UPDATE OR REPLACE with recursive triggers %s',
		async (recursive) => {
			await withStorage(
				`proof-update-replace-${recursive.toString()}`,
				(storage) => {
					storage.exec(`PRAGMA recursive_triggers=${recursive ? 'ON' : 'OFF'}`);
					for (const id of ['first', 'second', 'unrelated']) {
						storage.exec(
							"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) VALUES (?,?,'capture',10,3,'{}','{}','build-selection',1,'2099-01-01T00:00:00.000Z')",
							id,
							id
						);
						insertAssociation(storage, id, 7, cacheId, cacheGeneration, id);
						insertEdge(
							storage,
							id,
							id === 'first' ? 'sha256:stale' : 'sha256:nar',
							id === 'first' ? 6 : 7,
							cacheId,
							cacheGeneration,
							memberPath,
							id
						);
					}
					const before = publicationStorageState(storage);
					storage.exec(
						'INSERT OR REPLACE INTO result_publication_member SELECT * FROM result_publication_member'
					);
					expect(publicationStorageState(storage)).toStrictEqual(before);
					storage.exec(
						"UPDATE OR REPLACE result_publication_member SET materialisation_id='second',result_hash='second' WHERE materialisation_id='first'"
					);
					expect(publicationStorageState(storage)).toStrictEqual({
						...before,
						associations: before.associations.map((row) =>
							row.materialisation_id === 'unrelated'
								? row
								: { ...row, complete: 0 }
						),
						proofs: before.proofs
							.filter((row) => row.materialisation_id !== 'second')
							.map((row) =>
								row.materialisation_id === 'first'
									? {
											...row,
											materialisation_id: 'second',
											result_hash: 'second'
										}
									: row
							),
						cardinalities: before.cardinalities.map((row) =>
							row.id === 'first'
								? { ...row, member_count: 0, valid: 0 }
								: row.id === 'second'
									? { ...row, member_count: recursive ? 1 : 2, valid: 0 }
									: row
						)
					});
					const after = publicationStorageState(storage);
					storage.exec(
						"INSERT OR REPLACE INTO result_publication_member SELECT * FROM result_publication_member WHERE materialisation_id='second'"
					);
					expect(publicationStorageState(storage)).toStrictEqual(after);
				}
			);
		}
	);

	it('barriers inserted and finalised edges only from a marked exact owner, including incomplete associations', async () => {
		await withStorage('barrier', (storage) => {
			storage.exec(
				"INSERT INTO garbage_collection_scan(cache_id,phase) VALUES (10,'collect')"
			);
			storage.exec(
				"INSERT INTO garbage_collection_mark(cache_id,store_path_hash) VALUES (10,'result')"
			);
			insertAssociation(storage);
			storage.exec('UPDATE result_publication SET complete=0');
			storage.exec('DELETE FROM garbage_collection_frontier');
			storage.exec('UPDATE garbage_collection_input SET inputs_changed=0');
			insertEdge(storage);
			expect(frontier(storage)).toStrictEqual([
				{ store_path_hash: memberHash }
			]);
			expect(
				storage
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.one().inputs_changed
			).toBe(1);
			storage.exec('DELETE FROM garbage_collection_frontier');
			storage.exec('UPDATE garbage_collection_input SET inputs_changed=0');
			storage.exec('UPDATE result_publication SET complete=1');
			expect(frontier(storage)).toStrictEqual([
				{ store_path_hash: resultHash }
			]);
			expect(
				storage
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.one().inputs_changed
			).toBe(1);
			storage.exec('DELETE FROM garbage_collection_frontier');
			storage.exec('UPDATE result_publication_member SET member_generation=8');
			expect(frontier(storage)).toStrictEqual([]);
			storage.exec(
				"UPDATE narinfo SET generation=8 WHERE store_path_hash='result'"
			);
			storage.exec('DELETE FROM garbage_collection_frontier');
			insertAssociation(
				storage,
				resultHash,
				7,
				cacheId,
				cacheGeneration,
				'obsolete'
			);
			insertEdge(
				storage,
				resultHash,
				'sha256:nar',
				7,
				cacheId,
				cacheGeneration,
				memberPath,
				'obsolete'
			);
			expect(frontier(storage)).toStrictEqual([]);
		});
	});

	it('persists scoped request identities and page replay keys without accepting changed immutable content', async () => {
		await withStorage('replay', (storage) => {
			const insertOperation =
				"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) VALUES (?,? ,?,?,?,'canonical','{}','build-selection',2,'2026-02-01T00:00:00.000Z')";
			storage.exec(insertOperation, 'operation', 'request', 'capture', 10, 3);
			expect(() =>
				storage.exec(insertOperation, 'duplicate', 'request', 'capture', 10, 3)
			).toThrow(/UNIQUE constraint failed/);
			expect(() =>
				storage.exec(
					insertOperation.replace("'canonical'", "'changed'"),
					'changed',
					'request',
					'capture',
					10,
					3
				)
			).toThrow(/UNIQUE constraint failed/);
			storage.exec(insertOperation, 'other-cache', 'request', 'capture', 11, 3);
			storage.exec(
				insertOperation,
				'other-version',
				'request',
				'capture',
				10,
				4
			);
			storage.exec(insertOperation, 'other-kind', 'request', 'ensure', 10, 3);
			const insertPage =
				'INSERT INTO publication_manifest_operation_page(operation_id,page,payload_digest,payload_json) VALUES (?,?,?,?)';
			storage.exec(insertPage, 'operation', 0, 'page-digest', '["member"]');
			expect(() =>
				storage.exec(insertPage, 'operation', 0, 'page-digest', '["member"]')
			).toThrow(/UNIQUE constraint failed/);
			storage.exec(
				`${insertPage} ON CONFLICT (operation_id,page) DO NOTHING`,
				'operation',
				0,
				'page-digest',
				'["member"]'
			);
			for (const [digest, payload] of [
				['changed', '["member"]'],
				['page-digest', '["changed"]']
			] as const) {
				expect(() =>
					storage.exec(
						`${insertPage} ON CONFLICT (operation_id,page) DO NOTHING`,
						'operation',
						0,
						digest,
						payload
					)
				).toThrow(/publication manifest content is immutable/);
			}
			storage.exec(insertPage, 'other-cache', 0, 'page-digest', '["member"]');
			expect(() =>
				storage.exec(insertPage, 'operation', -1, 'bad', '[]')
			).toThrow(/CHECK constraint failed/);
			storage.exec(
				"UPDATE publication_manifest_operation SET next_page=1,cursor=1 WHERE id='operation'"
			);
			expect(
				storage
					.exec(
						"SELECT canonical_json,next_page,cursor,state FROM publication_manifest_operation WHERE id='operation'"
					)
					.one()
			).toStrictEqual({
				canonical_json: 'canonical',
				next_page: 1,
				cursor: 1,
				state: 'pending'
			});
			expect(
				storage
					.exec(
						"SELECT * FROM publication_manifest_operation_page WHERE operation_id='operation'"
					)
					.toArray()
			).toStrictEqual([
				{
					operation_id: 'operation',
					page: 0,
					payload_digest: 'page-digest',
					payload_json: '["member"]'
				}
			]);
		});
	});

	it.each([
		{
			name: 'header update',
			mutation:
				"UPDATE publication_manifest SET member_count=3 WHERE digest='digest'"
		},
		{
			name: 'member update',
			mutation:
				"UPDATE publication_manifest_member SET nar_hash='changed' WHERE digest='digest'"
		},
		{
			name: 'page update',
			mutation:
				"UPDATE publication_manifest_operation_page SET payload_json='changed' WHERE operation_id='operation'"
		},
		{
			name: 'header replacement',
			mutation:
				"INSERT OR REPLACE INTO publication_manifest(digest,version,member_count) VALUES ('digest',1,3)"
		},
		{
			name: 'member ordinal replacement',
			mutation:
				"INSERT OR REPLACE INTO publication_manifest_member(digest,ordinal,store_path,store_path_hash,nar_hash) VALUES ('digest',0,'/nix/store/tool-compiler','tool','changed')"
		},
		{
			name: 'member path replacement',
			mutation:
				"INSERT OR REPLACE INTO publication_manifest_member(digest,ordinal,store_path,store_path_hash,nar_hash) VALUES ('digest',1,'/nix/store/tool-compiler','tool','sha256:nar')"
		},
		{
			name: 'page replacement',
			mutation:
				"INSERT OR REPLACE INTO publication_manifest_operation_page(operation_id,page,payload_digest,payload_json) VALUES ('operation',0,'changed','changed')"
		}
	])(
		'rejects immutable content $name without changing stored bytes',
		async ({ name, mutation }) => {
			await withStorage(`immutable-${name.replaceAll(' ', '-')}`, (storage) => {
				storage.exec(
					"INSERT INTO publication_manifest(digest,version,member_count) VALUES ('digest',1,2)"
				);
				storage.exec(
					"INSERT INTO publication_manifest_member(digest,ordinal,store_path,store_path_hash,nar_hash) VALUES ('digest',0,'/nix/store/tool-compiler','tool','sha256:nar')"
				);
				storage.exec(
					"INSERT INTO publication_manifest_operation_page(operation_id,page,payload_digest,payload_json) VALUES ('operation',0,'page-digest','[1]')"
				);
				const before = {
					manifest: storage
						.exec('SELECT * FROM publication_manifest')
						.toArray(),
					members: storage
						.exec('SELECT * FROM publication_manifest_member')
						.toArray(),
					pages: storage
						.exec('SELECT * FROM publication_manifest_operation_page')
						.toArray()
				};
				expect(() => storage.exec(mutation)).toThrow(
					/publication manifest content is immutable/
				);
				expect({
					manifest: storage
						.exec('SELECT * FROM publication_manifest')
						.toArray(),
					members: storage
						.exec('SELECT * FROM publication_manifest_member')
						.toArray(),
					pages: storage
						.exec('SELECT * FROM publication_manifest_operation_page')
						.toArray()
				}).toStrictEqual(before);
			});
		}
	);

	it('uses indexed mutation lookups and bounded association GC paging', async () => {
		await withStorage('query-plans', (storage) => {
			insertAssociation(storage);
			insertEdge(storage);
			const literals: Readonly<Record<string, string>> = {
				id: '10',
				cache_id: '10',
				cache_generation: '3',
				store_path_hash: "'tool'",
				generation: '7',
				store_path: "'/nix/store/tool-compiler'",
				nar_hash: "'sha256:nar'",
				result_hash: "'result'",
				result_generation: '7',
				member_hash: "'tool'",
				materialisation_id: "'selected-10-3-result-7'",
				member_path: "'/nix/store/tool-compiler'",
				member_nar_hash: "'sha256:nar'",
				member_generation: '7',
				digest: "'digest'"
			};
			for (const name of [
				'result_publication_narinfo_insert',
				'result_publication_narinfo_delete',
				'result_publication_narinfo_update',
				'result_publication_delete',
				'result_publication_materialisation_update',
				'result_publication_cache_identity_update',
				'result_publication_cache_identity_delete',
				'result_publication_barrier_member_insert',
				'result_publication_barrier_member_update',
				'result_publication_barrier_insert',
				'result_publication_barrier_update',
				'publication_manifest_operation_cardinality_insert',
				'publication_manifest_operation_cardinality_delete',
				'publication_manifest_cardinality_insert',
				'publication_manifest_cardinality_delete',
				'result_publication_member_cardinality_insert',
				'result_publication_member_cardinality_delete',
				'result_publication_member_cardinality_update',
				'publication_manifest_member_cardinality_insert',
				'publication_manifest_member_cardinality_delete',
				'result_publication_member_certificate_update',
				'result_publication_member_certificate_delete',
				'publication_manifest_member_certificate_delete'
			]) {
				const definition = storage
					.exec<{ sql: string }>(
						"SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
						name
					)
					.one().sql;
				if (
					name === 'result_publication_barrier_insert' ||
					name === 'result_publication_barrier_update'
				) {
					expect(definition, name).not.toContain('result_publication_member');
				}
				const statements = definition
					.slice(definition.indexOf('BEGIN') + 5, definition.lastIndexOf('END'))
					.split(';')
					.map((statement) => statement.trim())
					.filter((statement) => statement.length > 0);
				const details = statements.flatMap((statement) =>
					Array.from(
						storage.exec<{ detail: string }>(
							`EXPLAIN QUERY PLAN ${statement.replaceAll(
								/\b(?:OLD|NEW)\.`(\w+)`/g,
								(_match: string, column: string) => {
									const value = literals[column];
									if (value === undefined) {
										throw new Error(`No query-plan literal for ${column}`);
									}
									return value;
								}
							)}`
						),
						(row) => row.detail
					)
				);
				expect(details.join('\n'), name).not.toMatch(
					/\bSCAN (?:e|r|member|owner|c|result_publication(?:_member)?|publication_manifest_operation|narinfo|cache_identity)\b/
				);
				if (!name.startsWith('result_publication_narinfo_')) {
					continue;
				}
				expect(definition, name).not.toContain('result_publication_member');
				expect(definition, name).not.toContain(
					'UPDATE `publication_manifest_operation`'
				);
				expect(details.join('\n'), name).toContain(
					'publication_manifest_availability_clock'
				);
			}
			const lookupPlan = Array.from(
				storage.exec<{ detail: string }>(
					"EXPLAIN QUERY PLAN SELECT digest,origin,complete FROM result_publication WHERE cache_id=10 AND cache_generation=3 AND result_hash='result' AND result_generation=7 AND result_path='/nix/store/result-app' AND result_nar_hash='sha256:nar'"
				),
				(row) => row.detail
			).join('\n');
			expect(lookupPlan).toContain(
				'SEARCH result_publication USING INDEX sqlite_autoindex_result_publication_1'
			);
			expect(lookupPlan).not.toMatch(/\bSCAN\b/);
			const pagePlan = Array.from(
				storage.exec<{ detail: string }>(
					"EXPLAIN QUERY PLAN SELECT member_hash,member_path,member_nar_hash,member_generation FROM result_publication_member WHERE cache_id=10 AND cache_generation=3 AND result_hash='result' AND result_generation=7 AND materialisation_id='selected-10-3-result-7' AND member_hash > 'a' ORDER BY member_hash LIMIT 64"
				),
				(row) => row.detail
			).join('\n');
			expect(pagePlan).toContain(
				'SEARCH result_publication_member USING INDEX sqlite_autoindex_result_publication_member_1'
			);
			expect(pagePlan).toContain('member_hash>?');
			expect(pagePlan).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
		});
	});

	it('does not seed manifests or unmarked owners, and flags inputs between scans', async () => {
		await withStorage('no-seeds', (storage) => {
			storage.exec('UPDATE garbage_collection_input SET inputs_changed=0');
			insertAssociation(storage);
			insertEdge(storage);
			expect(frontier(storage)).toStrictEqual([]);
			expect(
				storage
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.one().inputs_changed
			).toBe(1);
			storage.exec(
				"INSERT INTO garbage_collection_scan(cache_id,phase) VALUES (10,'mark')"
			);
			storage.exec('DELETE FROM result_publication_member');
			insertEdge(storage);
			expect(frontier(storage)).toStrictEqual([]);
			expect(
				storage.exec('SELECT * FROM retention_root_target').toArray()
			).toStrictEqual([]);
			expect(
				storage.exec('SELECT * FROM retention_grace').toArray()
			).toStrictEqual([]);
		});
	});

	it('isolates competing candidate proofs and invalidates only the selected materialisation', async () => {
		await withStorage('competing', (storage, store) => {
			insertAssociation(
				storage,
				resultHash,
				7,
				cacheId,
				cacheGeneration,
				'winner'
			);
			insertEdge(
				storage,
				resultHash,
				'sha256:nar',
				7,
				cacheId,
				cacheGeneration,
				memberPath,
				'winner'
			);
			insertEdge(
				storage,
				resultHash,
				'sha256:other',
				8,
				cacheId,
				cacheGeneration,
				memberPath,
				'private'
			);
			storage.exec(
				"UPDATE narinfo SET generation=8,nar_hash='sha256:other' WHERE store_path_hash='tool'"
			);
			expect(withRowBudget(() => store.drain())).toBe(false);
			storage.exec('UPDATE result_publication SET complete=1');
			storage.exec("DELETE FROM narinfo WHERE store_path_hash='tool'");
			expect(withRowBudget(() => store.drain())).toBe(false);
			expect(associations(storage)[0]?.complete).toBe(1);
			expect(
				storage.exec('SELECT * FROM result_publication_member').toArray()
			).toHaveLength(2);
		});
	});

	it.each([
		'delete',
		'update',
		'cache',
		'hash',
		'path',
		'nar',
		'replace'
	] as const)(
		'fails only pending exact candidate proofs after narinfo %s',
		async (mutation) => {
			await withStorage(`proof-${mutation}`, (storage, store) => {
				insertCache(storage, 11);
				for (const id of ['pending', 'complete', 'other-version']) {
					storage.exec(
						"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) VALUES (?,?,'capture',10,3,'canonical','{}','build-selection',2,'2026-02-01T00:00:00.000Z')",
						id,
						id
					);
					insertEdge(
						storage,
						resultHash,
						'sha256:nar',
						id === 'other-version' ? 8 : 7,
						cacheId,
						cacheGeneration,
						memberPath,
						id
					);
				}
				storage.exec(
					"UPDATE publication_manifest_operation SET state='complete' WHERE id='complete'"
				);
				const mutations = {
					delete: "DELETE FROM narinfo WHERE store_path_hash='tool'",
					cache:
						"UPDATE narinfo SET cache_id=11 WHERE cache_id=10 AND store_path_hash='tool'",
					hash: "UPDATE narinfo SET store_path_hash='moved' WHERE store_path_hash='tool'",
					path: "UPDATE narinfo SET store_path='/nix/store/tool-other' WHERE store_path_hash='tool'",
					nar: "UPDATE narinfo SET nar_hash='sha256:other' WHERE store_path_hash='tool'",
					update:
						"UPDATE narinfo SET generation=8 WHERE store_path_hash='tool'",
					replace:
						"INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (10,'tool','/nix/store/tool-compiler','sha256:nar',10,'[]',8,'2026-01-01T00:00:00.000Z')"
				};
				storage.exec(mutations[mutation]);
				expect(store.nextIntent(false)?.remotePending).toBe(false);
				expect(
					storage
						.exec(
							'SELECT id,state FROM publication_manifest_operation ORDER BY id'
						)
						.toArray()
				).toStrictEqual([
					{ id: 'complete', state: 'complete' },
					{ id: 'other-version', state: 'pending' },
					{ id: 'pending', state: 'pending' }
				]);
				expect(withRowBudget(() => store.drain())).toBe(false);
				expect(
					storage
						.exec(
							'SELECT id,state FROM publication_manifest_operation ORDER BY id'
						)
						.toArray()
				).toStrictEqual([
					{ id: 'complete', state: 'complete' },
					{ id: 'other-version', state: 'pending' },
					{
						id: 'pending',
						state: 'failed'
					}
				]);
				expect(
					storage
						.exec(
							"SELECT failure_json FROM publication_manifest_operation WHERE id='pending'"
						)
						.one().failure_json
				).toBe('{"kind":"failed","reason":"generation-conflict"}');
				expect(
					storage
						.exec(
							"SELECT failure_json FROM publication_manifest_operation WHERE id='complete'"
						)
						.one().failure_json
				).toBeNull();
				expect(
					storage
						.exec(
							"SELECT failure_json FROM publication_manifest_operation WHERE id='other-version'"
						)
						.one().failure_json
				).toBeNull();
			});
		}
	);

	it('does not invalidate pending proofs for ignored conflicts or identical replacements', async () => {
		await withStorage('proof-ignored', (storage) => {
			storage.exec(
				"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) VALUES ('pending','request','ensure',10,3,'canonical','{}','build-selection',2,'2026-02-01T00:00:00.000Z')"
			);
			insertEdge(
				storage,
				resultHash,
				'sha256:nar',
				7,
				cacheId,
				cacheGeneration,
				memberPath,
				'pending'
			);
			storage.exec(
				"INSERT OR IGNORE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (10,'tool','/nix/store/tool-other','sha256:other',10,'[]',8,'2026-01-01T00:00:00.000Z')"
			);
			storage.exec(
				"INSERT OR REPLACE INTO narinfo SELECT * FROM narinfo WHERE store_path_hash='tool'"
			);
			expect(
				storage
					.exec(
						"SELECT state FROM publication_manifest_operation WHERE id='pending'"
					)
					.one().state
			).toBe('pending');
		});
	});

	it('keeps private staging and cleanup out of GC, then barriers a pointer swap once through its owner', async () => {
		await withStorage('private-barriers', (storage) => {
			insertAssociation(storage);
			storage.exec(
				"INSERT INTO garbage_collection_scan(cache_id,phase) VALUES (10,'collect')"
			);
			storage.exec(
				"INSERT INTO garbage_collection_mark(cache_id,store_path_hash) VALUES (10,'result')"
			);
			storage.exec('UPDATE garbage_collection_input SET inputs_changed=0');
			insertEdge(
				storage,
				resultHash,
				'sha256:nar',
				7,
				cacheId,
				cacheGeneration,
				memberPath,
				'private'
			);
			storage.exec(
				"UPDATE result_publication_member SET member_generation=8 WHERE materialisation_id='private'"
			);
			storage.exec(
				"DELETE FROM result_publication_member WHERE materialisation_id='private'"
			);
			expect(frontier(storage)).toStrictEqual([]);
			expect(
				storage
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.one().inputs_changed
			).toBe(0);
			insertEdge(
				storage,
				resultHash,
				'sha256:nar',
				7,
				cacheId,
				cacheGeneration,
				memberPath,
				'private'
			);
			storage.exec(
				"UPDATE result_publication SET materialisation_id='private'"
			);
			expect(frontier(storage)).toStrictEqual([
				{ store_path_hash: resultHash }
			]);
			expect(
				storage
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.one().inputs_changed
			).toBe(1);
			storage.exec('DELETE FROM garbage_collection_frontier');
			storage.exec('UPDATE garbage_collection_input SET inputs_changed=0');
			storage.exec(
				"DELETE FROM result_publication_member WHERE materialisation_id='private'"
			);
			expect(
				storage
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.one().inputs_changed
			).toBe(1);
		});
	});

	it('stores independent runtime and association cursors and bounded operation progress', async () => {
		await withStorage('progress', (storage) => {
			storage.exec(
				"INSERT INTO garbage_collection_scan(cache_id,phase) VALUES (10,'mark')"
			);
			const scan = storage
				.exec(
					'SELECT mark_edge_phase,reference_cursor,association_member_cursor,association_materialisation_id,association_cache_generation,association_result_generation FROM garbage_collection_scan'
				)
				.one();
			expect(scan).toMatchObject({
				mark_edge_phase: 'references',
				reference_cursor: -1,
				association_member_cursor: ''
			});
			expect(scan.association_materialisation_id).toBeNull();
			expect(scan.association_cache_generation).toBeNull();
			expect(scan.association_result_generation).toBeNull();
			storage.exec(
				"UPDATE garbage_collection_scan SET mark_edge_phase='association',reference_cursor=9,association_member_cursor='tool',association_materialisation_id='candidate',association_cache_generation=3,association_result_generation=7"
			);
			expect(
				storage
					.exec(
						'SELECT mark_edge_phase,reference_cursor,association_member_cursor,association_materialisation_id,association_cache_generation,association_result_generation FROM garbage_collection_scan'
					)
					.one()
			).toStrictEqual({
				mark_edge_phase: 'association',
				reference_cursor: 9,
				association_member_cursor: 'tool',
				association_materialisation_id: 'candidate',
				association_cache_generation: 3,
				association_result_generation: 7
			});
			storage.exec(
				"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) VALUES ('pending','request','capture',10,3,'canonical','{}','build-selection',2,'2026-02-01T00:00:00.000Z')"
			);
			const operation = storage
				.exec(
					'SELECT phase,candidate_digest,progress_json FROM publication_manifest_operation'
				)
				.one();
			expect(operation.phase).toBe('intake');
			expect(operation.candidate_digest).toBeNull();
			expect(operation.progress_json).toBeNull();
			storage.exec(
				`UPDATE publication_manifest_operation SET phase='sealing',progress_json='{"phase":"sealing","pageDigests":[]}',cursor=0`
			);
			expect(() =>
				storage.exec(
					"UPDATE publication_manifest_operation SET phase='unknown'"
				)
			).toThrow(/CHECK constraint failed/);
			storage.exec(
				"UPDATE publication_manifest_operation SET phase='publishing',candidate_digest='digest',cursor=2"
			);
			expect(
				storage
					.exec(
						'SELECT phase,candidate_digest,cursor FROM publication_manifest_operation'
					)
					.one()
			).toStrictEqual({
				phase: 'publishing',
				candidate_digest: 'digest',
				cursor: 2
			});
		});
	});

	it('indexes canonical candidate pages, private cleanup and in-flight digest protection', async () => {
		await withStorage('candidate-plans', (storage) => {
			insertEdge(
				storage,
				resultHash,
				'sha256:nar',
				7,
				cacheId,
				cacheGeneration,
				memberPath,
				'pending'
			);
			expect(() => {
				insertEdge(
					storage,
					resultHash,
					'sha256:nar',
					8,
					cacheId,
					cacheGeneration,
					memberPath,
					'pending'
				);
			}).toThrow(/publication manifest proof is immutable/);
			for (const [query, index] of [
				[
					"SELECT * FROM result_publication_member WHERE materialisation_id='pending' AND member_path > '/nix/store/a' ORDER BY member_path LIMIT 64",
					'result_publication_member_candidate_path_idx'
				],
				[
					"DELETE FROM result_publication_member WHERE materialisation_id='pending' AND member_path IN (SELECT member_path FROM result_publication_member WHERE materialisation_id='pending' ORDER BY member_path LIMIT 64)",
					'result_publication_member_candidate_path_idx'
				],
				[
					"SELECT id FROM publication_manifest_operation WHERE candidate_digest='digest' AND state='pending' LIMIT 1",
					'publication_manifest_operation_candidate_digest_idx'
				]
			] as const) {
				const details = Array.from(
					storage.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`),
					(row) => row.detail
				).join('\n');
				expect(details).toContain(index);
				if (index === 'publication_manifest_operation_candidate_digest_idx') {
					expect(details).toContain('candidate_digest=? AND state=?');
				}
				expect(details).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
			}
		});
	});

	it('selects an already staged candidate with only one owner barrier and ignores losing inserts', async () => {
		await withStorage('finalisation', (storage) => {
			storage.exec(
				"INSERT INTO garbage_collection_scan(cache_id,phase) VALUES (10,'collect')"
			);
			storage.exec(
				"INSERT INTO garbage_collection_mark(cache_id,store_path_hash) VALUES (10,'result')"
			);
			insertEdge(
				storage,
				resultHash,
				'sha256:nar',
				7,
				cacheId,
				cacheGeneration,
				memberPath,
				'candidate'
			);
			storage.exec(
				"INSERT INTO result_publication_member(cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation) VALUES (10,3,'result',7,'candidate','result','/nix/store/result-app','sha256:nar',7)"
			);
			storage.exec('UPDATE garbage_collection_input SET inputs_changed=0');
			insertAssociation(
				storage,
				resultHash,
				7,
				cacheId,
				cacheGeneration,
				'candidate'
			);
			expect(frontier(storage)).toStrictEqual([
				{ store_path_hash: resultHash }
			]);
			expect(
				storage
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.one().inputs_changed
			).toBe(1);
			storage.exec('DELETE FROM garbage_collection_frontier');
			storage.exec('UPDATE garbage_collection_input SET inputs_changed=0');
			storage.exec(
				"INSERT INTO result_publication SELECT cache_id,cache_generation,result_hash,result_path,result_generation,result_nar_hash,digest,'loser',origin,complete FROM result_publication WHERE result_hash='result' ON CONFLICT DO NOTHING"
			);
			storage.exec('UPDATE result_publication SET complete=1');
			expect(frontier(storage)).toStrictEqual([]);
			expect(
				storage
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.one().inputs_changed
			).toBe(0);
			expect(
				storage.exec('SELECT materialisation_id FROM result_publication').one()
					.materialisation_id
			).toBe('candidate');
		});
	});

	it('barriers exact selected edge updates but not marked children or obsolete owners', async () => {
		await withStorage('selected-update', (storage) => {
			insertAssociation(storage);
			insertEdge(storage, resultHash, 'sha256:nar', 8);
			storage.exec(
				"INSERT INTO garbage_collection_scan(cache_id,phase) VALUES (10,'collect')"
			);
			storage.exec(
				"INSERT INTO garbage_collection_mark(cache_id,store_path_hash) VALUES (10,'result')"
			);
			storage.exec('UPDATE garbage_collection_input SET inputs_changed=0');
			storage.exec('UPDATE result_publication_member SET member_generation=7');
			expect(frontier(storage)).toStrictEqual([
				{ store_path_hash: memberHash }
			]);
			expect(
				storage
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.one().inputs_changed
			).toBe(1);
			storage.exec('DELETE FROM garbage_collection_frontier');
			storage.exec(
				"INSERT INTO garbage_collection_mark(cache_id,store_path_hash) VALUES (10,'tool')"
			);
			storage.exec('UPDATE result_publication_member SET member_generation=7');
			expect(frontier(storage)).toStrictEqual([]);
			storage.exec('UPDATE cache_identity SET generation=4 WHERE id=10');
			storage.exec('UPDATE garbage_collection_input SET inputs_changed=0');
			storage.exec('UPDATE result_publication_member SET member_generation=8');
			expect(frontier(storage)).toStrictEqual([]);
			expect(
				storage
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.one().inputs_changed
			).toBe(0);
		});
	});

	it('queues selected edges on owner deletion without retiring another pending candidate', async () => {
		await withStorage('private-survives', (storage) => {
			insertAssociation(storage);
			insertEdge(storage);
			insertEdge(
				storage,
				resultHash,
				'sha256:nar',
				7,
				cacheId,
				cacheGeneration,
				memberPath,
				'private'
			);
			storage.exec("DELETE FROM narinfo WHERE store_path_hash='result'");
			expect(
				storage
					.exec(
						'SELECT materialisation_id FROM result_publication_member ORDER BY materialisation_id'
					)
					.toArray()
			).toStrictEqual([
				{ materialisation_id: 'private' },
				{ materialisation_id: 'selected-10-3-result-7' }
			]);
			expect(retirements(storage)).toStrictEqual([
				{ materialisation_id: 'selected-10-3-result-7', digest: 'digest' }
			]);
		});
	});

	it('retires deleted selections without touching any member rows', async () => {
		await withStorage('retirement-delete', (storage) => {
			insertAssociation(storage);
			insertEdge(storage);
			storage.exec(
				"CREATE TRIGGER forbid_member_delete BEFORE DELETE ON result_publication_member BEGIN SELECT RAISE(ABORT, 'member deletion is not bounded'); END"
			);
			storage.exec('DELETE FROM result_publication');
			expect(associations(storage)).toStrictEqual([]);
			expect(
				storage.exec('SELECT * FROM result_publication_member').toArray()
			).toHaveLength(1);
			expect(retirements(storage)).toStrictEqual([
				{ materialisation_id: 'selected-10-3-result-7', digest: 'digest' }
			]);
			for (const name of [
				'result_publication_delete',
				'result_publication_materialisation_update'
			]) {
				const definition = storage
					.exec<{ sql: string }>(
						"SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
						name
					)
					.one().sql;
				expect(definition).toContain(
					'INSERT OR IGNORE INTO `publication_manifest_retirement`'
				);
				expect(definition).not.toContain('result_publication_member');
			}
		});
	});

	it('queues the old selection and digest on pointer replacement, leaving both proofs intact', async () => {
		await withStorage('retirement-pointer', (storage) => {
			insertAssociation(storage);
			insertEdge(storage);
			insertEdge(
				storage,
				resultHash,
				'sha256:nar',
				7,
				cacheId,
				cacheGeneration,
				memberPath,
				'replacement'
			);
			storage.exec(
				"UPDATE result_publication SET materialisation_id='replacement',digest='replacement-digest'"
			);
			expect(retirements(storage)).toStrictEqual([
				{ materialisation_id: 'selected-10-3-result-7', digest: 'digest' }
			]);
			expect(
				storage.exec('SELECT * FROM result_publication_member').toArray()
			).toHaveLength(2);
			expect(
				storage
					.exec('SELECT materialisation_id,digest FROM result_publication')
					.one()
			).toStrictEqual({
				materialisation_id: 'replacement',
				digest: 'replacement-digest'
			});
			storage.exec('DELETE FROM result_publication');
			expect(retirements(storage)).toStrictEqual([
				{ materialisation_id: 'replacement', digest: 'replacement-digest' },
				{ materialisation_id: 'selected-10-3-result-7', digest: 'digest' }
			]);
		});
	});

	it('retires a live association after its expired operation receipt has been removed', async () => {
		await withStorage('retirement-receipt', (storage) => {
			storage.exec(
				"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at,state,candidate_digest) VALUES ('selected-10-3-result-7','request','capture',10,3,'canonical','{}','build-selection',2,'2026-01-01T00:00:00.000Z','complete','digest')"
			);
			insertAssociation(storage);
			insertEdge(storage);
			storage.exec(
				"DELETE FROM publication_manifest_operation WHERE expires_at < '2026-02-01T00:00:00.000Z'"
			);
			expect(associations(storage)[0]?.complete).toBe(1);
			expect(retirements(storage)).toStrictEqual([]);
			storage.exec("DELETE FROM narinfo WHERE store_path_hash='result'");
			expect(retirements(storage)).toStrictEqual([
				{ materialisation_id: 'selected-10-3-result-7', digest: 'digest' }
			]);
		});
	});

	it('does not retire selections on ignored association writes or unchanged pointers', async () => {
		await withStorage('retirement-ignored', (storage) => {
			insertAssociation(storage);
			insertAssociation(storage, 'other');
			storage.exec(
				"INSERT INTO result_publication SELECT cache_id,cache_generation,result_hash,result_path,result_generation,result_nar_hash,digest,'loser',origin,complete FROM result_publication WHERE result_hash='result' ON CONFLICT DO NOTHING"
			);
			storage.exec(
				"UPDATE OR IGNORE result_publication SET result_hash='other',materialisation_id='loser' WHERE result_hash='result'"
			);
			storage.exec(
				'UPDATE result_publication SET materialisation_id=materialisation_id,complete=0'
			);
			expect(retirements(storage)).toStrictEqual([]);
			expect(
				storage
					.exec(
						"SELECT materialisation_id FROM result_publication WHERE result_hash='result'"
					)
					.one().materialisation_id
			).toBe('selected-10-3-result-7');
		});
	});

	it('stores nullable retirement digests and deduplicates repeated retirements', async () => {
		await withStorage('retirement-deduplication', (storage) => {
			insertAssociation(storage);
			storage.exec(
				"UPDATE result_publication SET materialisation_id='replacement'"
			);
			storage.exec(
				"UPDATE result_publication SET materialisation_id='selected-10-3-result-7'"
			);
			storage.exec('DELETE FROM result_publication');
			storage.exec(
				"INSERT INTO publication_manifest_retirement(materialisation_id) VALUES ('private')"
			);
			const [privateRetirement, ...selectedRetirements] = retirements(storage);
			expect(privateRetirement?.materialisation_id).toBe('private');
			expect(privateRetirement?.digest).toBeNull();
			expect(selectedRetirements).toStrictEqual([
				{ materialisation_id: 'replacement', digest: 'digest' },
				{ materialisation_id: 'selected-10-3-result-7', digest: 'digest' }
			]);
			const columns = storage
				.exec<{ name: string; notnull: number; pk: number }>(
					'PRAGMA table_info(publication_manifest_retirement)'
				)
				.toArray();
			expect(
				columns.map(({ name, notnull, pk }) => ({ name, notnull, pk }))
			).toStrictEqual([
				{ name: 'materialisation_id', notnull: 1, pk: 1 },
				{ name: 'digest', notnull: 0, pk: 0 }
			]);
		});
	});

	it('protects selected retirements and portable content with indexed lookups', async () => {
		await withStorage('retirement-protection', (storage) => {
			insertAssociation(storage);
			storage.exec(
				"INSERT INTO publication_manifest_retirement VALUES ('selected-10-3-result-7','digest')"
			);
			for (const [query, index] of [
				[
					"SELECT 1 FROM result_publication WHERE materialisation_id='selected-10-3-result-7' LIMIT 1",
					'result_publication_materialisation_idx'
				],
				[
					"SELECT 1 FROM result_publication WHERE digest='digest' LIMIT 1",
					'result_publication_digest_idx'
				],
				[
					"SELECT 1 FROM publication_manifest_operation WHERE candidate_digest='digest' AND state='pending' LIMIT 1",
					'publication_manifest_operation_candidate_digest_idx'
				],
				[
					"SELECT * FROM publication_manifest_retirement WHERE materialisation_id > '' ORDER BY materialisation_id LIMIT 64",
					'sqlite_autoindex_publication_manifest_retirement_1'
				]
			] as const) {
				const details = Array.from(
					storage.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`),
					(row) => row.detail
				).join('\n');
				expect(details).toContain(index);
				expect(details).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
			}
			expect(
				storage
					.exec(
						"SELECT 1 AS selected FROM result_publication WHERE materialisation_id='selected-10-3-result-7' LIMIT 1"
					)
					.one().selected
			).toBe(1);
		});
	});

	it('keeps retirement queue writes and retired private proof deletion out of GC reachability', async () => {
		await withStorage('retirement-private', (storage) => {
			insertAssociation(storage);
			insertEdge(
				storage,
				resultHash,
				'sha256:nar',
				7,
				cacheId,
				cacheGeneration,
				memberPath,
				'private'
			);
			storage.exec(
				"INSERT INTO garbage_collection_scan(cache_id,phase) VALUES (10,'mark')"
			);
			storage.exec(
				"INSERT INTO garbage_collection_mark(cache_id,store_path_hash) VALUES (10,'result')"
			);
			storage.exec('UPDATE garbage_collection_input SET inputs_changed=0');
			storage.exec(
				"INSERT INTO publication_manifest_retirement VALUES ('private',NULL)"
			);
			storage.exec(
				"DELETE FROM result_publication_member WHERE materialisation_id='private'"
			);
			expect(frontier(storage)).toStrictEqual([]);
			expect(
				storage
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.one().inputs_changed
			).toBe(0);
			expect(associations(storage)[0]?.complete).toBe(1);
		});
	});
});

describe('publication manifest cardinality invariants', () => {
	it('counts actual inserts, not ignored conflicts or identical REPLACE writes with recursive triggers disabled', async () => {
		await withStorage('cardinality-replace', (storage) => {
			storage.exec('PRAGMA recursive_triggers=OFF');
			storage.exec(
				"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) VALUES ('proof','request','capture',10,3,'{}','{}','build-selection',1,'2099-01-01T00:00:00.000Z')"
			);
			storage.exec(
				"INSERT INTO publication_manifest(digest,version,member_count) VALUES ('digest',1,1)"
			);
			const candidate =
				"INSERT INTO result_publication_member VALUES (10,3,'result',7,'proof','tool','/nix/store/tool-compiler','sha256:nar',7,0)";
			const portable =
				"INSERT INTO publication_manifest_member VALUES ('digest',0,'/nix/store/tool-compiler','tool','sha256:nar')";
			storage.exec(candidate);
			storage.exec(portable);
			const cardinalities = () =>
				storage
					.exec(
						'SELECT * FROM publication_manifest_cardinality ORDER BY kind,id'
					)
					.toArray();
			const before = cardinalities();
			expect(before).toStrictEqual([
				{ kind: 'candidate', id: 'proof', member_count: 1, valid: 1 },
				{ kind: 'portable', id: 'digest', member_count: 1, valid: 1 }
			]);
			for (const statement of [
				candidate,
				portable,
				"INSERT INTO publication_manifest(digest,version,member_count) VALUES ('digest',1,1)"
			]) {
				storage.exec(`${statement} ON CONFLICT DO NOTHING`);
				storage.exec(
					statement.replace('INSERT INTO', 'INSERT OR REPLACE INTO')
				);
			}
			expect(cardinalities()).toStrictEqual(before);
			expect(() =>
				storage.exec(
					candidate
						.replace('INSERT INTO', 'INSERT OR REPLACE INTO')
						.replace("'sha256:nar'", "'sha256:changed'")
				)
			).toThrow(/proof is immutable/);
			expect(cardinalities()).toStrictEqual(before);
		});
	});
	it.each(['candidate', 'portable'] as const)(
		'keeps %s deletion invalid even after reinsertion and reclaims its counter with its owner',
		async (kind) => {
			await withStorage(`cardinality-delete-${kind}`, (storage) => {
				storage.exec(
					"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) VALUES ('proof','request','capture',10,3,'{}','{}','build-selection',1,'2099-01-01T00:00:00.000Z')"
				);
				storage.exec(
					"INSERT INTO publication_manifest(digest,version,member_count) VALUES ('digest',1,1)"
				);
				const statement =
					kind === 'candidate'
						? "INSERT INTO result_publication_member VALUES (10,3,'result',7,'proof','tool','/nix/store/tool-compiler','sha256:nar',7,0)"
						: "INSERT INTO publication_manifest_member VALUES ('digest',0,'/nix/store/tool-compiler','tool','sha256:nar')";
				const table =
					kind === 'candidate'
						? 'result_publication_member'
						: 'publication_manifest_member';
				storage.exec(statement);
				storage.exec(`DELETE FROM ${table}`);
				storage.exec(statement);
				expect(
					storage
						.exec(
							'SELECT member_count,valid FROM publication_manifest_cardinality WHERE kind=?',
							kind
						)
						.one()
				).toStrictEqual({ member_count: 1, valid: 0 });
				storage.exec(
					kind === 'candidate'
						? 'DELETE FROM publication_manifest_operation'
						: 'DELETE FROM publication_manifest'
				);
				expect(
					storage
						.exec(
							'SELECT 1 FROM publication_manifest_cardinality WHERE kind=?',
							kind
						)
						.toArray()
				).toStrictEqual([]);
			});
		}
	);
	it('invalidates a same-count edited candidate without affecting another private candidate', async () => {
		await withStorage('cardinality-edit', (storage) => {
			for (const id of ['first', 'other']) {
				storage.exec(
					"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) VALUES (?,?,'capture',10,3,'{}','{}','build-selection',1,'2099-01-01T00:00:00.000Z')",
					id,
					id
				);
				insertEdge(
					storage,
					resultHash,
					'sha256:nar',
					7,
					cacheId,
					cacheGeneration,
					memberPath,
					id
				);
			}
			storage.exec(
				"UPDATE result_publication_member SET member_generation=8 WHERE materialisation_id='first'"
			);
			expect(
				storage
					.exec(
						"SELECT id,member_count,valid FROM publication_manifest_cardinality WHERE kind='candidate' ORDER BY id"
					)
					.toArray()
			).toStrictEqual([
				{ id: 'first', member_count: 1, valid: 0 },
				{ id: 'other', member_count: 1, valid: 1 }
			]);
		});
	});
});
