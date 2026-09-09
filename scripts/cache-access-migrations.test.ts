import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

function migrationStatements(file: string): string[] {
	const migrationsDirectory = path.resolve(
		import.meta.dirname,
		'..',
		'packages',
		'server',
		'drizzle-d1'
	);

	return readFileSync(path.join(migrationsDirectory, file), 'utf8')
		.split('--> statement-breakpoint')
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

function applyMigration(database: DatabaseSync, file: string): void {
	for (const statement of migrationStatements(file)) {
		database.exec(statement);
	}
}

function applyMigrations(database: DatabaseSync, through: string): void {
	const migrationsDirectory = path.resolve(
		import.meta.dirname,
		'..',
		'packages',
		'server',
		'drizzle-d1'
	);
	const files = readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file <= through)
		.toSorted((left, right) => left.localeCompare(right));

	for (const file of files) {
		applyMigration(database, file);
	}
}

const edgeCountSchema = z.strictObject({ edges: z.number().int() });

function insertTenant(database: DatabaseSync): void {
	database
		.prepare(
			`
				INSERT INTO tenant (
					id, status, read_mode, owner_issuer, owner_subject,
					owner_audience, config_version, created_at
				) VALUES (?, 'active', 'public', 'issuer', 'subject', 'audience', 1, ?)
			`
		)
		.run('alice', '2026-01-01T00:00:00.000Z');
}

describe('cache access expansion', () => {
	let database: DatabaseSync;

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		applyMigrations(database, '0023_cache_access_legacy_write_mirror.sql');
		insertTenant(database);
	});

	afterEach(() => {
		database.close();
	});

	it('mirrors legacy writes into the expanded cache columns', () => {
		database
			.prepare(
				`
				INSERT INTO blob_ref (
					tenant, cache, store_path_hash, generation, nar_hash, cache_generation
				) VALUES ('alice', '', 'default-path', 0, 'sha256:default', 1)
			`
			)
			.run();
		database
			.prepare(
				`
				INSERT INTO attestation_ref (
					tenant, cache, store_path_hash, generation, predicate_type, digest
				) VALUES ('alice', 'private/builds', 'named-path', 0, 'https://example.test/predicate', 'digest')
			`
			)
			.run();
		database
			.prepare(
				`
				INSERT INTO cache_lifecycle (
					tenant, cache, generation, deleted_at, updated_at
				) VALUES
					('alice', 'guides', 1, NULL, '2026-01-01T00:00:00.000Z'),
					('alice', 'private/builds', 1, NULL, '2026-01-01T00:00:00.000Z')
			`
			)
			.run();
		database
			.prepare(
				`
				INSERT INTO tenant_cache_read_credential (
					tenant, cache, read_user, read_password_hash,
					read_password_salt, created_at
				) VALUES (
					'alice', 'private/builds', 'reader', 'hash', 'salt',
					'2026-01-01T00:00:00.000Z'
				)
			`
			)
			.run();

		expect({
			blobs: database
				.prepare(
					'SELECT cache_kind, cache_name FROM blob_ref ORDER BY store_path_hash'
				)
				.all()
				.map((row) => ({
					...row,
					cache_name: row.cache_name ?? undefined
				})),
			attestations: database
				.prepare(
					'SELECT cache_kind, cache_name FROM attestation_ref ORDER BY store_path_hash'
				)
				.all()
				.map((row) => ({
					...row,
					cache_name: row.cache_name ?? undefined
				})),
			lifecycles: database
				.prepare(
					'SELECT cache_kind, cache_name, access FROM cache_lifecycle ORDER BY cache'
				)
				.all()
				.map((row) => ({
					...row,
					cache_name: row.cache_name ?? undefined
				})),
			credentials: database
				.prepare(
					'SELECT cache_kind, cache_name FROM tenant_cache_read_credential'
				)
				.all()
				.map((row) => ({
					...row,
					cache_name: row.cache_name ?? undefined
				}))
		}).toStrictEqual({
			blobs: [{ cache_kind: 'default', cache_name: undefined }],
			attestations: [{ cache_kind: 'named', cache_name: 'builds' }],
			lifecycles: [
				{ cache_kind: 'named', cache_name: 'guides', access: 'public' },
				{ cache_kind: 'named', cache_name: 'builds', access: 'private' }
			],
			credentials: [{ cache_kind: 'named', cache_name: 'builds' }]
		});
	});

	it("mirrors a change to the tenant's read_mode into the access of its unprefixed caches", () => {
		database
			.prepare(
				`
				INSERT INTO cache_lifecycle (
					tenant, cache, generation, deleted_at, updated_at
				) VALUES
					('alice', '', 1, NULL, '2026-01-01T00:00:00.000Z'),
					('alice', 'guides', 1, NULL, '2026-01-01T00:00:00.000Z'),
					('alice', 'private/builds', 1, NULL, '2026-01-01T00:00:00.000Z')
			`
			)
			.run();

		database
			.prepare("UPDATE tenant SET read_mode = 'private' WHERE id = 'alice'")
			.run();

		expect(
			database
				.prepare('SELECT cache, access FROM cache_lifecycle ORDER BY cache')
				.all()
				.map((row) => ({ ...row }))
		).toStrictEqual([
			{ cache: '', access: 'private' },
			{ cache: 'guides', access: 'private' },
			{ cache: 'private/builds', access: 'private' }
		]);
	});
});

describe('cache access backfill', () => {
	let database: DatabaseSync;

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		applyMigrations(database, '0023_cache_access_legacy_write_mirror.sql');
		insertTenant(database);
	});

	afterEach(() => {
		database.close();
	});

	it('preserves writes made after expansion', () => {
		database
			.prepare(
				`
				INSERT INTO blob_ref (
					tenant, cache, store_path_hash, generation, nar_hash, cache_generation
				) VALUES ('alice', 'private/builds', 'path', 3, 'sha256:nar', 2)
			`
			)
			.run();

		applyMigration(database, '0024_cache_access_backfill.sql');

		expect(
			database
				.prepare(
					`
					SELECT cache, cache_kind, cache_name, store_path_hash,
						generation, nar_hash, cache_generation
					FROM blob_ref
					`
				)
				.all()
				.map((row) => ({ ...row }))
		).toStrictEqual([
			{
				cache: 'private/builds',
				cache_kind: 'named',
				cache_name: 'builds',
				store_path_hash: 'path',
				generation: 3,
				nar_hash: 'sha256:nar',
				cache_generation: 2
			}
		]);
	});

	it('creates a default cache lifecycle row for a tenant inserted after the backfill', () => {
		applyMigration(database, '0024_cache_access_backfill.sql');

		database
			.prepare(
				`
					INSERT INTO tenant (
						id, status, read_mode, owner_issuer, owner_subject,
						owner_audience, config_version, created_at
					) VALUES (
						'bob', 'active', 'private', 'issuer', 'subject',
						'audience', 1, '2026-01-02T00:00:00.000Z'
					)
				`
			)
			.run();

		expect(
			database
				.prepare(
					`
						SELECT tenant, cache, cache_kind, cache_name, access,
							generation, deleted_at, updated_at
						FROM cache_lifecycle
						WHERE tenant = 'bob'
					`
				)
				.all()
				.map((row) => ({
					...row,
					cache_name: row.cache_name ?? undefined,
					deleted_at: row.deleted_at ?? undefined
				}))
		).toStrictEqual([
			{
				tenant: 'bob',
				cache: '',
				cache_kind: 'default',
				cache_name: undefined,
				access: 'private',
				generation: 1,
				deleted_at: undefined,
				updated_at: '2026-01-02T00:00:00.000Z'
			}
		]);
	});

	it('creates every lifecycle referenced by an offboarding tenant', () => {
		database
			.prepare(
				`
					INSERT INTO tenant (
						id, status, read_mode, owner_issuer, owner_subject,
						owner_audience, config_version, created_at
					) VALUES (
						'bob', 'offboarding', 'public', 'issuer', 'subject',
						'audience', 1, '2026-01-02T00:00:00.000Z'
					)
				`
			)
			.run();
		database
			.prepare(
				`
					INSERT INTO blob_ref (
						tenant, cache, store_path_hash, generation, nar_hash,
						cache_generation
					) VALUES ('bob', 'builds', 'path', 4, 'sha256:nar', 3)
				`
			)
			.run();

		applyMigration(database, '0024_cache_access_backfill.sql');

		expect(
			database
				.prepare(
					`
						SELECT cache, cache_kind, cache_name, access, generation
						FROM cache_lifecycle
						WHERE tenant = 'bob'
						ORDER BY cache
					`
				)
				.all()
				.map((row) => ({
					...row,
					cache_name: row.cache_name ?? undefined
				}))
		).toStrictEqual([
			{
				cache: '',
				cache_kind: 'default',
				cache_name: undefined,
				access: 'public',
				generation: 1
			},
			{
				cache: 'builds',
				cache_kind: 'named',
				cache_name: 'builds',
				access: 'public',
				generation: 3
			}
		]);
	});

	it('rejects retained references for an offboarded tenant', () => {
		database
			.prepare(
				`
					INSERT INTO tenant (
						id, status, read_mode, owner_issuer, owner_subject,
						owner_audience, config_version, created_at
					) VALUES (
						'bob', 'offboarded', 'private', 'issuer', 'subject',
						'audience', 1, '2026-01-02T00:00:00.000Z'
					)
				`
			)
			.run();
		database
			.prepare(
				`
					INSERT INTO blob_ref (
						tenant, cache, store_path_hash, generation, nar_hash,
						cache_generation
					) VALUES ('bob', 'builds', 'path', 1, 'sha256:nar', 1)
				`
			)
			.run();

		expect(() => {
			applyMigration(database, '0024_cache_access_backfill.sql');
		}).toThrow(/CHECK constraint failed/u);
	});

	it('rejects malformed legacy credential keys', () => {
		database
			.prepare(
				`
				INSERT INTO tenant_cache_read_credential (
					tenant, cache, read_user, read_password_hash,
					read_password_salt, created_at
				) VALUES (
					'alice', 'builds', 'reader', 'hash', 'salt',
					'2026-01-01T00:00:00.000Z'
				)
				`
			)
			.run();

		expect(() => {
			applyMigration(database, '0024_cache_access_backfill.sql');
		}).toThrow(/CHECK constraint failed/u);
	});

	it('rejects one cache name stored both public and private', () => {
		database
			.prepare(
				`
				INSERT INTO blob_ref (
					tenant, cache, store_path_hash, generation, nar_hash, cache_generation
				) VALUES ('alice', 'builds', 'path', 1, 'sha256:nar', 1)
				`
			)
			.run();
		database
			.prepare(
				`
				INSERT INTO tenant_cache_read_credential (
					tenant, cache, read_user, read_password_hash,
					read_password_salt, created_at
				) VALUES (
					'alice', 'private/builds', 'reader', 'hash', 'salt',
					'2026-01-01T00:00:00.000Z'
				)
				`
			)
			.run();

		expect(() => {
			applyMigration(database, '0024_cache_access_backfill.sql');
		}).toThrow(/CHECK constraint failed/u);
	});
});

describe('cache identity contraction', () => {
	let database: DatabaseSync;

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		applyMigrations(database, '0026_cache_incarnation_expand.sql');
		insertTenant(database);
	});

	afterEach(() => {
		database.close();
	});

	// The insert trigger gives each of these its default cache's lifecycle row,
	// which is what the contraction requires of a tenant that is not offboarded.
	function insertTenantWithStatus(
		id: string,
		status: 'active' | 'suspended' | 'offboarding' | 'offboarded'
	): void {
		database
			.prepare(
				`
					INSERT INTO tenant (
						id, status, read_mode, owner_issuer, owner_subject,
						owner_audience, config_version, created_at
					) VALUES (
						?, ?, 'public', 'issuer', 'subject', 'audience', 1,
						'2026-01-02T00:00:00.000Z'
					)
				`
			)
			.run(id, status);
	}

	function contract(): void {
		applyMigration(database, '0027_cache_identity_contract_assertions.sql');
		applyMigration(database, '0028_cache_identity_compatible_contract.sql');
		applyMigration(database, '0029_cache_identity_contract.sql');
	}

	it('contracts a named cache an offboarding tenant still references', () => {
		insertTenantWithStatus('bob', 'offboarding');
		database
			.prepare(
				`
					INSERT INTO cache_lifecycle (
						tenant, cache, cache_kind, cache_name, access, generation,
						updated_at
					) VALUES (
						'bob', 'builds', 'named', 'builds', 'public', 3,
						'2026-01-02T00:00:00.000Z'
					)
				`
			)
			.run();
		database
			.prepare(
				`
					INSERT INTO blob_ref (
						tenant, cache, cache_kind, cache_name, store_path_hash,
						generation, nar_hash, cache_generation
					) VALUES (
						'bob', 'builds', 'named', 'builds', 'path', 4, 'sha256:nar', 3
					)
				`
			)
			.run();

		contract();

		expect(
			database
				.prepare(
					`
						SELECT cache_kind, cache_name, store_path_hash, generation,
							cache_generation
						FROM blob_ref
						WHERE tenant = 'bob'
					`
				)
				.all()
				.map((row) => ({ ...row }))
		).toStrictEqual([
			{
				cache_kind: 'named',
				cache_name: 'builds',
				store_path_hash: 'path',
				generation: 4,
				cache_generation: 3
			}
		]);
	});

	// An offboarded tenant's rows are scrubbed and its object is never woken
	// again, so it neither holds a default cache nor needs one.
	it('contracts around an offboarded tenant with no cache rows', () => {
		insertTenantWithStatus('bob', 'offboarded');
		database.prepare("DELETE FROM cache_lifecycle WHERE tenant = 'bob'").run();

		contract();

		expect({
			...database
				.prepare(
					"SELECT count(*) AS tenants FROM tenant WHERE status = 'offboarded'"
				)
				.get()
		}).toStrictEqual({ tenants: 1 });
	});

	// `blob_ref` keeps its old primary key through the compatible contract, but
	// this build writes a null `cache` and SQLite treats nulls in a key as
	// distinct, so that key deduplicates nothing. An edge written twice is caught
	// by the identity index alone, both before and after the key is dropped.
	it.each([
		{
			name: 'a default cache',
			identity: "'default', NULL",
			index: 'blob_ref_default_identity_idx'
		},
		{
			name: 'a named cache',
			identity: "'named', 'builds'",
			index: 'blob_ref_named_identity_idx'
		}
	])(
		'deduplicates a repeated edge for $name by $index alone',
		({ identity, index }) => {
			const edges = (): number => {
				const row = database
					.prepare(
						"SELECT count(*) AS edges FROM blob_ref WHERE tenant = 'alice'"
					)
					.get();

				return edgeCountSchema.parse(row).edges;
			};
			const writeEdge = (columns: string, values: string): void => {
				database
					.prepare(
						`INSERT INTO blob_ref (tenant, ${columns}) VALUES ('alice', ${values}) ON CONFLICT DO NOTHING`
					)
					.run();
			};
			// Name the index that carries the uniqueness, so that removing it
			// leads here rather than to a silently duplicated edge.
			const hasIndex = (): boolean =>
				database
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?"
					)
					.all(index).length === 1;

			applyMigration(database, '0027_cache_identity_contract_assertions.sql');
			applyMigration(database, '0028_cache_identity_compatible_contract.sql');

			// What this build writes while the legacy column is still there.
			const compatibleEdge = (): void => {
				writeEdge(
					'cache, cache_kind, cache_name, store_path_hash, generation, nar_hash, cache_generation',
					`NULL, ${identity}, 'path', 4, 'sha256:nar', 1`
				);
			};

			compatibleEdge();
			compatibleEdge();

			const beforeContraction = { indexed: hasIndex(), edges: edges() };

			applyMigration(database, '0029_cache_identity_contract.sql');
			writeEdge(
				'cache_kind, cache_name, store_path_hash, generation, nar_hash, cache_generation',
				`${identity}, 'path', 4, 'sha256:nar', 1`
			);

			expect({
				beforeContraction,
				afterContraction: { indexed: hasIndex(), edges: edges() }
			}).toStrictEqual({
				beforeContraction: { indexed: true, edges: 1 },
				afterContraction: { indexed: true, edges: 1 }
			});
		}
	);

	// The conversion each object performs before the contraction reads the access
	// recorded for its tenant's default cache, so a tenant without that row could
	// not convert and its object could not migrate.
	it('refuses to contract while a live tenant has no default cache', () => {
		insertTenantWithStatus('bob', 'active');
		database
			.prepare(
				"DELETE FROM cache_lifecycle WHERE tenant = 'bob' AND cache_kind = 'default'"
			)
			.run();

		expect(() => {
			contract();
		}).toThrow(/CHECK constraint failed/u);
	});
});

// Deleting a cache used to leave the cache's read credential in place, so the
// credential could open the next cache registered under the same name. The
// migration removes the rows those deletions left behind.
describe('cache credential lifecycle', () => {
	let database: DatabaseSync;

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		applyMigrations(database, '0029_cache_identity_contract.sql');
	});

	afterEach(() => {
		database.close();
	});

	function insertLifecycle(name: string, generation: number): void {
		database
			.prepare(
				`
					INSERT INTO cache_lifecycle (
						tenant, cache_kind, cache_name, access, generation, deleted_at,
						updated_at
					) VALUES (
						'alice', 'named', ?, 'private', ?, NULL, '2026-01-02T00:00:00.000Z'
					)
				`
			)
			.run(name, generation);
	}

	function markDeleted(name: string): void {
		database
			.prepare(
				`
					UPDATE cache_lifecycle
					SET deleted_at = '2026-01-03T00:00:00.000Z'
					WHERE tenant = 'alice' AND cache_kind = 'named' AND cache_name = ?
				`
			)
			.run(name);
	}

	function insertCredential(name: string): void {
		database
			.prepare(
				`
					INSERT INTO tenant_cache_read_credential (
						tenant, cache_kind, cache_name, read_user, read_password_hash,
						read_password_salt, created_at
					) VALUES (
						'alice', 'named', ?, 'reader', 'hash', 'salt',
						'2026-01-02T00:00:00.000Z'
					)
				`
			)
			.run(name);
	}

	// `guides` was deleted and registered again: registration cleared the
	// deletion timestamp and kept the generation the deletion set, and no column
	// records whether the credential belongs to the earlier cache or to the
	// current one, so the migration keeps it. `notes` has never been deleted.
	// `unregistered` has no lifecycle row: the tenant Durable Object has not
	// registered that cache.
	it('removes the credential of a deleted cache and keeps the others', () => {
		insertLifecycle('builds', 2);
		markDeleted('builds');
		insertLifecycle('guides', 2);
		insertLifecycle('notes', 1);
		insertCredential('builds');
		insertCredential('guides');
		insertCredential('notes');
		insertCredential('unregistered');

		applyMigration(database, '0030_cache_credential_lifecycle.sql');

		expect(
			database
				.prepare(
					'SELECT cache_name FROM tenant_cache_read_credential ORDER BY cache_name'
				)
				.all()
				.map((row) => ({ ...row }))
		).toStrictEqual([
			{ cache_name: 'guides' },
			{ cache_name: 'notes' },
			{ cache_name: 'unregistered' }
		]);
	});
});
