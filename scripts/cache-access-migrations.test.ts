import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

interface TenantSpec {
	readonly id?: string;
	readonly status?: 'active' | 'suspended' | 'offboarding' | 'offboarded';
	readonly readMode?: 'public' | 'private';
	readonly catalogueVersion?: number;
}

function insertTenant(database: DatabaseSync, spec: TenantSpec = {}): void {
	database
		.prepare(
			`
				INSERT INTO tenant (
					id, status, read_mode, owner_issuer, owner_subject,
					owner_audience, config_version, cache_catalogue_version, created_at
				) VALUES (
					?, ?, ?, 'issuer', 'subject', 'audience', 1,
					CASE WHEN ? THEN ? ELSE NULL END, ?
				)
			`
		)
		.run(
			spec.id ?? 'alice',
			spec.status ?? 'active',
			spec.readMode ?? 'public',
			spec.catalogueVersion === undefined ? 0 : 1,
			spec.catalogueVersion ?? 0,
			'2026-01-01T00:00:00.000Z'
		);
}

function prepareContractDatabase(database: DatabaseSync): void {
	applyMigrations(database, '0021_cache_access_legacy_write_mirror.sql');
	insertTenant(database);
	applyMigration(database, '0022_cache_access_backfill.sql');
}

function markCatalogueComplete(database: DatabaseSync, tenant = 'alice'): void {
	database
		.prepare('UPDATE tenant SET cache_catalogue_version = 1 WHERE id = ?')
		.run(tenant);
}

function applyCompatibleContract(database: DatabaseSync): void {
	applyMigration(database, '0023_cache_access_contract_assertions.sql');
	applyMigration(database, '0024_cache_access_compatible_contract.sql');
}

describe('cache access expansion', () => {
	let database: DatabaseSync;

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		applyMigrations(database, '0021_cache_access_legacy_write_mirror.sql');
		insertTenant(database);
	});

	afterEach(() => {
		database.close();
	});

	it('mirrors legacy writes into native cache identities', () => {
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

	it('mirrors a tenant read-mode change to ordinary cache lifecycles', () => {
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
		applyMigrations(database, '0021_cache_access_legacy_write_mirror.sql');
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

		applyMigration(database, '0022_cache_access_backfill.sql');

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

	it('mirrors tenants created after the backfill', () => {
		applyMigration(database, '0022_cache_access_backfill.sql');

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
			applyMigration(database, '0022_cache_access_backfill.sql');
		}).toThrow(/CHECK constraint failed/u);
	});

	it('rejects public and private aliases of one native cache', () => {
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
			applyMigration(database, '0022_cache_access_backfill.sql');
		}).toThrow(/CHECK constraint failed/u);
	});
});

describe('cache access compatible contract', () => {
	let database: DatabaseSync;

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		prepareContractDatabase(database);
	});

	afterEach(() => {
		database.close();
	});

	it.each(['active', 'suspended'] as const)(
		'refuses a %s tenant whose catalogue sweep has not completed',
		(status) => {
			database
				.prepare('UPDATE tenant SET status = ? WHERE id = ?')
				.run(status, 'alice');

			expect(() => {
				applyMigration(database, '0023_cache_access_contract_assertions.sql');
			}).toThrow(/CHECK constraint failed/u);
		}
	);

	it.each(['active', 'suspended'] as const)(
		'refuses a %s tenant without one live default cache',
		(status) => {
			database
				.prepare('UPDATE tenant SET status = ? WHERE id = ?')
				.run(status, 'alice');
			markCatalogueComplete(database);
			database
				.prepare(
					`DELETE FROM cache_lifecycle
					 WHERE tenant = 'alice' AND cache_kind = 'default'`
				)
				.run();

			expect(() => {
				applyMigration(database, '0023_cache_access_contract_assertions.sql');
			}).toThrow(/CHECK constraint failed/u);
		}
	);

	it('accepts swept active and suspended tenants and ignores draining tenants', () => {
		markCatalogueComplete(database);
		insertTenant(database, {
			id: 'bob',
			status: 'suspended',
			readMode: 'private',
			catalogueVersion: 1
		});
		insertTenant(database, { id: 'carol', status: 'offboarding' });

		expect(() => {
			applyMigration(database, '0023_cache_access_contract_assertions.sql');
		}).not.toThrow();
	});

	it('copies representative default, public, and private rows', () => {
		database
			.prepare(
				`
					INSERT INTO blob_ref (
						tenant, cache, store_path_hash, generation, nar_hash,
						cache_generation
					) VALUES
						('alice', '', 'default-path', 1, 'sha256:default', 1),
						('alice', 'guides', 'public-path', 2, 'sha256:public', 3),
						('alice', 'private/builds', 'private-path', 4, 'sha256:private', 5)
				`
			)
			.run();
		database
			.prepare(
				`
					INSERT INTO attestation_ref (
						tenant, cache, store_path_hash, generation, predicate_type, digest
					) VALUES (
						'alice', 'private/builds', 'private-path', 4,
						'https://example.test/predicate', 'digest'
					)
				`
			)
			.run();
		database
			.prepare(
				`
					INSERT INTO cache_lifecycle (
						tenant, cache, generation, deleted_at, updated_at
					) VALUES
						('alice', 'guides', 3, NULL, '2026-01-02T00:00:00.000Z'),
						('alice', 'private/builds', 5, NULL, '2026-01-03T00:00:00.000Z')
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
		markCatalogueComplete(database);

		applyCompatibleContract(database);

		expect({
			blobs: database
				.prepare(
					`SELECT cache_kind, cache_name, store_path_hash, generation,
						nar_hash, cache_generation
					 FROM blob_ref ORDER BY store_path_hash`
				)
				.all()
				.map((row) => ({ ...row, cache_name: row.cache_name ?? undefined })),
			attestations: database
				.prepare(
					`SELECT cache_kind, cache_name, store_path_hash, generation,
						predicate_type, digest
					 FROM attestation_ref`
				)
				.all()
				.map((row) => ({ ...row })),
			lifecycles: database
				.prepare(
					`SELECT cache_kind, cache_name, access, generation
					 FROM cache_lifecycle ORDER BY cache_name`
				)
				.all()
				.map((row) => ({ ...row, cache_name: row.cache_name ?? undefined })),
			credentials: database
				.prepare(
					`SELECT cache_kind, cache_name, read_user
					 FROM tenant_cache_read_credential`
				)
				.all()
				.map((row) => ({ ...row }))
		}).toStrictEqual({
			blobs: [
				{
					cache_kind: 'default',
					cache_name: undefined,
					store_path_hash: 'default-path',
					generation: 1,
					nar_hash: 'sha256:default',
					cache_generation: 1
				},
				{
					cache_kind: 'named',
					cache_name: 'builds',
					store_path_hash: 'private-path',
					generation: 4,
					nar_hash: 'sha256:private',
					cache_generation: 5
				},
				{
					cache_kind: 'named',
					cache_name: 'guides',
					store_path_hash: 'public-path',
					generation: 2,
					nar_hash: 'sha256:public',
					cache_generation: 3
				}
			],
			attestations: [
				{
					cache_kind: 'named',
					cache_name: 'builds',
					store_path_hash: 'private-path',
					generation: 4,
					predicate_type: 'https://example.test/predicate',
					digest: 'digest'
				}
			],
			lifecycles: [
				{
					cache_kind: 'default',
					cache_name: undefined,
					access: 'public',
					generation: 1
				},
				{
					cache_kind: 'named',
					cache_name: 'builds',
					access: 'private',
					generation: 5
				},
				{
					cache_kind: 'named',
					cache_name: 'guides',
					access: 'public',
					generation: 3
				}
			],
			credentials: [
				{ cache_kind: 'named', cache_name: 'builds', read_user: 'reader' }
			]
		});
	});

	it.each([
		{
			name: 'an invalid access value',
			table: 'cache_lifecycle',
			insert: `
				INSERT INTO cache_lifecycle (
					tenant, cache, cache_kind, cache_name, access,
					generation, deleted_at, updated_at
				) VALUES (
					'alice', 'broken-access', 'named', 'broken-access', 'internal',
					1, NULL, '2026-01-01T00:00:00.000Z'
				)
			`
		},
		{
			name: 'a default cache with a name',
			table: 'blob_ref',
			insert: `
				INSERT INTO blob_ref (
					tenant, cache, cache_kind, cache_name, store_path_hash,
					generation, nar_hash, cache_generation
				) VALUES (
					'alice', 'bad-default', 'default', 'bad-default', 'path',
					1, 'sha256:nar', 1
				)
			`
		},
		{
			name: 'an invalid named-cache name',
			table: 'attestation_ref',
			insert: `
				INSERT INTO attestation_ref (
					tenant, cache, cache_kind, cache_name, store_path_hash,
					generation, predicate_type, digest
				) VALUES (
					'alice', 'Bad Name', 'named', 'Bad Name', 'path', 1,
					'https://example.test/predicate', 'digest'
				)
			`
		}
	] as const)('rejects $name in $table', ({ insert }) => {
		markCatalogueComplete(database);
		applyCompatibleContract(database);

		expect(() => {
			database.prepare(insert).run();
		}).toThrow(/CHECK constraint failed/u);
	});

	it('enforces native cache identity uniqueness', () => {
		markCatalogueComplete(database);
		applyCompatibleContract(database);
		const insert = database.prepare(
			`
				INSERT INTO blob_ref (
					tenant, cache, cache_kind, cache_name, store_path_hash,
					generation, nar_hash, cache_generation
				) VALUES (?, ?, 'named', 'builds', 'path', 1, 'sha256:nar', 1)
			`
		);
		insert.run('alice', 'builds');

		expect(() => {
			insert.run('alice', 'private/builds');
		}).toThrow(/UNIQUE constraint failed/u);
	});

	it('keeps the previous bridge release compatible with the contract', () => {
		markCatalogueComplete(database);
		applyCompatibleContract(database);

		database
			.prepare(
				`
					INSERT INTO blob_ref (
						tenant, cache, cache_kind, cache_name, store_path_hash,
						generation, nar_hash, cache_generation
					) VALUES (
						'alice', 'private/builds', 'named', 'builds', 'path', 1,
						'sha256:nar', 1
					)
				`
			)
			.run();

		const row = database
			.prepare(
				`SELECT cache, cache_kind, cache_name FROM blob_ref
				 WHERE tenant = 'alice' AND store_path_hash = 'path'`
			)
			.get();

		expect({ ...row }).toStrictEqual({
			cache: 'private/builds',
			cache_kind: 'named',
			cache_name: 'builds'
		});
	});

	it('keeps the previous cache-credential conflict target', () => {
		markCatalogueComplete(database);
		applyCompatibleContract(database);
		const upsert = database.prepare(
			`
				INSERT INTO tenant_cache_read_credential (
					tenant, cache, cache_kind, cache_name, read_user,
					read_password_hash, read_password_salt, created_at
				) VALUES (
					'alice', 'private/builds', 'named', 'builds', ?, 'hash',
					'salt', '2026-01-01T00:00:00.000Z'
				)
				ON CONFLICT (tenant, cache) DO UPDATE SET read_user = excluded.read_user
			`
		);

		upsert.run('first');
		upsert.run('second');

		const row = database
			.prepare(
				`SELECT cache, cache_kind, cache_name, read_user
				 FROM tenant_cache_read_credential WHERE tenant = 'alice'`
			)
			.get();

		expect({ ...row }).toStrictEqual({
			cache: 'private/builds',
			cache_kind: 'named',
			cache_name: 'builds',
			read_user: 'second'
		});
	});

	it('uses the native tenant and NAR-hash index for read authority', () => {
		markCatalogueComplete(database);
		applyCompatibleContract(database);

		const plan = database
			.prepare(
				`EXPLAIN QUERY PLAN
				 SELECT 1 FROM blob_ref
				 WHERE tenant = ? AND nar_hash = ?
					AND cache_kind = ? AND cache_name = ?
					AND cache_generation = ?`
			)
			.all('alice', 'sha256:nar', 'named', 'builds', 1)
			.map((row) => String(row.detail));

		expect(
			plan.some((detail) =>
				detail.includes('blob_ref_tenant_nar_hash_native_idx')
			)
		).toBe(true);
	});

	it('retires tenant read mode without contracting compatibility storage', () => {
		markCatalogueComplete(database);
		applyCompatibleContract(database);
		database
			.prepare(
				`INSERT INTO blob_ref (
					tenant, cache, cache_kind, cache_name, store_path_hash,
					generation, nar_hash, cache_generation
				) VALUES (
					'alice', 'guides', 'named', 'guides', 'path', 1,
					'sha256:nar', 1
				)`
			)
			.run();

		applyMigration(database, '0025_retire_tenant_read_mode.sql');
		database
			.prepare(
				`INSERT INTO tenant (
					id, status, owner_issuer, owner_subject, owner_audience,
					config_version, created_at
				) VALUES (
					'bob', 'active', 'issuer', 'subject', 'audience', 1,
					'2026-01-02T00:00:00.000Z'
				)`
			)
			.run();

		const compatibilityTables = [
			'attestation_ref',
			'blob_ref',
			'cache_lifecycle',
			'tenant_cache_read_credential'
		];
		const legacyKeys = compatibilityTables.map((table) => {
			const columns = database
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.map((row) => ({ name: String(row.name), pk: Number(row.pk) }));

			return {
				table,
				hasCacheColumn: columns.some((column) => column.name === 'cache'),
				primaryKey: columns
					.filter((column) => column.pk > 0)
					.toSorted((left, right) => left.pk - right.pk)
					.map((column) => column.name)
			};
		});

		expect({
			tenants: database
				.prepare(
					`SELECT id, read_mode, cache_catalogue_version
					 FROM tenant ORDER BY id`
				)
				.all()
				.map((row) => ({
					...row,
					read_mode: row.read_mode ?? undefined,
					cache_catalogue_version: row.cache_catalogue_version ?? undefined
				})),
			blob: {
				...database
					.prepare(
						`SELECT cache, cache_kind, cache_name, store_path_hash
						 FROM blob_ref WHERE tenant = 'alice'`
					)
					.get()
			},
			legacyKeys
		}).toStrictEqual({
			tenants: [
				{ id: 'alice', read_mode: 'public', cache_catalogue_version: 1 },
				{
					id: 'bob',
					read_mode: undefined,
					cache_catalogue_version: undefined
				}
			],
			blob: {
				cache: 'guides',
				cache_kind: 'named',
				cache_name: 'guides',
				store_path_hash: 'path'
			},
			legacyKeys: [
				{
					table: 'attestation_ref',
					hasCacheColumn: true,
					primaryKey: [
						'tenant',
						'cache',
						'store_path_hash',
						'generation',
						'predicate_type',
						'digest'
					]
				},
				{
					table: 'blob_ref',
					hasCacheColumn: true,
					primaryKey: ['tenant', 'cache', 'store_path_hash', 'generation']
				},
				{
					table: 'cache_lifecycle',
					hasCacheColumn: true,
					primaryKey: ['tenant', 'cache']
				},
				{
					table: 'tenant_cache_read_credential',
					hasCacheColumn: true,
					primaryKey: ['tenant', 'cache']
				}
			]
		});
	});
});
