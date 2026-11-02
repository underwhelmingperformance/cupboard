import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import {
	createPublicationRequestId,
	type RecordedPublication
} from '@cupboard/protocol/publication-manifests';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it, vi } from 'vitest';

import migrations from '../../drizzle/migrations.js';
import { cacheIdSchema } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import {
	fixtureWorkerServer,
	migrateThrough,
	namedCache,
	resetTestServer,
	restartTestServers,
	testServerFor,
	withoutAlarmArming
} from '../test-support.ts';

import type { ServerContext } from './context.ts';
import { DatabaseCostMeter, meteredStorage } from './database-cost-meter.ts';
import { applyMigrations, migrationsThrough } from './migrate.ts';
import { PublicationManifestAuthority } from './publication-manifest-authority.ts';
import {
	type PublicationManifestAvailabilityIntent,
	type PublicationManifestAvailabilitySnapshot,
	PublicationManifestAvailabilityStore
} from './publication-manifest-availability-store.ts';
import { PublicationManifestCaptureService } from './publication-manifest-capture.ts';
import { PublicationManifestEnsureService } from './publication-manifest-ensure.ts';
import { PublicationManifestRepository } from './publication-manifest-repository.ts';
import { committedPath } from './reuse-view-read.test-support.ts';
import { currentRowBudgetMeter, withRowBudget } from './row-budget.ts';

async function withStore(
	name: string,
	check: (
		store: PublicationManifestAvailabilityStore,
		storage: DurableObjectStorage,
		context: ServerContext
	) => void
): Promise<void> {
	await runInDurableObject(
		testServerFor(`manifest-availability-${name}`),
		async (_instance, state) => {
			await migrateThrough(state, 83);
			state.storage.sql.exec(
				"INSERT INTO cache_identity(id,kind,name,access,priority,generation,created_at) VALUES (10,'named','cache-10','public',40,3,'2026-01-01T00:00:00.000Z')"
			);
			state.storage.sql.exec(
				"INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (10,?,?,?,10,'[]',7,'2026-01-01T00:00:00.000Z')",
				version.storePathHash,
				version.storePath,
				version.narHash
			);
			check(
				new PublicationManifestAvailabilityStore(
					drizzle(state.storage, { schema })
				),
				state.storage,
				_instance.context
			);
		}
	);
}

async function withLegacyStore(
	name: string,
	count: number,
	check: (
		store: PublicationManifestAvailabilityStore,
		storage: DurableObjectStorage,
		migrationCost: { read: number; written: number }
	) => void
): Promise<void> {
	await runInDurableObject(
		testServerFor(`legacy-manifest-${name}`),
		async (_instance, state) => {
			await migrateThrough(state, 82);
			const storage = state.storage;
			storage.sql.exec(
				"INSERT INTO cache_identity(id,kind,name,access,priority,generation,created_at) VALUES (10,'named','cache-10','public',40,3,'2026-01-01T00:00:00.000Z')"
			);
			storage.sql.exec(
				"INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (10,?,?,?,10,'[]',7,'2026-01-01T00:00:00.000Z'),(10,?,?,?,10,'[]',7,'2026-01-01T00:00:00.000Z')",
				version.storePathHash,
				version.storePath,
				version.narHash,
				legacyOccupied.storePathHash,
				legacyOccupied.storePath,
				version.narHash
			);
			storage.sql.exec(
				"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i+1<=?) INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT 10,printf('%032d',i),printf('/nix/store/%032d-legacy',i),?,10,'[]',7,'2026-01-01T00:00:00.000Z' FROM n",
				count - 2,
				version.narHash
			);
			storage.sql.exec(
				"INSERT INTO generation_seq(cache_kind,cache_name,store_path_hash,next_generation) VALUES ('named','cache-10',?,8)",
				version.storePathHash
			);
			const accepted = {
				rows: storage.sql
					.exec(
						'SELECT count(*) AS count,sum(generation) AS generationTotal FROM narinfo'
					)
					.toArray(),
				versions: storage.sql
					.exec(
						'SELECT * FROM narinfo WHERE store_path_hash IN (?,?) ORDER BY store_path_hash',
						version.storePathHash,
						legacyOccupied.storePathHash
					)
					.toArray(),
				allocators: storage.sql.exec('SELECT * FROM generation_seq').toArray()
			};
			const meter = new DatabaseCostMeter();
			const result = await applyMigrations(
				drizzle(meteredStorage(storage, meter)),
				migrationsThrough(migrations, 83),
				{
					budget: {
						sourceRowsRemaining: 1,
						structuralOperationsRemaining: 365,
						freshStore: false
					}
				}
			);
			meter.recordOutstanding();
			const cost = { read: meter.rowsRead, written: meter.rowsWritten };
			expect(result).toStrictEqual({ kind: 'complete', hasCommitted: true });
			expect(cost.read + cost.written).toBeLessThan(25_000);
			expect({
				rows: storage.sql
					.exec(
						'SELECT count(*) AS count,sum(generation) AS generationTotal FROM narinfo'
					)
					.toArray(),
				versions: storage.sql
					.exec(
						'SELECT * FROM narinfo WHERE store_path_hash IN (?,?) ORDER BY store_path_hash',
						version.storePathHash,
						legacyOccupied.storePathHash
					)
					.toArray(),
				allocators: storage.sql.exec('SELECT * FROM generation_seq').toArray()
			}).toStrictEqual(accepted);
			expect(
				storage.sql
					.exec('SELECT * FROM publication_manifest_local_identity')
					.toArray()
			).toStrictEqual([]);
			check(
				new PublicationManifestAvailabilityStore(drizzle(storage, { schema })),
				storage,
				cost
			);
		}
	);
}

const legacyOccupied = {
	storePathHash: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
	storePath: '/nix/store/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-occupied'
};

// Whole-row expectations retain SQLite's exact NULL representation.
const sqlNull: unknown = expect.toSatisfy((value: unknown) => value === null);

const version = {
	cacheId: cacheIdSchema.parse(10),
	cacheGeneration: cacheGenerationSchema.parse(3),
	storePathHash: storePathHashSchema.parse('00000000000000000000000000000000'),
	storePath: storePathSchema.parse(
		'/nix/store/00000000000000000000000000000000-compiler'
	),
	narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
	generation: narInfoGenerationSchema.parse(7)
};

function begin(
	store: PublicationManifestAvailabilityStore,
	kind: Exclude<
		PublicationManifestAvailabilityIntent['kind'],
		'local' | 'local-replace'
	> = 'demote'
): PublicationManifestAvailabilityIntent {
	const intent = store.begin(version, kind);
	if (intent === undefined) {
		throw new Error('Expected accepted intent');
	}
	return intent;
}

function seedOperation(storage: SqlStorage, id: string): void {
	storage.exec(
		"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) VALUES (?,?,'ensure',10,3,'{}','{}','build-selection',1,'2027-01-01T00:00:00.000Z')",
		id,
		id
	);
}

function seedProof(
	storage: SqlStorage,
	id: string,
	revision = 0,
	owner = id
): void {
	storage.exec(
		'INSERT INTO result_publication_member(cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation,availability_revision) VALUES (10,3,?,7,?,?,?,?,7,?)',
		owner,
		id,
		version.storePathHash,
		version.storePath,
		version.narHash,
		revision
	);
}

function selectProof(storage: SqlStorage, id: string): void {
	storage.exec(
		"INSERT INTO result_publication(cache_id,cache_generation,result_hash,result_path,result_generation,result_nar_hash,digest,origin,complete,materialisation_id) VALUES (10,3,?,?,7,?,'digest','build-selection',1,?)",
		id,
		`/nix/store/${id}-app`,
		version.narHash,
		id
	);
}

function complete(storage: SqlStorage, owner: string): number | undefined {
	return storage
		.exec<{ complete: number }>(
			'SELECT complete FROM result_publication WHERE cache_id=10 AND cache_generation=3 AND result_hash=? AND result_generation=7',
			owner
		)
		.toArray()[0]?.complete;
}

function operationState(storage: SqlStorage, id: string): string | undefined {
	return storage
		.exec<{ state: string }>(
			'SELECT state FROM publication_manifest_operation WHERE id=?',
			id
		)
		.toArray()[0]?.state;
}

/**
Synthetic fan-in, not a production acceptance path. Setup is never measured.
*/
function seedFanIn(storage: SqlStorage, count: number): void {
	storage.exec(
		"WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i+1 < ?) INSERT INTO result_publication(cache_id,cache_generation,result_hash,result_path,result_generation,result_nar_hash,digest,origin,complete,materialisation_id) SELECT 10,3,printf('owner-%06d',i),printf('/nix/store/owner-%06d-app',i),7,?,'digest','build-selection',1,printf('proof-%06d',i) FROM n",
		count,
		version.narHash
	);
	storage.exec(
		"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) SELECT materialisation_id,materialisation_id,'ensure',cache_id,cache_generation,'{}','{}','build-selection',1,'2027-01-01T00:00:00.000Z' FROM result_publication"
	);

	storage.exec(
		'INSERT INTO result_publication_member(cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation) SELECT cache_id,cache_generation,result_hash,result_generation,materialisation_id,?,?,?,7 FROM result_publication',
		version.storePathHash,
		version.storePath,
		version.narHash
	);
}

/**
Synthetic SQL selections establish storage semantics, not API acceptance.
*/
function seedLifecycleSelections(storage: SqlStorage): void {
	storage.exec(
		"INSERT INTO cache_identity(id,kind,name,access,priority,generation,created_at) VALUES (11,'named','cache-11','public',40,3,'2026-01-01T00:00:00.000Z')"
	);
	storage.exec(
		'INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT 11,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at FROM narinfo WHERE cache_id=10'
	);
	for (const cacheId of [10, 11]) {
		storage.exec(
			"INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (?,?,?,?,10,'[]',7,'2026-01-01T00:00:00.000Z')",
			cacheId,
			legacyOccupied.storePathHash,
			legacyOccupied.storePath,
			version.narHash
		);
	}
	for (const [cacheId, generation] of [
		[10, 3],
		[10, 4],
		[11, 3]
	] as const) {
		const id = `lifecycle-${cacheId.toString()}-${generation.toString()}`;
		storage.exec(
			"INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at) VALUES (?,?,'ensure',?,?,'{}','{}','build-selection',1,'2027-01-01T00:00:00.000Z')",
			id,
			id,
			cacheId,
			generation
		);
		storage.exec(
			"INSERT INTO result_publication(cache_id,cache_generation,result_hash,result_path,result_generation,result_nar_hash,digest,origin,complete,materialisation_id) SELECT cache_id,?,store_path_hash,store_path,generation,nar_hash,'digest','build-selection',1,? FROM narinfo WHERE cache_id=? AND store_path_hash=?",
			generation,
			id,
			cacheId,
			version.storePathHash
		);
		storage.exec(
			'INSERT INTO result_publication_member(cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation) SELECT r.cache_id,r.cache_generation,r.result_hash,r.result_generation,r.materialisation_id,n.store_path_hash,n.store_path,n.nar_hash,n.generation FROM result_publication r JOIN narinfo n ON n.cache_id=r.cache_id WHERE r.materialisation_id=? AND n.store_path_hash=?',
			id,
			legacyOccupied.storePathHash
		);
	}
	storage.exec('UPDATE garbage_collection_input SET inputs_changed=0');
}

function lifecycleStorageState(storage: SqlStorage) {
	return {
		identities: storage
			.exec('SELECT * FROM cache_identity ORDER BY id')
			.toArray(),
		narinfos: storage
			.exec('SELECT * FROM narinfo ORDER BY cache_id,store_path_hash')
			.toArray(),
		clock: storage
			.exec('SELECT * FROM publication_manifest_availability_clock')
			.toArray(),
		intents: storage
			.exec(
				'SELECT * FROM publication_manifest_lifecycle_intent ORDER BY revision'
			)
			.toArray(),
		availabilityIntents: storage
			.exec(
				'SELECT * FROM publication_manifest_availability_intent ORDER BY revision'
			)
			.toArray(),
		associations: storage
			.exec('SELECT * FROM result_publication ORDER BY materialisation_id')
			.toArray(),
		operations: storage
			.exec('SELECT * FROM publication_manifest_operation ORDER BY id')
			.toArray(),
		proofs: storage
			.exec(
				'SELECT * FROM result_publication_member ORDER BY materialisation_id,member_hash'
			)
			.toArray(),
		cardinalities: storage
			.exec('SELECT * FROM publication_manifest_cardinality ORDER BY kind,id')
			.toArray(),
		retirements: storage
			.exec(
				'SELECT * FROM publication_manifest_retirement ORDER BY materialisation_id'
			)
			.toArray(),
		selectedEdges: storage
			.exec(
				'SELECT e.* FROM result_publication r JOIN cache_identity c ON c.id=r.cache_id AND c.generation=r.cache_generation AND c.deleted_at IS NULL JOIN narinfo owner ON owner.cache_id=r.cache_id AND owner.store_path_hash=r.result_hash AND owner.store_path=r.result_path AND owner.nar_hash=r.result_nar_hash AND owner.generation=r.result_generation JOIN result_publication_member e ON e.materialisation_id=r.materialisation_id AND e.cache_id=r.cache_id AND e.cache_generation=r.cache_generation AND e.result_hash=r.result_hash AND e.result_generation=r.result_generation JOIN narinfo member ON member.cache_id=e.cache_id AND member.store_path_hash=e.member_hash AND member.store_path=e.member_path AND member.nar_hash=e.member_nar_hash AND member.generation=e.member_generation ORDER BY e.materialisation_id,e.member_hash'
			)
			.toArray(),
		gcInputs: storage
			.exec('SELECT * FROM garbage_collection_input ORDER BY cache_id')
			.toArray(),
		gcScans: storage
			.exec('SELECT * FROM garbage_collection_scan ORDER BY cache_id')
			.toArray(),
		gcFrontier: storage
			.exec(
				'SELECT * FROM garbage_collection_frontier ORDER BY cache_id,store_path_hash'
			)
			.toArray(),
		gcMarks: storage
			.exec(
				'SELECT * FROM garbage_collection_mark ORDER BY cache_id,store_path_hash'
			)
			.toArray()
	};
}

function measure<T>(meter: DatabaseCostMeter, body: () => T) {
	meter.recordOutstanding();
	const read = meter.rowsRead;
	const written = meter.rowsWritten;
	const value = body();
	meter.recordOutstanding();
	return {
		value,
		read: meter.rowsRead - read,
		written: meter.rowsWritten - written
	};
}

describe('PublicationManifestAvailabilityStore', () => {
	it.each(['availability', 'replacement', 'lifecycle'] as const)(
		'dirties only the actual pending operation owner on %s failure, atomically and once',
		async (kind) => {
			await withStore(`failure-inputs-${kind}`, (_unmetered, storage) => {
				const meter = new DatabaseCostMeter();
				const store = new PublicationManifestAvailabilityStore(
					drizzle(meteredStorage(storage, meter), { schema })
				);
				seedOperation(storage.sql, 'private');
				seedProof(storage.sql, 'private');
				seedOperation(storage.sql, 'complete');
				seedProof(storage.sql, 'complete');
				storage.sql.exec(
					"UPDATE publication_manifest_operation SET state='complete' WHERE id='complete'"
				);
				storage.sql.exec(
					"INSERT INTO cache_identity(id,kind,name,access,priority,generation,created_at) VALUES (11,'named','unrelated','public',40,1,'2026-01-01T00:00:00.000Z')"
				);
				const immutable = storage.sql
					.exec(
						'SELECT * FROM result_publication_member ORDER BY materialisation_id'
					)
					.toArray();
				let drain: () => unknown;
				if (kind === 'availability') {
					const intent = begin(store);
					store.acknowledge(intent.revision);
					drain = () => store.drainPage(intent.revision);
				} else if (kind === 'replacement') {
					storage.sql.exec(
						'INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,8,created_at FROM narinfo WHERE cache_id=10'
					);
					const intent = store.nextIntent(false);
					if (intent === undefined) {
						throw new Error('Missing replacement intent');
					}
					drain = () => store.drainPage(intent.revision);
				} else {
					storage.sql.exec(
						'UPDATE cache_identity SET generation=4 WHERE id=10'
					);
					const intent = store.nextLifecycleIntent();
					if (intent === undefined) {
						throw new Error('Missing lifecycle intent');
					}
					store.drainLifecyclePage(intent.revision);
					drain = () => store.drainLifecyclePage(intent.revision);
				}
				const clear = () =>
					storage.sql.exec(
						'UPDATE garbage_collection_input SET inputs_changed=0'
					);
				const inputs = () =>
					storage.sql
						.exec(
							'SELECT cache_id,inputs_changed FROM garbage_collection_input ORDER BY cache_id'
						)
						.toArray();
				clear();
				const before = inputs();
				expect(() =>
					storage.transactionSync(() => {
						drain();
						throw new Error('rollback');
					})
				).toThrow('rollback');
				expect(operationState(storage.sql, 'private')).toBe('pending');
				expect(inputs()).toEqual(before);
				const transition = measure(meter, drain);
				expect({ read: transition.read, written: transition.written }).toEqual(
					{
						availability: { read: 13, written: 7 },
						replacement: { read: 11, written: 5 },
						lifecycle: { read: 9, written: 5 }
					}[kind]
				);
				expect(operationState(storage.sql, 'private')).toBe('failed');
				expect(operationState(storage.sql, 'complete')).toBe('complete');
				expect(inputs()).toEqual(
					before.map((row) => ({
						...row,
						inputs_changed: row.cache_id === 10 ? 1 : 0
					}))
				);
				expect(
					storage.sql
						.exec(
							'SELECT * FROM result_publication_member ORDER BY materialisation_id'
						)
						.toArray()
				).toEqual(immutable);
				clear();
				drain();
				expect(inputs()).toEqual(before);
				// Revisit terminal receipts through a new real intent, not just an empty cursor.
				if (kind === 'availability') {
					const repeated = begin(store);
					store.acknowledge(repeated.revision);
					store.drainPage(repeated.revision);
				} else if (kind === 'lifecycle') {
					storage.sql.exec(
						'UPDATE cache_identity SET generation=3 WHERE id=10'
					);
					clear();
					withRowBudget(() => store.drain());
				} else {
					withRowBudget(() => store.drain());
				}
				expect(inputs()).toEqual(before);
			});
		}
	);

	it.each(['availability', 'replacement', 'lifecycle'] as const)(
		'leaves a different operation owner untouched during %s draining',
		async (kind) => {
			await withStore(`different-owner-${kind}`, (store, storage) => {
				storage.sql.exec(
					"INSERT INTO cache_identity(id,kind,name,access,priority,generation,created_at) VALUES (11,'named','other-owner','public',40,1,'2026-01-01T00:00:00.000Z')"
				);
				seedOperation(storage.sql, 'different-owner');
				seedProof(storage.sql, 'different-owner');
				storage.sql.exec(
					"UPDATE publication_manifest_operation SET cache_id=11 WHERE id='different-owner'"
				);
				const operation = storage.sql
					.exec('SELECT * FROM publication_manifest_operation')
					.toArray();
				if (kind === 'availability') {
					const intent = begin(store);
					store.acknowledge(intent.revision);
				} else if (kind === 'replacement') {
					storage.sql.exec(
						'INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,8,created_at FROM narinfo WHERE cache_id=10'
					);
				} else {
					storage.sql.exec(
						'UPDATE cache_identity SET generation=4 WHERE id=10'
					);
				}
				storage.sql.exec(
					'UPDATE garbage_collection_input SET inputs_changed=0'
				);
				const inputs = storage.sql
					.exec('SELECT * FROM garbage_collection_input ORDER BY cache_id')
					.toArray();
				expect(withRowBudget(() => store.drain())).toBe(false);
				expect(
					storage.sql
						.exec('SELECT * FROM publication_manifest_operation')
						.toArray()
				).toEqual(operation);
				expect(
					storage.sql
						.exec('SELECT * FROM garbage_collection_input ORDER BY cache_id')
						.toArray()
				).toEqual(inputs);
			});
		}
	);

	it('upgrades 128 and 100000 actual pre-0083 narinfos with constant migration cost and no eager mirror rows', async () => {
		const costs: { read: number; written: number }[] = [];
		for (const count of [128, 100_000]) {
			await withLegacyStore(
				`upgrade-${count.toString()}`,
				count,
				(store, storage, cost) => {
					costs.push(cost);
					expect(store.snapshot(version)).toStrictEqual({
						revision: 0,
						pathRevision: 0,
						lifecycleRevision: 0,
						unresolved: false
					});
					expect(
						storage.sql
							.exec('SELECT * FROM publication_manifest_availability_intent')
							.toArray()
					).toStrictEqual([]);
					expect(
						storage.sql
							.exec('SELECT * FROM publication_manifest_lifecycle_intent')
							.toArray()
					).toStrictEqual([]);
				}
			);
		}
		expect(costs[1]).toStrictEqual(costs[0]);
		expect(costs[0]).toStrictEqual({ read: 1769, written: 107 });
	});

	it.each([false, true])(
		'preserves whole legacy selections on identical REPLACE with recursive triggers %s at 128 and 100000 narinfos',
		async (recursive) => {
			const costs: { read: number; written: number }[] = [];
			for (const count of [128, 100_000]) {
				await withLegacyStore(
					`identical-${recursive.toString()}-${count.toString()}`,
					count,
					(store, storage) => {
						storage.sql.exec(
							`PRAGMA recursive_triggers=${recursive ? 'ON' : 'OFF'}`
						);
						seedOperation(storage.sql, 'legacy-candidate');
						seedProof(storage.sql, 'legacy-candidate');
						selectProof(storage.sql, 'legacy-candidate');
						const snapshot = () => ({
							availability: store.snapshot(version),
							narinfos: storage.sql
								.exec(
									'SELECT * FROM narinfo WHERE store_path_hash IN (?,?) ORDER BY store_path_hash',
									version.storePathHash,
									legacyOccupied.storePathHash
								)
								.toArray(),
							allocators: storage.sql
								.exec('SELECT * FROM generation_seq')
								.toArray(),
							associations: storage.sql
								.exec('SELECT * FROM result_publication')
								.toArray(),
							proofs: storage.sql
								.exec('SELECT * FROM result_publication_member')
								.toArray(),
							operations: storage.sql
								.exec('SELECT * FROM publication_manifest_operation')
								.toArray(),
							cardinalities: storage.sql
								.exec('SELECT * FROM publication_manifest_cardinality')
								.toArray(),
							retirements: storage.sql
								.exec('SELECT * FROM publication_manifest_retirement')
								.toArray(),
							clock: storage.sql
								.exec('SELECT * FROM publication_manifest_availability_clock')
								.toArray(),
							revisions: storage.sql
								.exec(
									'SELECT * FROM publication_manifest_availability_revision'
								)
								.toArray(),
							intents: storage.sql
								.exec('SELECT * FROM publication_manifest_availability_intent')
								.toArray(),
							identities: storage.sql
								.exec('SELECT * FROM publication_manifest_local_identity')
								.toArray()
						});
						const before = snapshot();
						for (let replay = 0; replay < 2; replay += 1) {
							const cursor = storage.sql.exec(
								'INSERT OR REPLACE INTO narinfo SELECT * FROM narinfo WHERE cache_id=10 AND store_path_hash=?',
								version.storePathHash
							);
							cursor.toArray();
							costs.push({
								read: cursor.rowsRead,
								written: cursor.rowsWritten
							});
							expect(snapshot()).toStrictEqual(before);
						}
					}
				);
			}
			expect(costs).toStrictEqual(
				Array.from({ length: 4 }, () => ({ read: 3, written: 0 }))
			);
		}
	);

	it.each(
		(
			[
				'delete',
				'update',
				'replace',
				'update-replace',
				'ignored-insert',
				'ignored-update'
			] as const
		).flatMap((mutation) =>
			[false, true].map((recursive) => ({ mutation, recursive }))
		)
	)(
		'lazily fences legacy $mutation with recursive triggers $recursive in constant work at 128 and 100000 rows',
		async ({ mutation, recursive }) => {
			const costs: {
				migration: { read: number; written: number };
				mutation: { read: number; written: number };
			}[] = [];
			for (const count of [128, 100_000]) {
				await withLegacyStore(
					`${mutation}-${recursive.toString()}-${count.toString()}`,
					count,
					(store, storage, migrationCost) => {
						storage.sql.exec(
							`PRAGMA recursive_triggers=${recursive ? 'ON' : 'OFF'}`
						);
						seedOperation(storage.sql, 'legacy-candidate');
						seedProof(storage.sql, 'legacy-candidate');
						selectProof(storage.sql, 'legacy-candidate');
						const before = store.snapshot(version);
						const unchanged = {
							narinfos: storage.sql
								.exec(
									'SELECT * FROM narinfo WHERE store_path_hash IN (?,?) ORDER BY store_path_hash',
									version.storePathHash,
									legacyOccupied.storePathHash
								)
								.toArray(),
							allocators: storage.sql
								.exec('SELECT * FROM generation_seq')
								.toArray(),
							proofs: storage.sql
								.exec('SELECT * FROM result_publication_member')
								.toArray(),
							cardinality: storage.sql
								.exec('SELECT * FROM publication_manifest_cardinality')
								.toArray(),
							operations: storage.sql
								.exec('SELECT * FROM publication_manifest_operation')
								.toArray(),
							associations: storage.sql
								.exec('SELECT * FROM result_publication')
								.toArray()
						};
						const statements = {
							delete:
								'DELETE FROM narinfo WHERE cache_id=10 AND store_path_hash=?',
							update:
								'UPDATE narinfo SET generation=8 WHERE cache_id=10 AND store_path_hash=?',
							replace:
								'INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,8,created_at FROM narinfo WHERE cache_id=10 AND store_path_hash=?',
							'update-replace': `UPDATE OR REPLACE narinfo SET store_path_hash=?,store_path='${version.storePath}',generation=8 WHERE cache_id=10 AND store_path_hash='${legacyOccupied.storePathHash}'`,
							'ignored-insert':
								'INSERT OR IGNORE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,8,created_at FROM narinfo WHERE cache_id=10 AND store_path_hash=?',
							'ignored-update': `UPDATE OR IGNORE narinfo SET store_path_hash='${legacyOccupied.storePathHash}',generation=8 WHERE cache_id=10 AND store_path_hash=?`
						};
						const cursor = storage.sql.exec(
							statements[mutation],
							version.storePathHash
						);
						cursor.toArray();
						const cost = { read: cursor.rowsRead, written: cursor.rowsWritten };
						expect(cost.read + cost.written).toBeLessThan(100);
						costs.push({ migration: migrationCost, mutation: cost });
						const isIgnored =
							mutation === 'ignored-insert' || mutation === 'ignored-update';
						if (isIgnored) {
							expect({
								narinfos: storage.sql
									.exec(
										'SELECT * FROM narinfo WHERE store_path_hash IN (?,?) ORDER BY store_path_hash',
										version.storePathHash,
										legacyOccupied.storePathHash
									)
									.toArray(),
								allocators: storage.sql
									.exec('SELECT * FROM generation_seq')
									.toArray(),
								proofs: storage.sql
									.exec('SELECT * FROM result_publication_member')
									.toArray(),
								cardinality: storage.sql
									.exec('SELECT * FROM publication_manifest_cardinality')
									.toArray(),
								operations: storage.sql
									.exec('SELECT * FROM publication_manifest_operation')
									.toArray(),
								associations: storage.sql
									.exec('SELECT * FROM result_publication')
									.toArray()
							}).toStrictEqual(unchanged);
							expect(store.snapshot(version)).toStrictEqual(before);
							expect(store.nextIntent()).toBeUndefined();
							expect(store.isCurrent(version, before)).toBe(true);
							const seeded =
								mutation === 'ignored-update' ? legacyOccupied : version;
							expect(
								storage.sql
									.exec('SELECT * FROM publication_manifest_local_identity')
									.toArray()
							).toStrictEqual([
								{
									cache_id: 10,
									store_path_hash: seeded.storePathHash,
									generation: 7,
									store_path: seeded.storePath,
									nar_hash: version.narHash
								}
							]);
							// Follow the ignored legacy statement with an actual changed replacement.
							storage.sql.exec(statements.replace, version.storePathHash);
						}
						expect(store.nextIntent(true)).toBeUndefined();
						expect(store.hasPending(version)).toBe(true);
						expect(store.isCurrent(version, before)).toBe(false);
						expect(complete(storage.sql, 'legacy-candidate')).toBe(1);
						expect(withRowBudget(() => store.drain())).toBe(false);
						expect(
							storage.sql
								.exec(
									"SELECT complete,materialisation_id FROM result_publication WHERE result_hash='legacy-candidate'"
								)
								.toArray()
						).toStrictEqual([
							{ complete: 0, materialisation_id: 'legacy-candidate' }
						]);
						expect(
							storage.sql
								.exec(
									"SELECT state,failure_json FROM publication_manifest_operation WHERE id='legacy-candidate'"
								)
								.toArray()
						).toStrictEqual([
							{
								state: 'failed',
								failure_json: '{"kind":"failed","reason":"generation-conflict"}'
							}
						]);
						expect({
							proofs: storage.sql
								.exec('SELECT * FROM result_publication_member')
								.toArray(),
							cardinality: storage.sql
								.exec('SELECT * FROM publication_manifest_cardinality')
								.toArray(),
							allocators: storage.sql
								.exec('SELECT * FROM generation_seq')
								.toArray()
						}).toStrictEqual({
							proofs: unchanged.proofs,
							cardinality: unchanged.cardinality,
							allocators: unchanged.allocators
						});
						expect(store.hasPending(version)).toBe(false);
						expect(store.isCurrent(version, before)).toBe(false);
					}
				);
			}
			expect(costs[1]).toStrictEqual(costs[0]);
			expect(costs[0]).toStrictEqual({
				migration: { read: 1769, written: 107 },
				mutation: {
					delete: { read: 14, written: 8 },
					update: { read: 14, written: 13 },
					replace: recursive
						? { read: 37, written: 23 }
						: { read: 22, written: 17 },
					'update-replace': recursive
						? { read: 42, written: 27 }
						: { read: 28, written: 21 },
					'ignored-insert': { read: 5, written: 2 },
					'ignored-update': { read: 4, written: 2 }
				}[mutation]
			});
		}
	);

	it('retries an unrelated lifecycle observation without changing stored proofs or adding member work to a fresh healthy ensure', async () => {
		await resetTestServer();
		await withoutAlarmArming(async () => {
			const scope = namedCache('lifecycle-clock-warm');
			const unrelated = namedCache('lifecycle-clock-unrelated');
			await committedPath('lifecycle-clock-warm', scope);
			await committedPath('lifecycle-clock-unrelated', unrelated);
			await runInDurableObject(
				fixtureWorkerServer(),
				async (instance, state) => {
					const context = instance.context;
					const cache = context.cacheRepository.require(scope);
					const other = context.cacheRepository.require(unrelated);
					const row = context.db
						.select()
						.from(schema.narInfos)
						.where(eq(schema.narInfos.cacheId, cache.id))
						.get();
					if (row === undefined) {
						throw new Error('Missing accepted warm result');
					}
					const result = {
						storePath: row.storePath,
						narHash: row.narHash,
						generation: row.generation
					};
					const grants = authorizationDetailsSchema.parse([
						{ type: 'cupboard_cache', cache: scope, actions: ['upload:commit'] }
					]);
					const capture = new PublicationManifestCaptureService(context);
					const intake = await capture.captureBegin(scope, grants, {
						result,
						expectedCacheGeneration: cache.generation,
						requestId: createPublicationRequestId(),
						origin: 'build-selection',
						memberCount: 1
					});
					if (intake.kind !== 'staging') {
						throw new Error('Expected capture intake');
					}
					await capture.capturePage(scope, grants, {
						operationId: intake.operationId,
						page: 0,
						members: [result]
					});
					let publication: RecordedPublication | undefined;
					for (let page = 0; page < 12; page += 1) {
						const sealed = await capture.captureSeal(scope, grants, {
							operationId: intake.operationId
						});
						if (sealed.kind === 'captured') {
							publication = sealed.publication;
							break;
						}
					}
					if (publication === undefined) {
						throw new Error('Capture did not converge');
					}
					const store = new PublicationManifestAvailabilityStore(context.db);
					const accepted = {
						cacheId: cache.id,
						cacheGeneration: cache.generation,
						storePathHash: row.storePathHash,
						storePath: row.storePath,
						narHash: row.narHash,
						generation: row.generation
					};
					const before = store.snapshot(accepted);
					const selected = {
						associations: state.storage.sql
							.exec('SELECT * FROM result_publication')
							.toArray(),
						proofs: state.storage.sql
							.exec('SELECT * FROM result_publication_member')
							.toArray(),
						members: state.storage.sql
							.exec('SELECT * FROM publication_manifest_member')
							.toArray()
					};
					state.storage.sql.exec(
						'DELETE FROM cache_identity WHERE id=?',
						other.id
					);
					expect(store.isCurrent(accepted, before)).toBe(false);
					expect(store.snapshot(accepted)).toStrictEqual({
						...before,
						revision: before.revision + 1,
						lifecycleRevision: before.revision + 1
					});
					expect(store.isCurrent(accepted, store.snapshot(accepted))).toBe(
						true
					);
					expect(store.hasPending(accepted)).toBe(false);
					const servable = vi.spyOn(
						PublicationManifestAuthority.prototype,
						'requireServable'
					);
					const members = vi.spyOn(
						PublicationManifestRepository.prototype,
						'selectedMembers'
					);
					const publisher = {
						admit: vi.fn(() =>
							Promise.reject(new Error('Unexpected ordinary admission'))
						),
						publish: vi.fn(() =>
							Promise.reject(new Error('Unexpected ordinary publication'))
						)
					};
					try {
						const response = await new PublicationManifestEnsureService(
							context,
							publisher
						).ensure(scope, grants, {
							requestId: createPublicationRequestId(),
							source: publication,
							expectedDestinationGeneration: cache.generation
						});
						expect(response).toStrictEqual({
							kind: 'complete',
							association: 'existing',
							publication: { ...publication, materialisation: 'complete' }
						});
						expect({
							servable: servable.mock.calls.length,
							members: members.mock.calls.length,
							admit: publisher.admit.mock.calls.length,
							publish: publisher.publish.mock.calls.length
						}).toStrictEqual({ servable: 0, members: 0, admit: 0, publish: 0 });
						expect({
							associations: state.storage.sql
								.exec('SELECT * FROM result_publication')
								.toArray(),
							proofs: state.storage.sql
								.exec('SELECT * FROM result_publication_member')
								.toArray(),
							members: state.storage.sql
								.exec('SELECT * FROM publication_manifest_member')
								.toArray()
						}).toStrictEqual(selected);
					} finally {
						servable.mockRestore();
						members.mockRestore();
					}
				}
			);
		}, fixtureWorkerServer());
	});

	it('fences physical deletion and same-identity recreation through actual reset even with a nonzero outstanding path revision', async () => {
		let before: PublicationManifestAvailabilitySnapshot | undefined;
		await withStore('physical-lifecycle-reset', (store, storage) => {
			const remote = begin(store);
			store.acknowledge(remote.revision);
			before = store.snapshot(version);
			storage.sql.exec('DELETE FROM cache_identity WHERE id=10');
			expect(store.drainLifecyclePage(2)).toStrictEqual({
				processed: 0,
				remaining: true
			});
			expect(store.drainLifecyclePage(2)).toStrictEqual({
				processed: 0,
				remaining: false
			});
			storage.sql.exec(
				"INSERT INTO cache_identity(id,kind,name,access,priority,generation,created_at) VALUES (10,'named','cache-10','public',40,3,'2026-01-01T00:00:00.000Z')"
			);
		});
		await restartTestServers();
		await runInDurableObject(
			testServerFor('manifest-availability-physical-lifecycle-reset'),
			(_instance, state) => {
				if (before === undefined) {
					throw new Error('Missing pre-deletion observation');
				}
				const store = new PublicationManifestAvailabilityStore(
					drizzle(state.storage, { schema })
				);
				expect(store.isAccepted(version)).toBe(true);
				expect(store.snapshot(version)).toStrictEqual({
					...before,
					revision: 2,
					lifecycleRevision: 2
				});
				expect(store.isCurrent(version, before)).toBe(false);
				expect(store.isCurrent(version, store.snapshot(version))).toBe(true);
				expect(store.nextLifecycleIntent()).toBeUndefined();
				expect(store.drainPage(1)).toStrictEqual({
					processed: 0,
					remaining: false
				});
				expect(
					state.storage.sql
						.exec('SELECT * FROM publication_manifest_availability_revision')
						.toArray()
				).toStrictEqual([]);
				expect(
					state.storage.sql
						.exec('SELECT * FROM publication_manifest_availability_clock')
						.toArray()
				).toStrictEqual([{ id: 1, revision: 2, lifecycle_revision: 2 }]);
				expect(store.isCurrent(version, before)).toBe(false);
			}
		);
	});

	it.each([4, 128])(
		'reclaims physical-deletion/recreation history after %i identities with only singleton observation state',
		async (count) => {
			await withStore(
				`constant-lifecycle-history-${count.toString()}`,
				(store, storage) => {
					const remote = begin(store);
					store.acknowledge(remote.revision);
					const before = store.snapshot(version);
					const accepted = {
						narinfo: storage.sql.exec('SELECT * FROM narinfo').toArray(),
						generation: storage.sql
							.exec('SELECT * FROM generation_seq')
							.toArray()
					};
					const costs: { read: number; written: number }[] = [];
					for (let index = 0; index < count; index += 1) {
						const id = 20 + index;
						for (let incarnation = 0; incarnation < 2; incarnation += 1) {
							storage.sql.exec(
								"INSERT INTO cache_identity(id,kind,name,access,priority,generation,created_at) VALUES (?,'named',?,'public',40,?,'2026-01-01T00:00:00.000Z')",
								id,
								`history-${id.toString()}`,
								incarnation + 1
							);
							const cursor = storage.sql.exec(
								'DELETE FROM cache_identity WHERE id=?',
								id
							);
							cursor.toArray();
							costs.push({
								read: cursor.rowsRead,
								written: cursor.rowsWritten
							});
							const intent = store.nextLifecycleIntent();
							if (intent === undefined) {
								throw new Error('Missing lifecycle deletion');
							}
							expect(intent).toStrictEqual({
								revision: 2 + 2 * index + incarnation,
								cacheId: id,
								cacheGeneration: incarnation + 1,
								phase: 'associations',
								cursorResultHash: sqlNull,
								cursorResultGeneration: sqlNull,
								cursorOperationId: sqlNull
							});
							expect(store.drainLifecyclePage(intent.revision)).toStrictEqual({
								processed: 0,
								remaining: true
							});
							expect(store.drainLifecyclePage(intent.revision)).toStrictEqual({
								processed: 0,
								remaining: false
							});
						}
					}
					expect(
						storage.sql
							.exec('SELECT * FROM publication_manifest_availability_clock')
							.toArray()
					).toStrictEqual([
						{
							id: 1,
							revision: 1 + 2 * count,
							lifecycle_revision: 1 + 2 * count
						}
					]);
					expect(
						storage.sql
							.exec(
								"SELECT name FROM sqlite_master WHERE name='publication_manifest_lifecycle_revision'"
							)
							.toArray()
					).toStrictEqual([]);
					expect(
						storage.sql
							.exec('SELECT * FROM publication_manifest_lifecycle_intent')
							.toArray()
					).toStrictEqual([]);
					expect(
						storage.sql
							.exec('SELECT id FROM cache_identity ORDER BY id')
							.toArray()
					).toStrictEqual([{ id: 10 }]);
					expect({
						narinfo: storage.sql.exec('SELECT * FROM narinfo').toArray(),
						generation: storage.sql
							.exec('SELECT * FROM generation_seq')
							.toArray()
					}).toStrictEqual(accepted);
					expect(store.snapshot(version)).toStrictEqual({
						...before,
						revision: 1 + 2 * count,
						lifecycleRevision: 1 + 2 * count
					});
					expect(store.isCurrent(version, before)).toBe(false);
					expect(store.isCurrent(version, store.snapshot(version))).toBe(true);
					for (const cost of costs) {
						expect(cost).toStrictEqual(costs[0]);
						expect(cost.read + cost.written).toBeLessThan(100);
					}
					expect(store.drainPage(remote.revision)).toStrictEqual({
						processed: 0,
						remaining: false
					});
					expect(
						storage.sql
							.exec('SELECT * FROM publication_manifest_availability_revision')
							.toArray()
					).toStrictEqual([]);
				}
			);
		}
	);

	it('does not fence ignored UPDATE conflicts or lose their mirror before a later actual REPLACE', async () => {
		await withStore('ignored-update', (store, storage) => {
			storage.sql.exec(
				"INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (10,'occupied','/nix/store/occupied-path',?,10,'[]',8,'2026-01-01T00:00:00.000Z')",
				version.narHash
			);
			const before = {
				snapshot: store.snapshot(version),
				mirror: storage.sql
					.exec(
						'SELECT * FROM publication_manifest_local_identity ORDER BY store_path_hash'
					)
					.toArray(),
				narinfo: storage.sql
					.exec('SELECT * FROM narinfo ORDER BY store_path_hash')
					.toArray()
			};
			storage.sql.exec(
				"UPDATE OR IGNORE narinfo SET store_path_hash='occupied' WHERE store_path_hash=?",
				version.storePathHash
			);
			expect({
				snapshot: store.snapshot(version),
				mirror: storage.sql
					.exec(
						'SELECT * FROM publication_manifest_local_identity ORDER BY store_path_hash'
					)
					.toArray(),
				narinfo: storage.sql
					.exec('SELECT * FROM narinfo ORDER BY store_path_hash')
					.toArray()
			}).toStrictEqual(before);
			expect(store.nextIntent()).toBeUndefined();
			seedProof(storage.sql, 'candidate');
			selectProof(storage.sql, 'candidate');
			storage.sql.exec(
				'INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,8,created_at FROM narinfo WHERE store_path_hash=?',
				version.storePathHash
			);
			expect(store.nextIntent(false)?.kind).toBe('local-replace');
			expect(withRowBudget(() => store.drain())).toBe(false);
			expect(complete(storage.sql, 'candidate')).toBe(0);
		});
	});

	it('retains a deleted mirror only until bounded reclamation and recognises changed REPLACE with recursive triggers enabled', async () => {
		await withStore('recursive-replace', (store, storage) => {
			seedOperation(storage.sql, 'old');
			seedProof(storage.sql, 'old');
			selectProof(storage.sql, 'old');
			storage.sql.exec('PRAGMA recursive_triggers=ON');
			storage.sql.exec(
				'INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,8,created_at FROM narinfo WHERE cache_id=10'
			);
			expect(
				storage.sql
					.exec(
						'SELECT revision,kind,remote_pending FROM publication_manifest_availability_intent ORDER BY revision'
					)
					.toArray()
			).toStrictEqual([
				{ revision: 1, kind: 'local', remote_pending: 0 },
				{ revision: 2, kind: 'local-replace', remote_pending: 0 }
			]);
			expect(withRowBudget(() => store.drain())).toBe(false);
			expect(complete(storage.sql, 'old')).toBe(0);
			expect(
				storage.sql
					.exec('SELECT * FROM publication_manifest_local_identity')
					.toArray()
			).toStrictEqual([
				{
					cache_id: 10,
					store_path_hash: version.storePathHash,
					store_path: version.storePath,
					nar_hash: version.narHash,
					generation: 8
				}
			]);
			storage.sql.exec('DELETE FROM narinfo WHERE cache_id=10');
			expect(
				storage.sql
					.exec('SELECT * FROM publication_manifest_local_identity')
					.toArray()
			).toStrictEqual([
				{
					cache_id: 10,
					store_path_hash: version.storePathHash,
					store_path: version.storePath,
					nar_hash: version.narHash,
					generation: 8
				}
			]);
			expect(withRowBudget(() => store.drain())).toBe(false);
			expect(
				storage.sql
					.exec('SELECT * FROM publication_manifest_local_identity')
					.toArray()
			).toStrictEqual([]);
		});
	});

	it('bounds actual REPLACE and incompatible owner retirement across 256 and 100000 historical result generations', async () => {
		const costs: {
			mutation: { read: number; written: number };
			first: { read: number; written: number };
			second: { read: number; written: number };
		}[] = [];
		for (const count of [256, 100_000]) {
			await withStore(
				`replacement-owners-${count.toString()}`,
				(store, storage) => {
					storage.sql.exec(
						"WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i+1 < ?) INSERT INTO result_publication(cache_id,cache_generation,result_hash,result_path,result_generation,result_nar_hash,digest,origin,complete,materialisation_id) SELECT 10,3,?,?,i+7,?,'digest','build-selection',1,printf('owner-proof-%06d',i) FROM n",
						count,
						version.storePathHash,
						version.storePath,
						version.narHash
					);
					const cursor = storage.sql.exec(
						'INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,8,created_at FROM narinfo WHERE cache_id=10'
					);
					cursor.toArray();
					const mutation = {
						read: cursor.rowsRead,
						written: cursor.rowsWritten
					};
					expect(mutation.read + mutation.written).toBeLessThan(100);
					const intent = store.nextIntent(false);
					if (intent === undefined) {
						throw new Error('Missing replacement fence');
					}
					expect(store.drainPage(intent.revision)).toStrictEqual({
						processed: 0,
						remaining: true
					});
					const meter = new DatabaseCostMeter();
					const metered = new PublicationManifestAvailabilityStore(
						drizzle(meteredStorage(storage, meter), { schema })
					);
					const first = measure(meter, () =>
						metered.drainPage(intent.revision)
					);
					expect(first.value).toStrictEqual({ processed: 64, remaining: true });
					expect(metered.getIntent(intent.revision)).toStrictEqual({
						...intent,
						phase: 'owners',
						cursorOwnerGeneration: 71
					});
					const restarted = new PublicationManifestAvailabilityStore(
						drizzle(meteredStorage(storage, meter), { schema })
					);
					const second = measure(meter, () =>
						restarted.drainPage(intent.revision)
					);
					expect(second.value).toStrictEqual({
						processed: 64,
						remaining: true
					});
					expect(restarted.getIntent(intent.revision)).toStrictEqual({
						...intent,
						phase: 'owners',
						cursorOwnerGeneration: 135
					});
					expect(
						storage.sql
							.exec(
								'SELECT result_generation,complete FROM result_publication WHERE result_generation<=135 ORDER BY result_generation'
							)
							.toArray()
					).toStrictEqual([{ result_generation: 8, complete: 1 }]);
					expect(
						storage.sql
							.exec(
								"SELECT materialisation_id,digest FROM publication_manifest_retirement WHERE materialisation_id IN ('owner-proof-000000','owner-proof-000001','owner-proof-000128') ORDER BY materialisation_id"
							)
							.toArray()
					).toStrictEqual([
						{ materialisation_id: 'owner-proof-000000', digest: 'digest' },
						{ materialisation_id: 'owner-proof-000128', digest: 'digest' }
					]);
					expect(first.read + first.written).toBeLessThan(1000);
					expect(second.read + second.written).toBeLessThan(1000);
					costs.push({
						mutation,
						first: { read: first.read, written: first.written },
						second: { read: second.read, written: second.written }
					});
				}
			);
		}
		expect(costs[1]).toStrictEqual(costs[0]);
	});

	it('uses covering composite seeks for replacement and lifecycle continuation, never sorting or filtering past raw page bounds', async () => {
		await withStore('local-plans', (_store, storage) => {
			const queries = [
				[
					"SELECT member_generation,member_path,member_nar_hash,materialisation_id FROM result_publication_member INDEXED BY result_publication_member_reverse_idx WHERE cache_id=10 AND cache_generation=3 AND member_hash='hash' AND (member_generation,member_path,member_nar_hash,materialisation_id) > (7,'path','nar','proof') ORDER BY member_generation,member_path,member_nar_hash,materialisation_id LIMIT 64",
					'USING COVERING INDEX result_publication_member_reverse_idx',
					'(member_generation,member_path,member_nar_hash,materialisation_id)>(?,?,?,?)'
				],
				[
					"SELECT result_generation,result_path,result_nar_hash FROM result_publication WHERE cache_id=10 AND cache_generation=3 AND result_hash='hash' AND result_generation>7 ORDER BY result_generation LIMIT 64",
					'USING INDEX sqlite_autoindex_result_publication_1',
					'result_generation>?'
				],
				[
					"SELECT result_hash,result_generation FROM result_publication WHERE cache_id=10 AND cache_generation=3 AND (result_hash,result_generation)>('owner',7) ORDER BY result_hash,result_generation LIMIT 64",
					'USING COVERING INDEX sqlite_autoindex_result_publication_1',
					'(result_hash,result_generation)>(?,?)'
				],
				[
					"SELECT id FROM publication_manifest_operation INDEXED BY publication_manifest_operation_scope_idx WHERE cache_id=10 AND cache_generation=3 AND id>'op' ORDER BY id LIMIT 64",
					'USING COVERING INDEX publication_manifest_operation_scope_idx',
					'id>?'
				]
			] as const;
			for (const [query, index, seek] of queries) {
				const plan = Array.from(
					storage.sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`),
					(row) => row.detail
				).join('\n');
				expect(plan).toContain(index);
				expect(plan).toContain(seek);
				expect(plan).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
			}
		});
	});

	it.each([
		'delete',
		'update',
		'replace',
		'cache-generation',
		'cache-delete'
	] as const)(
		'blocks real candidate finalisation and certificate availability through pending local %s work, then fails the stale candidate',
		async (mutation) => {
			await withStore(`finalisation-${mutation}`, (store, storage, context) => {
				seedOperation(storage.sql, 'candidate');
				seedProof(storage.sql, 'candidate');
				storage.sql.exec(
					"INSERT INTO publication_manifest(digest,version,member_count) VALUES ('digest',1,1)"
				);
				storage.sql.exec(
					'INSERT INTO publication_manifest_member(digest,ordinal,store_path,store_path_hash,nar_hash) VALUES (?,0,?,?,?)',
					'digest',
					version.storePath,
					version.storePathHash,
					version.narHash
				);
				storage.sql.exec(
					"UPDATE publication_manifest_operation SET candidate_digest='digest',cursor=1 WHERE id='candidate'"
				);
				const repository = new PublicationManifestRepository(context);
				const cache = context.cacheRepository.require(
					context.cacheRepository.scopeForId(version.cacheId)
				);
				expect(() => {
					repository.assertMaterialisationComplete('candidate', 'digest', 1);
				}).not.toThrow();
				const immutable = {
					members: storage.sql
						.exec('SELECT * FROM result_publication_member')
						.toArray(),
					portable: storage.sql
						.exec('SELECT * FROM publication_manifest_member')
						.toArray(),
					cardinality: storage.sql
						.exec(
							'SELECT * FROM publication_manifest_cardinality ORDER BY kind,id'
						)
						.toArray()
				};
				const statements = {
					delete: 'DELETE FROM narinfo WHERE cache_id=10',
					update: 'UPDATE narinfo SET generation=8 WHERE cache_id=10',
					replace:
						'INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,8,created_at FROM narinfo WHERE cache_id=10',
					'cache-generation':
						'UPDATE cache_identity SET generation=4 WHERE id=10',
					'cache-delete': 'DELETE FROM cache_identity WHERE id=10'
				};
				storage.sql.exec(statements[mutation]);
				expect(() => {
					repository.requireAvailable(cache);
				}).toThrow('Service Unavailable');
				expect(() => {
					repository.assertMaterialisationComplete('candidate', 'digest', 1);
				}).toThrow('Service Unavailable');
				const local = store.nextIntent(false);
				if (local !== undefined) {
					expect(() =>
						storage.sql.exec(
							'UPDATE publication_manifest_availability_intent SET remote_pending=1 WHERE revision=?',
							local.revision
						)
					).toThrow('CHECK constraint failed');
					expect(store.nextIntent(true)).toBeUndefined();
					expect(store.getIntent(local.revision)).toStrictEqual(local);
				}
				expect(withRowBudget(() => store.drain())).toBe(false);
				expect(() => {
					repository.assertMaterialisationComplete('candidate', 'digest', 1);
				}).toThrow('Conflict');
				expect({
					members: storage.sql
						.exec('SELECT * FROM result_publication_member')
						.toArray(),
					portable: storage.sql
						.exec('SELECT * FROM publication_manifest_member')
						.toArray(),
					cardinality: storage.sql
						.exec(
							'SELECT * FROM publication_manifest_cardinality ORDER BY kind,id'
						)
						.toArray()
				}).toStrictEqual(immutable);
			});
		}
	);

	it.each(['delete', 'update', 'replace'] as const)(
		'preserves genuinely healthy same-version proofs after local %s while old work drains and never resurrects old probes',
		async (mutation) => {
			await withStore(`local-healthy-${mutation}`, (store, storage) => {
				const before = store.snapshot(version);
				const statements = {
					delete: 'DELETE FROM narinfo WHERE cache_id=10',
					update: 'UPDATE narinfo SET generation=8 WHERE cache_id=10',
					replace:
						'INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,8,created_at FROM narinfo WHERE cache_id=10'
				};
				storage.sql.exec(statements[mutation]);
				if (mutation === 'delete') {
					storage.sql.exec(
						"INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) VALUES (10,?,?,?,10,'[]',7,'2026-01-01T00:00:00.000Z')",
						version.storePathHash,
						version.storePath,
						version.narHash
					);
				} else {
					storage.sql.exec('UPDATE narinfo SET generation=7 WHERE cache_id=10');
				}
				const healthy = store.snapshot(version);
				expect(store.isAccepted(version)).toBe(true);
				expect(store.isCurrent(version, healthy)).toBe(true);
				seedOperation(storage.sql, 'healthy');
				seedProof(storage.sql, 'healthy', healthy.revision);
				selectProof(storage.sql, 'healthy');
				expect(withRowBudget(() => store.drain())).toBe(false);
				expect(
					storage.sql
						.exec(
							"SELECT complete,materialisation_id FROM result_publication WHERE result_hash='healthy'"
						)
						.toArray()
				).toStrictEqual([{ complete: 1, materialisation_id: 'healthy' }]);
				expect(
					storage.sql
						.exec(
							"SELECT state,failure_json FROM publication_manifest_operation WHERE id='healthy'"
						)
						.toArray()
				).toStrictEqual([{ state: 'pending', failure_json: sqlNull }]);
				expect(store.isCurrent(version, before)).toBe(false);
				expect(store.hasPending(version)).toBe(false);
				expect(store.isCurrent(version, store.snapshot(version))).toBe(true);
			});
		}
	);

	it.each([false, true])(
		'preserves live lifecycle selections before and after draining an ignored unique-name UPDATE with recursive triggers %s',
		async (recursive) => {
			await withStore(
				`ignored-lifecycle-${recursive.toString()}`,
				(store, storage) => {
					storage.sql.exec(
						`PRAGMA recursive_triggers=${recursive ? 'ON' : 'OFF'}`
					);
					seedLifecycleSelections(storage.sql);
					const before = lifecycleStorageState(storage.sql);
					expect(
						before.identities.map(({ id, name, generation, deleted_at }) => ({
							id,
							name,
							generation,
							deleted_at
						}))
					).toStrictEqual([
						{ id: 10, name: 'cache-10', generation: 3, deleted_at: sqlNull },
						{ id: 11, name: 'cache-11', generation: 3, deleted_at: sqlNull }
					]);
					expect(before.selectedEdges).toStrictEqual(
						before.proofs.filter((row) => row.cache_generation === 3)
					);
					const observation = store.snapshot(version);
					storage.sql.exec(
						"UPDATE OR IGNORE cache_identity SET name='cache-11',generation=generation+1 WHERE id=10"
					);
					const afterIgnored = lifecycleStorageState(storage.sql);
					expect(withRowBudget(() => store.drain())).toBe(false);
					expect({
						afterIgnored,
						afterDrain: lifecycleStorageState(storage.sql)
					}).toStrictEqual({ afterIgnored: before, afterDrain: before });
					expect(store.isCurrent(version, observation)).toBe(true);
				}
			);
		}
	);

	it.each(
		(['generation', 'deleted-at', 'both'] as const).flatMap((mutation) =>
			[false, true].map((recursive) => ({ mutation, recursive }))
		)
	)(
		'retires exactly the OLD generation on accepted lifecycle $mutation with recursive triggers $recursive',
		async ({ mutation, recursive }) => {
			await withStore(
				`accepted-lifecycle-${mutation}-${recursive.toString()}`,
				(store, storage) => {
					storage.sql.exec(
						`PRAGMA recursive_triggers=${recursive ? 'ON' : 'OFF'}`
					);
					seedLifecycleSelections(storage.sql);
					const before = lifecycleStorageState(storage.sql);
					const statements = {
						generation: 'UPDATE cache_identity SET generation=4 WHERE id=10',
						'deleted-at':
							"UPDATE cache_identity SET deleted_at='2026-02-01T00:00:00.000Z' WHERE id=10",
						both: "UPDATE cache_identity SET generation=4,deleted_at='2026-02-01T00:00:00.000Z' WHERE id=10"
					};
					storage.sql.exec(statements[mutation]);
					const accepted = lifecycleStorageState(storage.sql);
					expect(accepted).toStrictEqual({
						...before,
						identities: before.identities.map((row) =>
							row.id === 10
								? {
										...row,
										generation: mutation === 'deleted-at' ? 3 : 4,
										deleted_at:
											mutation === 'generation'
												? sqlNull
												: '2026-02-01T00:00:00.000Z'
									}
								: row
						),
						clock: [{ id: 1, revision: 1, lifecycle_revision: 1 }],
						intents: [
							{
								revision: 1,
								cache_id: 10,
								cache_generation: 3,
								cursor_result_hash: sqlNull,
								cursor_result_generation: sqlNull,
								cursor_operation_id: sqlNull,
								phase: 'associations'
							}
						],
						selectedEdges: before.proofs.filter(
							(row) =>
								row.cache_id === 11 ||
								(mutation === 'generation' && row.cache_generation === 4)
						)
					});
					expect(withRowBudget(() => store.drain())).toBe(false);
					const retired = lifecycleStorageState(storage.sql);
					expect(retired).toStrictEqual({
						...accepted,
						intents: [],
						associations: before.associations.filter(
							(row) => row.cache_id !== 10 || row.cache_generation !== 3
						),
						operations: before.operations.map((row) =>
							row.id === 'lifecycle-10-3'
								? {
										...row,
										state: 'failed',
										failure_json: '{"kind":"failed","reason":"scope-changed"}'
									}
								: row
						),
						retirements: [
							{ materialisation_id: 'lifecycle-10-3', digest: 'digest' }
						],
						gcInputs: before.gcInputs.map((row) =>
							row.cache_id === 10 ? { ...row, inputs_changed: 1 } : row
						)
					});
					expect(withRowBudget(() => store.drain())).toBe(false);
					expect(lifecycleStorageState(storage.sql)).toStrictEqual(retired);
				}
			);
		}
	);

	it.each(['generation', 'deleted-at', 'delete'] as const)(
		'installs a constant-size SQL lifecycle %s fence at 128 and 100000 associations and retires indexed pages',
		async (mutation) => {
			const costs: {
				mutation: { read: number; written: number };
				first: { read: number; written: number };
				second: { read: number; written: number };
			}[] = [];
			for (const count of [128, 100_000]) {
				await withStore(
					`lifecycle-${mutation}-${count.toString()}`,
					(unmetered, storage) => {
						seedFanIn(storage.sql, count);
						// A genuinely current incomplete selection must remain a GC edge.
						selectProof(storage.sql, 'current-incomplete');
						storage.sql.exec(
							"UPDATE result_publication SET cache_generation=4,complete=0 WHERE result_hash='current-incomplete'"
						);
						const members = storage.sql
							.exec<{ count: number }>(
								'SELECT count(*) AS count FROM result_publication_member'
							)
							.one();
						const before = unmetered.snapshot(version);
						const statements = {
							generation: 'UPDATE cache_identity SET generation=4 WHERE id=10',
							'deleted-at':
								"UPDATE cache_identity SET deleted_at='2026-02-01T00:00:00.000Z' WHERE id=10",
							delete: 'DELETE FROM cache_identity WHERE id=10'
						};
						const cursor = storage.sql.exec(statements[mutation]);
						cursor.toArray();
						const mutationCost = {
							read: cursor.rowsRead,
							written: cursor.rowsWritten
						};
						expect(mutationCost.read + mutationCost.written).toBeLessThan(100);
						expect(unmetered.nextIntent()).toBeUndefined();
						expect(unmetered.hasPending(version)).toBe(true);
						expect(
							unmetered.hasPending({
								...version,
								cacheGeneration: cacheGenerationSchema.parse(4)
							})
						).toBe(false);
						expect(unmetered.isCurrent(version, before)).toBe(false);
						const intent = unmetered.nextLifecycleIntent();
						if (intent === undefined) {
							throw new Error('Missing lifecycle fence');
						}
						expect(intent).toStrictEqual({
							revision: 1,
							cacheId: 10,
							cacheGeneration: 3,
							cursorResultHash: sqlNull,
							cursorResultGeneration: sqlNull,
							cursorOperationId: sqlNull,
							phase: 'associations'
						});
						const meter = new DatabaseCostMeter();
						const store = new PublicationManifestAvailabilityStore(
							drizzle(meteredStorage(storage, meter), { schema })
						);
						const first = measure(meter, () =>
							store.drainLifecyclePage(intent.revision)
						);
						expect(first.value).toStrictEqual({
							processed: 64,
							remaining: true
						});
						expect(store.nextLifecycleIntent()).toStrictEqual({
							...intent,
							cursorResultHash: 'owner-000063',
							cursorResultGeneration: 7
						});
						const restarted = new PublicationManifestAvailabilityStore(
							drizzle(meteredStorage(storage, meter), { schema })
						);
						const second = measure(meter, () =>
							restarted.drainLifecyclePage(intent.revision)
						);
						expect(second.value).toStrictEqual({
							processed: 64,
							remaining: true
						});
						expect(restarted.nextLifecycleIntent()).toStrictEqual({
							...intent,
							cursorResultHash: 'owner-000127',
							cursorResultGeneration: 7
						});
						expect(complete(storage.sql, 'owner-000000')).toBeUndefined();
						expect(complete(storage.sql, 'owner-000127')).toBeUndefined();
						expect(
							storage.sql
								.exec(
									"SELECT cache_generation,complete FROM result_publication WHERE result_hash='current-incomplete'"
								)
								.toArray()
						).toStrictEqual([{ cache_generation: 4, complete: 0 }]);
						expect(
							storage.sql
								.exec<{ count: number }>(
									'SELECT count(*) AS count FROM result_publication_member'
								)
								.one()
						).toStrictEqual(members);
						expect(
							storage.sql
								.exec(
									"SELECT materialisation_id,digest FROM publication_manifest_retirement WHERE materialisation_id='proof-000063'"
								)
								.toArray()
						).toStrictEqual([
							{ materialisation_id: 'proof-000063', digest: 'digest' }
						]);
						if (count > 128) {
							expect(complete(storage.sql, 'owner-000128')).toBe(1);
						} else {
							expect(
								restarted.drainLifecyclePage(intent.revision)
							).toStrictEqual({ processed: 0, remaining: true });
							expect(
								restarted.drainLifecyclePage(intent.revision)
							).toStrictEqual({ processed: 64, remaining: true });
							expect(restarted.nextLifecycleIntent()).toStrictEqual({
								...intent,
								cursorResultHash: 'owner-000127',
								cursorResultGeneration: 7,
								cursorOperationId: 'proof-000063',
								phase: 'operations'
							});
							expect(
								restarted.drainLifecyclePage(intent.revision)
							).toStrictEqual({ processed: 64, remaining: true });
							expect(
								restarted.drainLifecyclePage(intent.revision)
							).toStrictEqual({ processed: 0, remaining: false });
							expect(restarted.hasPending(version)).toBe(false);
							expect(restarted.isCurrent(version, before)).toBe(false);
							expect(
								storage.sql
									.exec(
										"SELECT state,failure_json FROM publication_manifest_operation WHERE id='proof-000127'"
									)
									.toArray()
							).toStrictEqual([
								{
									state: 'failed',
									failure_json: '{"kind":"failed","reason":"scope-changed"}'
								}
							]);
						}
						expect(first.read + first.written).toBeLessThan(2500);
						expect(second.read + second.written).toBeLessThan(2500);
						costs.push({
							mutation: mutationCost,
							first: { read: first.read, written: first.written },
							second: { read: second.read, written: second.written }
						});
					}
				);
			}
			expect(costs[1]).toStrictEqual(costs[0]);
			expect(costs[0]).toStrictEqual({
				mutation: {
					read: mutation === 'delete' ? 7 : 4,
					written: mutation === 'deleted-at' ? 5 : 4
				},
				first: { read: 194, written: 193 },
				second: { read: 194, written: 193 }
			});
		}
	);

	it('visits bounded raw lifecycle operation pages, including terminal receipts, at 128 and 100000 fan-in', async () => {
		const costs: { read: number; written: number }[] = [];
		for (const count of [128, 100_000]) {
			await withStore(
				`lifecycle-operations-${count.toString()}`,
				(unmetered, storage) => {
					storage.sql.exec(
						"WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i+1 < ?) INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,expires_at,state) SELECT printf('op-%06d',i),printf('op-%06d',i),'ensure',10,3,'{}','{}','build-selection',1,'2027-01-01T00:00:00.000Z',CASE WHEN i%2=0 THEN 'pending' ELSE 'complete' END FROM n",
						count
					);
					storage.sql.exec(
						'UPDATE cache_identity SET generation=4 WHERE id=10'
					);
					const intent = unmetered.nextLifecycleIntent();
					if (intent === undefined) {
						throw new Error('Missing lifecycle intent');
					}
					expect(unmetered.drainLifecyclePage(intent.revision)).toStrictEqual({
						processed: 0,
						remaining: true
					});
					const meter = new DatabaseCostMeter();
					const store = new PublicationManifestAvailabilityStore(
						drizzle(meteredStorage(storage, meter), { schema })
					);
					for (const last of ['op-000063', 'op-000127']) {
						const page = measure(meter, () =>
							store.drainLifecyclePage(intent.revision)
						);
						expect(page.value).toStrictEqual({
							processed: 64,
							remaining: true
						});
						expect(store.nextLifecycleIntent()).toStrictEqual({
							...intent,
							phase: 'operations',
							cursorOperationId: last
						});
						expect(page.read + page.written).toBeLessThan(1000);
						costs.push({ read: page.read, written: page.written });
					}
					expect(
						storage.sql
							.exec(
								"SELECT id,state,failure_json FROM publication_manifest_operation WHERE id IN ('op-000126','op-000127') ORDER BY id"
							)
							.toArray()
					).toStrictEqual([
						{
							id: 'op-000126',
							state: 'failed',
							failure_json: '{"kind":"failed","reason":"scope-changed"}'
						},
						{ id: 'op-000127', state: 'complete', failure_json: sqlNull }
					]);
					if (count > 128) {
						expect(operationState(storage.sql, 'op-000128')).toBe('pending');
					} else {
						expect(store.drainLifecyclePage(intent.revision)).toStrictEqual({
							processed: 0,
							remaining: false
						});
					}
				}
			);
		}
		expect(costs).toStrictEqual([costs[0], costs[0], costs[0], costs[0]]);
		expect(costs[0]).toStrictEqual({ read: 226, written: 129 });
	});

	it('persists local and lifecycle fences and cursors through actual reset and rejects pre-mutation probes after all intent reclamation', async () => {
		let before: PublicationManifestAvailabilitySnapshot | undefined;
		await withStore('local-lifecycle-reset', (store, storage) => {
			seedFanIn(storage.sql, 130);
			before = store.snapshot(version);
			storage.sql.exec('UPDATE narinfo SET generation=8 WHERE cache_id=10');
			storage.sql.exec('UPDATE cache_identity SET generation=4 WHERE id=10');
			const local = store.nextIntent(false);
			const lifecycle = store.nextLifecycleIntent();
			if (local === undefined || lifecycle === undefined) {
				throw new Error('Missing local work');
			}
			expect(store.drainPage(local.revision)).toStrictEqual({
				processed: 64,
				remaining: true
			});
			expect(store.drainLifecyclePage(lifecycle.revision)).toStrictEqual({
				processed: 64,
				remaining: true
			});
		});
		await restartTestServers();
		await runInDurableObject(
			testServerFor('manifest-availability-local-lifecycle-reset'),
			(_instance, state) => {
				const store = new PublicationManifestAvailabilityStore(
					drizzle(state.storage, { schema })
				);
				const local = store.nextIntent(false);
				const lifecycle = store.nextLifecycleIntent();
				if (
					before === undefined ||
					local === undefined ||
					lifecycle === undefined
				) {
					throw new Error('Lost local state');
				}
				expect(local.cursorMaterialisationId).toBe('proof-000063');
				expect(lifecycle.cursorResultHash).toBe('owner-000063');
				expect(store.nextIntent(true)).toBeUndefined();
				expect(store.drainPage(local.revision)).toStrictEqual({
					processed: 64,
					remaining: true
				});
				expect(store.drainPage(local.revision)).toStrictEqual({
					processed: 2,
					remaining: false
				});
				expect(store.drainLifecyclePage(lifecycle.revision)).toStrictEqual({
					processed: 64,
					remaining: true
				});
				expect(store.drainLifecyclePage(lifecycle.revision)).toStrictEqual({
					processed: 2,
					remaining: true
				});
				expect(store.drainLifecyclePage(lifecycle.revision)).toStrictEqual({
					processed: 64,
					remaining: true
				});
				expect(store.drainLifecyclePage(lifecycle.revision)).toStrictEqual({
					processed: 64,
					remaining: true
				});
				expect(store.drainLifecyclePage(lifecycle.revision)).toStrictEqual({
					processed: 2,
					remaining: false
				});
				expect(store.hasPending(version)).toBe(false);
				expect(store.isCurrent(version, before)).toBe(false);
				expect(
					state.storage.sql
						.exec('SELECT * FROM publication_manifest_availability_revision')
						.toArray()
				).toStrictEqual([]);
				expect(
					state.storage.sql
						.exec('SELECT * FROM publication_manifest_availability_clock')
						.toArray()
				).toStrictEqual([{ id: 1, revision: 2, lifecycle_revision: 2 }]);
			}
		);
	});

	it('keeps a pre-lifecycle nonzero path snapshot stale after queue reclamation and SQL ABA while unrelated observations retry and recover', async () => {
		await withStore('lifecycle-aba', (store, storage) => {
			const remote = begin(store);
			store.acknowledge(remote.revision);
			const before = store.snapshot(version);
			storage.sql.exec('UPDATE cache_identity SET generation=4 WHERE id=10');
			storage.sql.exec('UPDATE cache_identity SET generation=3 WHERE id=10');
			for (const revision of [2, 3]) {
				expect(store.drainLifecyclePage(revision)).toStrictEqual({
					processed: 0,
					remaining: true
				});
				expect(store.drainLifecyclePage(revision)).toStrictEqual({
					processed: 0,
					remaining: false
				});
			}
			expect(store.isAccepted(version)).toBe(true);
			expect(store.snapshot(version)).toStrictEqual({
				...before,
				revision: 3,
				lifecycleRevision: 3
			});
			expect(store.isCurrent(version, before)).toBe(false);
			const healthy = store.snapshot(version);
			storage.sql.exec(
				"INSERT INTO cache_identity(id,kind,name,access,priority,generation,created_at) VALUES (11,'named','other','public',40,1,'2026-01-01T00:00:00.000Z')"
			);
			storage.sql.exec('DELETE FROM cache_identity WHERE id=11');
			expect(store.isCurrent(version, healthy)).toBe(false);
			expect(store.snapshot(version)).toStrictEqual({
				...healthy,
				revision: 4,
				lifecycleRevision: 4
			});
			expect(store.isCurrent(version, store.snapshot(version))).toBe(true);
			expect(store.hasPending(version)).toBe(true); // only the original remote intent
			expect(store.nextLifecycleIntent()?.cacheId).toBe(11);
		});
	});

	it.each(['delete', 'update', 'replace'] as const)(
		'fences local %s in constant work at small and 100000 fan-in, then resumes indexed pages',
		async (mutation) => {
			const costs: {
				mutation: { read: number; written: number };
				first: { read: number; written: number };
				second: { read: number; written: number };
			}[] = [];
			for (const count of [128, 100_000]) {
				await withStore(
					`local-${mutation}-${count.toString()}`,
					(store, storage) => {
						seedFanIn(storage.sql, count);
						const before = store.snapshot(version);
						const statements = {
							delete: 'DELETE FROM narinfo WHERE cache_id=10',
							update: 'UPDATE narinfo SET generation=8 WHERE cache_id=10',
							replace:
								'INSERT OR REPLACE INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at) SELECT cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,8,created_at FROM narinfo WHERE cache_id=10'
						};
						const cursor = storage.sql.exec(statements[mutation]);
						cursor.toArray();
						const cost = { read: cursor.rowsRead, written: cursor.rowsWritten };
						expect(cost.read + cost.written).toBeLessThan(1000);
						expect(store.isCurrent(version, before)).toBe(false);
						expect(store.hasPending(version)).toBe(true);
						expect(store.nextIntent(true)).toBeUndefined();
						const intent = store.nextIntent(false);
						if (intent === undefined) {
							throw new Error('Missing local invalidation');
						}
						expect(intent).toStrictEqual({
							...version,
							revision: before.revision + 1,
							kind: mutation === 'replace' ? 'local-replace' : 'local',
							remotePending: false,
							cursorMaterialisationId: sqlNull,
							cursorMemberGeneration: sqlNull,
							cursorMemberPath: sqlNull,
							cursorMemberNarHash: sqlNull,
							cursorOwnerGeneration: sqlNull,
							phase: 'proofs',
							replacementGeneration: mutation === 'replace' ? 8 : sqlNull,
							replacementPath:
								mutation === 'replace' ? version.storePath : sqlNull,
							replacementNarHash:
								mutation === 'replace' ? version.narHash : sqlNull
						});
						expect(complete(storage.sql, 'owner-000000')).toBe(1);
						const meter = new DatabaseCostMeter();
						const metered = new PublicationManifestAvailabilityStore(
							drizzle(meteredStorage(storage, meter), { schema })
						);
						const first = measure(meter, () =>
							metered.drainPage(intent.revision)
						);
						expect(first.value).toStrictEqual({
							processed: 64,
							remaining: true
						});
						const restarted = new PublicationManifestAvailabilityStore(
							drizzle(meteredStorage(storage, meter), { schema })
						);
						expect(restarted.getIntent(intent.revision)).toStrictEqual({
							...intent,
							cursorMaterialisationId: 'proof-000063',
							cursorMemberGeneration: mutation === 'replace' ? 7 : sqlNull,
							cursorMemberPath:
								mutation === 'replace' ? version.storePath : sqlNull,
							cursorMemberNarHash:
								mutation === 'replace' ? version.narHash : sqlNull
						});
						const second = measure(meter, () =>
							restarted.drainPage(intent.revision)
						);
						expect(second.value).toStrictEqual({
							processed: 64,
							remaining: true
						});
						expect(first.read + first.written).toBeLessThan(2500);
						expect(second.read + second.written).toBeLessThan(2500);
						costs.push({
							mutation: cost,
							first: { read: first.read, written: first.written },
							second: { read: second.read, written: second.written }
						});
						expect(complete(storage.sql, 'owner-000127')).toBe(0);
						expect(operationState(storage.sql, 'proof-000127')).toBe('failed');
						if (count > 128) {
							expect(complete(storage.sql, 'owner-000128')).toBe(1);
						} else {
							if (mutation === 'replace') {
								expect(restarted.drainPage(intent.revision)).toStrictEqual({
									processed: 0,
									remaining: true
								});
							}
							expect(restarted.drainPage(intent.revision)).toStrictEqual({
								processed: 0,
								remaining: false
							});
							expect(restarted.hasPending(version)).toBe(false);
							expect(restarted.isCurrent(version, before)).toBe(false);
						}
					}
				);
			}
			expect(costs[1]).toStrictEqual(costs[0]);
			expect(costs[0]).toStrictEqual({
				mutation: {
					delete: { read: 15, written: 9 },
					update: { read: 17, written: 11 },
					replace: { read: 23, written: 15 }
				}[mutation],
				first: { read: 450, written: 321 },
				second: { read: mutation === 'replace' ? 451 : 450, written: 321 }
			});
		}
	);

	it('persists ambiguous intent across restart, cannot clear it by draining, and rejects pre/during-mutation snapshots after complete cleanup', async () => {
		await withStore('restart', (store, storage) => {
			const before = store.snapshot(version);
			const intent = begin(store);
			const during = store.snapshot(version);
			const restarted = new PublicationManifestAvailabilityStore(
				drizzle(storage, { schema })
			);
			expect(restarted.nextIntent(true)).toStrictEqual(intent);
			expect(during.unresolved).toBe(true);
			expect(restarted.isCurrent(version, before)).toBe(false);
			expect(restarted.drainPage(intent.revision)).toStrictEqual({
				processed: 0,
				remaining: true
			});
			expect(restarted.nextIntent(false)).toBeUndefined();
			expect(restarted.hasPending(version)).toBe(true);
			expect(
				restarted.hasPending({
					...version,
					cacheGeneration: cacheGenerationSchema.parse(4)
				})
			).toBe(false);
			restarted.acknowledge(intent.revision);
			restarted.acknowledge(intent.revision);
			expect(restarted.snapshot(version).unresolved).toBe(false);
			expect(restarted.isCurrent(version, during)).toBe(false);
			expect(restarted.drainPage(intent.revision)).toStrictEqual({
				processed: 0,
				remaining: false
			});
			expect(restarted.hasPending(version)).toBe(false);
			expect(restarted.isCurrent(version, before)).toBe(false);
			expect(restarted.isCurrent(version, during)).toBe(false);
			expect(
				storage.sql
					.exec('SELECT * FROM publication_manifest_availability_revision')
					.toArray()
			).toStrictEqual([]);
			const after = restarted.snapshot(version);
			expect(restarted.isCurrent(version, after)).toBe(true);
			expect(begin(restarted).revision).toBeGreaterThan(intent.revision);
			expect(restarted.isCurrent(version, after)).toBe(false);
		});
	});

	it('resumes the persisted reverse cursor after a real Durable Object reset without resolving an ambiguous mutation', async () => {
		let before: PublicationManifestAvailabilitySnapshot | undefined;
		await withStore('actual-restart', (store, storage) => {
			before = store.snapshot(version);
			seedFanIn(storage.sql, 130);
			const intent = begin(store);
			expect(store.drainPage(intent.revision)).toStrictEqual({
				processed: 64,
				remaining: true
			});
		});
		await restartTestServers();
		await runInDurableObject(
			testServerFor('manifest-availability-actual-restart'),
			(_instance, state) => {
				const store = new PublicationManifestAvailabilityStore(
					drizzle(state.storage, { schema })
				);
				const intent = store.nextIntent(true);
				if (intent === undefined) {
					throw new Error('Lost ambiguous intent at reset');
				}
				expect(intent.cursorMaterialisationId).toBe('proof-000063');
				expect(store.snapshot(version).unresolved).toBe(true);
				expect(store.drainPage(intent.revision)).toStrictEqual({
					processed: 64,
					remaining: true
				});
				expect(store.getIntent(intent.revision)?.cursorMaterialisationId).toBe(
					'proof-000127'
				);
				expect(store.drainPage(intent.revision)).toStrictEqual({
					processed: 2,
					remaining: true
				});
				expect(store.getIntent(intent.revision)?.remotePending).toBe(true);
				store.acknowledge(intent.revision);
				expect(store.drainPage(intent.revision)).toStrictEqual({
					processed: 0,
					remaining: false
				});
				expect(store.hasPending(version)).toBe(false);
				if (before === undefined) {
					throw new Error('Missing pre-mutation snapshot');
				}
				expect(store.isCurrent(version, before)).toBe(false);
				expect(begin(store).revision).toBeGreaterThan(intent.revision);
			}
		);
	});

	it('rolls back revision and intent together without changing accepted identities or generation allocation', async () => {
		await withStore('rollback', (store, storage) => {
			const before = store.snapshot(version);
			const narinfo = storage.sql.exec('SELECT * FROM narinfo').toArray();
			const generations = storage.sql
				.exec('SELECT * FROM generation_seq')
				.toArray();
			expect(() =>
				storage.transactionSync(() => {
					begin(store, 'revoke');
					throw new Error('rollback');
				})
			).toThrow('rollback');
			expect(store.snapshot(version)).toStrictEqual(before);
			expect(store.nextIntent()).toBeUndefined();
			begin(store);
			expect(storage.sql.exec('SELECT * FROM narinfo').toArray()).toStrictEqual(
				narinfo
			);
			expect(
				storage.sql.exec('SELECT * FROM generation_seq').toArray()
			).toStrictEqual(generations);
		});
	});

	it('never starts a stale mutation and exposes the exact local recovery fence', async () => {
		await withStore('accepted', (store, storage) => {
			expect(
				store.begin(
					{ ...version, generation: narInfoGenerationSchema.parse(8) },
					'revoke'
				)
			).toBeUndefined();
			expect(store.snapshot(version).revision).toBe(0);
			const intent = begin(store);
			expect(store.isAccepted(intent)).toBe(true);
			storage.sql.exec('UPDATE narinfo SET generation=8');
			expect(store.isAccepted(intent)).toBe(false);
			expect(store.begin(version, 'demote')).toBeUndefined();
			// An identity change alone does not resolve an ambiguous remote outcome.
			expect(store.getIntent(intent.revision)).toStrictEqual(intent);
		});
	});

	it('invalidates only exact-version selected certificates and matching pending candidates, preserving all membership and cardinality', async () => {
		await withStore('private', (store, storage) => {
			const sql = storage.sql;
			sql.exec(
				"INSERT INTO publication_manifest(digest,version,member_count) VALUES ('digest',1,1)"
			);
			sql.exec(
				'INSERT INTO publication_manifest_member VALUES (?,0,?,?,?)',
				'digest',
				version.storePath,
				version.storePathHash,
				version.narHash
			);
			for (const id of ['selected', 'private', 'unrelated']) {
				seedOperation(sql, id);
			}
			seedProof(sql, 'selected');
			selectProof(sql, 'selected');
			seedProof(sql, 'private', 0, 'selected');
			// An association selecting a different private materialisation is unaffected.
			seedProof(sql, 'loser', 0, 'unrelated');
			selectProof(sql, 'unrelated');
			sql.exec(
				"INSERT INTO result_publication_member(cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation) VALUES (10,3,'different-version',7,'different-version',?,?,?,8)",
				version.storePathHash,
				version.storePath,
				version.narHash
			);
			selectProof(sql, 'different-version');
			const members = sql
				.exec('SELECT * FROM result_publication_member')
				.toArray();
			const portable = sql
				.exec('SELECT * FROM publication_manifest_member')
				.toArray();
			const cardinality = sql
				.exec('SELECT * FROM publication_manifest_cardinality ORDER BY kind,id')
				.toArray();
			const intent = begin(store, 'revoke');
			sql.exec(
				'UPDATE garbage_collection_input SET inputs_changed=0 WHERE cache_id=10'
			);
			store.acknowledge(intent.revision);
			expect(store.drainPage(intent.revision)).toStrictEqual({
				processed: 3,
				remaining: false
			});
			expect(complete(sql, 'selected')).toBe(0);
			expect(complete(sql, 'unrelated')).toBe(1);
			expect(complete(sql, 'different-version')).toBe(1);
			expect(operationState(sql, 'selected')).toBe('failed');
			expect(operationState(sql, 'private')).toBe('failed');
			expect(operationState(sql, 'unrelated')).toBe('pending');
			expect(
				sql.exec('SELECT * FROM result_publication_member').toArray()
			).toStrictEqual(members);
			expect(
				sql.exec('SELECT * FROM publication_manifest_member').toArray()
			).toStrictEqual(portable);
			expect(
				sql
					.exec(
						'SELECT * FROM publication_manifest_cardinality ORDER BY kind,id'
					)
					.toArray()
			).toStrictEqual(cardinality);
			expect(
				sql
					.exec(
						'SELECT inputs_changed FROM garbage_collection_input WHERE cache_id=10'
					)
					.toArray()
			).toStrictEqual([{ inputs_changed: 1 }]);
		});
	});

	it('preserves later genuinely healthy same-version proofs while older work is queued and repeated mutation advances rather than rewinds', async () => {
		await withStore('repeat', (store, storage) => {
			const first = begin(store);
			store.acknowledge(first.revision);
			const healthy = store.snapshot(version);
			expect(store.isCurrent(version, healthy)).toBe(true);
			seedOperation(storage.sql, 'healthy');
			seedProof(storage.sql, 'healthy', healthy.revision);
			selectProof(storage.sql, 'healthy');
			expect(store.drainPage(first.revision)).toStrictEqual({
				processed: 1,
				remaining: false
			});
			expect(complete(storage.sql, 'healthy')).toBe(1);
			expect(operationState(storage.sql, 'healthy')).toBe('pending');
			const second = begin(store);
			expect(second.revision).toBeGreaterThan(first.revision);
			expect(second.cursorMaterialisationId).toBeNull();
			expect(store.isCurrent(version, healthy)).toBe(false);
			expect(store.drainPage(second.revision)).toStrictEqual({
				processed: 1,
				remaining: true
			});
			expect(complete(storage.sql, 'healthy')).toBe(0);
			expect(operationState(storage.sql, 'healthy')).toBe('failed');
			const third = begin(store, 'revoke');
			expect(third.revision).toBeGreaterThan(second.revision);
			store.acknowledge(third.revision);
			expect(store.snapshot(version).unresolved).toBe(true);
			expect(store.drainPage(third.revision).remaining).toBe(false);
			expect(store.getIntent(second.revision)?.cursorMaterialisationId).toBe(
				'healthy'
			);
			store.acknowledge(second.revision);
			expect(store.drainPage(second.revision)).toStrictEqual({
				processed: 0,
				remaining: false
			});
			expect(store.nextIntent()).toBeUndefined();
		});
	});

	it('starts a fresh reverse cursor on a repeated mutation after prior pages have advanced', async () => {
		await withStore('repeat-pages', (store, storage) => {
			seedFanIn(storage.sql, 130);
			const first = begin(store);
			store.acknowledge(first.revision);
			expect(store.drainPage(first.revision)).toStrictEqual({
				processed: 64,
				remaining: true
			});
			const healthy = store.snapshot(version);
			seedOperation(storage.sql, 'aaa-healthy');
			seedProof(storage.sql, 'aaa-healthy', healthy.revision);
			selectProof(storage.sql, 'aaa-healthy');
			const second = begin(store);
			expect(second.revision).toBeGreaterThan(first.revision);
			expect(second.cursorMaterialisationId).toBeNull();
			expect(store.drainPage(first.revision)).toStrictEqual({
				processed: 64,
				remaining: true
			});
			expect(complete(storage.sql, 'aaa-healthy')).toBe(1);
			expect(store.getIntent(first.revision)?.cursorMaterialisationId).toBe(
				'proof-000127'
			);
			expect(store.drainPage(second.revision)).toStrictEqual({
				processed: 64,
				remaining: true
			});
			expect(complete(storage.sql, 'aaa-healthy')).toBe(0);
			expect(store.getIntent(second.revision)?.cursorMaterialisationId).toBe(
				'proof-000062'
			);
			expect(store.drainPage(first.revision)).toStrictEqual({
				processed: 2,
				remaining: false
			});
			expect(store.snapshot(version).pathRevision).toBe(second.revision);
			store.acknowledge(second.revision);
			expect(store.drainPage(second.revision)).toStrictEqual({
				processed: 64,
				remaining: true
			});
			expect(store.drainPage(second.revision)).toStrictEqual({
				processed: 3,
				remaining: false
			});
			expect(store.nextIntent()).toBeUndefined();
		});
	});

	it('never rewinds the clock when its exact-integer range is exhausted', async () => {
		await withStore('exhaustion', (store, storage) => {
			storage.sql.exec(
				'UPDATE publication_manifest_availability_clock SET revision = 9007199254740991'
			);
			expect(() => begin(store)).toThrow();
			expect(store.snapshot(version)).toStrictEqual({
				revision: Number.MAX_SAFE_INTEGER,
				pathRevision: 0,
				lifecycleRevision: 0,
				unresolved: false
			});
			expect(store.nextIntent()).toBeUndefined();
		});
	});

	it('rejects revision-changing SQL REPLACE without corrupting immutable proofs or cardinality, with recursive triggers disabled', async () => {
		await withStore('replace', (_store, storage) => {
			const sql = storage.sql;
			sql.exec('PRAGMA recursive_triggers=OFF');
			seedOperation(sql, 'candidate');
			seedProof(sql, 'candidate', 1);
			const before = sql
				.exec('SELECT * FROM publication_manifest_cardinality')
				.toArray();
			const statement =
				"INSERT OR REPLACE INTO result_publication_member(cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation,availability_revision) VALUES (10,3,'candidate',7,'candidate',?,?,?,7,?)";
			sql.exec(
				statement,
				version.storePathHash,
				version.storePath,
				version.narHash,
				1
			);
			expect(() =>
				sql.exec(
					statement,
					version.storePathHash,
					version.storePath,
					version.narHash,
					2
				)
			).toThrow('publication manifest proof is immutable');
			expect(
				sql.exec('SELECT * FROM publication_manifest_cardinality').toArray()
			).toStrictEqual(before);
			expect(
				sql
					.exec('SELECT availability_revision FROM result_publication_member')
					.toArray()
			).toStrictEqual([{ availability_revision: 1 }]);
		});
	});

	it('uses a covering reverse seek and indexed per-edge proof lookups and rolls back a page atomically if invalidation fails', async () => {
		await withStore('atomic-page', (store, storage) => {
			seedProof(storage.sql, 'selected');
			selectProof(storage.sql, 'selected');
			const intent = begin(store);
			store.acknowledge(intent.revision);
			storage.sql.exec(
				"CREATE TRIGGER test_abort_invalidation BEFORE UPDATE OF complete ON result_publication BEGIN SELECT RAISE(ABORT,'test rollback'); END"
			);
			const message: unknown = expect.stringContaining('test rollback');
			const cause: unknown = expect.objectContaining({ message });
			const failure = expect.objectContaining({ cause }) as unknown;
			expect(() => store.drainPage(intent.revision)).toThrow(failure);
			expect(
				store.getIntent(intent.revision)?.cursorMaterialisationId
			).toBeNull();
			expect(complete(storage.sql, 'selected')).toBe(1);
			storage.sql.exec('DROP TRIGGER test_abort_invalidation');
			expect(store.drainPage(intent.revision)).toStrictEqual({
				processed: 1,
				remaining: false
			});
			const plan = Array.from(
				storage.sql.exec<{ detail: string }>(
					"EXPLAIN QUERY PLAN SELECT materialisation_id FROM result_publication_member INDEXED BY result_publication_member_reverse_idx WHERE cache_id=10 AND cache_generation=3 AND member_hash=? AND member_generation=7 AND member_path=? AND member_nar_hash=? AND materialisation_id > 'proof-000063' ORDER BY materialisation_id LIMIT 64",
					version.storePathHash,
					version.storePath,
					version.narHash
				),
				(row) => row.detail
			).join('\n');
			expect(plan).toContain(
				'USING COVERING INDEX result_publication_member_reverse_idx'
			);
			expect(plan).toContain('materialisation_id>?');
			expect(plan).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
			const proofPlan = Array.from(
				storage.sql.exec<{ detail: string }>(
					"EXPLAIN QUERY PLAN SELECT result_hash,result_generation,availability_revision FROM result_publication_member INDEXED BY result_publication_member_candidate_path_idx WHERE materialisation_id='selected' AND member_path=? LIMIT 1",
					version.storePath
				),
				(row) => row.detail
			).join('\n');
			expect(proofPlan).toContain(
				'USING INDEX result_publication_member_candidate_path_idx (materialisation_id=? AND member_path=?)'
			);
			expect(proofPlan).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
		});
	});

	it('cleans orphan versions in bounded pages, honours the row budget and leaves unresolved outcomes recoverable', async () => {
		await withStore('cleanup', (_store, storage) => {
			seedFanIn(storage.sql, 129);
			const meter = new DatabaseCostMeter();
			const database = drizzle(
				meteredStorage(storage, meter, [currentRowBudgetMeter]),
				{ schema }
			);
			const store = new PublicationManifestAvailabilityStore(database);
			const intent = begin(store);
			store.acknowledge(intent.revision);
			storage.sql.exec('DELETE FROM narinfo');
			expect(withRowBudget(() => store.drain(), 1)).toBe(true);
			expect(store.getIntent(intent.revision)?.cursorMaterialisationId).toBe(
				'proof-000063'
			);
			expect(withRowBudget(() => store.drain(), 1)).toBe(true);
			expect(store.getIntent(intent.revision)?.cursorMaterialisationId).toBe(
				'proof-000127'
			);
			expect(withRowBudget(() => store.drain(), 1)).toBe(true);
			const local = store.nextIntent(false);
			if (local === undefined) {
				throw new Error('Missing local deletion fence');
			}
			expect(local.kind).toBe('local');
			expect(withRowBudget(() => store.drain(), 1)).toBe(true);
			expect(store.getIntent(local.revision)?.cursorMaterialisationId).toBe(
				'proof-000063'
			);
			expect(withRowBudget(() => store.drain(), 1)).toBe(true);
			expect(store.getIntent(local.revision)?.cursorMaterialisationId).toBe(
				'proof-000127'
			);
			expect(withRowBudget(() => store.drain(), 1)).toBe(false);
			expect(store.nextIntent()).toBeUndefined();
			expect(
				storage.sql
					.exec('SELECT * FROM publication_manifest_availability_revision')
					.toArray()
			).toStrictEqual([]);
			expect(
				storage.sql
					.exec('SELECT revision FROM publication_manifest_availability_clock')
					.toArray()
			).toStrictEqual([{ revision: intent.revision + 1 }]);
		});
	});

	it('measures constant-size begin/snapshot/barrier and <=64-edge first/continuation pages at 128 and 100000 fan-in', async () => {
		const costs: Record<
			| 'warmSnapshot'
			| 'warmPending'
			| 'begin'
			| 'snapshot'
			| 'pending'
			| 'first'
			| 'second',
			{ read: number; written: number }
		>[] = [];
		for (const count of [128, 100_000]) {
			await withStore(`cost-${count.toString()}`, (_store, storage) => {
				seedFanIn(storage.sql, count);
				const meter = new DatabaseCostMeter();
				const store = new PublicationManifestAvailabilityStore(
					drizzle(meteredStorage(storage, meter), { schema })
				);
				const warmSnapshot = measure(meter, () => store.snapshot(version));
				const warmPending = measure(meter, () => store.hasPending(version));
				const started = measure(meter, () => begin(store));
				const snapshot = measure(meter, () => store.snapshot(version));
				const pending = measure(meter, () => store.hasPending(version));
				store.acknowledge(started.value.revision);
				const first = measure(meter, () =>
					store.drainPage(started.value.revision)
				);
				const second = measure(meter, () =>
					store.drainPage(started.value.revision)
				);
				expect(first.value).toStrictEqual({ processed: 64, remaining: true });
				expect(second.value).toStrictEqual({ processed: 64, remaining: true });
				expect(
					store.getIntent(started.value.revision)?.cursorMaterialisationId
				).toBe('proof-000127');
				expect(complete(storage.sql, 'owner-000000')).toBe(0);
				expect(complete(storage.sql, 'owner-000127')).toBe(0);
				if (count > 128) {
					expect(complete(storage.sql, 'owner-000128')).toBe(1);
				}
				const cost = {
					warmSnapshot: {
						read: warmSnapshot.read,
						written: warmSnapshot.written
					},
					warmPending: { read: warmPending.read, written: warmPending.written },
					begin: { read: started.read, written: started.written },
					snapshot: { read: snapshot.read, written: snapshot.written },
					pending: { read: pending.read, written: pending.written },
					first: { read: first.read, written: first.written },
					second: { read: second.read, written: second.written }
				};
				expect(first.read + first.written).toBeLessThan(2500);
				expect(second.read + second.written).toBeLessThan(2500);
				costs.push(cost);
			});
		}
		expect(costs[1]).toStrictEqual(costs[0]);
		expect(costs[0]).toStrictEqual({
			warmSnapshot: { read: 1, written: 0 },
			warmPending: { read: 0, written: 0 },
			begin: { read: 6, written: 6 },
			snapshot: { read: 3, written: 0 },
			pending: { read: 1, written: 0 },
			first: { read: 450, written: 321 },
			second: { read: 450, written: 321 }
		});
	});
});
