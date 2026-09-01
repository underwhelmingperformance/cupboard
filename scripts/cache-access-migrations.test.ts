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
	applyMigrations(database, '0022_cache_access_legacy_write_mirror.sql');
	insertTenant(database);
	applyMigration(database, '0023_cache_access_backfill.sql');
}

function markCatalogueComplete(database: DatabaseSync, tenant = 'alice'): void {
	database
		.prepare('UPDATE tenant SET cache_catalogue_version = 1 WHERE id = ?')
		.run(tenant);
}

function applyCompatibleContract(database: DatabaseSync): void {
	applyMigration(database, '0024_cache_access_contract_assertions.sql');
	applyMigration(database, '0025_cache_access_compatible_contract.sql');
}

function applyNativeContract(database: DatabaseSync): void {
	applyCompatibleContract(database);
	applyMigration(database, '0026_cache_incarnation_expand.sql');
	applyMigration(database, '0027_cache_generation_contract_assertions.sql');
	applyMigration(database, '0028_drop_cache_credential_lifecycle_guard.sql');
	applyMigration(database, '0029_cache_identity_contract.sql');
	applyMigration(database, '0030_cache_credential_lifecycle_guard.sql');
}

describe('cache access expansion', () => {
	let database: DatabaseSync;

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		applyMigrations(database, '0022_cache_access_legacy_write_mirror.sql');
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
		applyMigrations(database, '0022_cache_access_legacy_write_mirror.sql');
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

		applyMigration(database, '0023_cache_access_backfill.sql');

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
		applyMigration(database, '0023_cache_access_backfill.sql');

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

		applyMigration(database, '0023_cache_access_backfill.sql');

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
			applyMigration(database, '0023_cache_access_backfill.sql');
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
			applyMigration(database, '0023_cache_access_backfill.sql');
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
			applyMigration(database, '0023_cache_access_backfill.sql');
		}).toThrow(/CHECK constraint failed/u);
	});
});

describe('cache access compatible contract', () => {
	let database: DatabaseSync;
	const liveTenantStatuses: readonly string[] = [
		'active',
		'suspended',
		'offboarding'
	];

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		prepareContractDatabase(database);
	});

	afterEach(() => {
		database.close();
	});

	it.each(liveTenantStatuses)(
		'refuses a %s tenant whose catalogue sweep has not completed',
		(status) => {
			database
				.prepare('UPDATE tenant SET status = ? WHERE id = ?')
				.run(status, 'alice');

			expect(() => {
				applyMigration(database, '0024_cache_access_contract_assertions.sql');
			}).toThrow(/CHECK constraint failed/u);
		}
	);

	it.each(liveTenantStatuses)(
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
				applyMigration(database, '0024_cache_access_contract_assertions.sql');
			}).toThrow(/CHECK constraint failed/u);
		}
	);

	it('accepts swept active, suspended, and offboarding tenants', () => {
		markCatalogueComplete(database);
		insertTenant(database, {
			id: 'bob',
			status: 'suspended',
			readMode: 'private',
			catalogueVersion: 1
		});
		insertTenant(database, {
			id: 'carol',
			status: 'offboarding',
			catalogueVersion: 1
		});

		expect(() => {
			applyMigration(database, '0024_cache_access_contract_assertions.sql');
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

	const invalidRows: {
		readonly name: string;
		readonly table: string;
		readonly insert: string;
	}[] = [
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
	];

	it.each(invalidRows)('rejects $name in $table', ({ insert }) => {
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
});

describe('cache access native contract', () => {
	let database: DatabaseSync;

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		prepareContractDatabase(database);
		markCatalogueComplete(database);
	});

	afterEach(() => {
		database.close();
	});

	it('contracts populated compatibility rows without losing native identities', () => {
		applyCompatibleContract(database);
		database.exec(`
			INSERT INTO blob_ref (
				tenant, cache, cache_kind, cache_name, store_path_hash,
				generation, nar_hash, cache_generation
			) VALUES (
				'alice', 'guides', 'named', 'guides', 'blob-path', 2,
				'sha256:blob', NULL
			);
			INSERT INTO attestation_ref (
				tenant, cache, cache_kind, cache_name, store_path_hash,
				generation, predicate_type, digest
			) VALUES (
				'alice', 'private/builds', 'named', 'builds', 'attestation-path',
				4, 'https://example.test/predicate', 'digest'
			);
			INSERT INTO cache_lifecycle (
				tenant, cache, cache_kind, cache_name, access, generation,
				deleted_at, updated_at
			) VALUES
				(
					'alice', 'guides', 'named', 'guides', 'public', 3, NULL,
					'2026-01-02T00:00:00.000Z'
				),
				(
					'alice', 'private/builds', 'named', 'builds', 'private', 4, NULL,
					'2026-01-03T00:00:00.000Z'
				);
			INSERT INTO tenant_cache_read_credential (
				tenant, cache, cache_kind, cache_name, read_user,
				read_password_hash, read_password_salt, created_at
			) VALUES
				(
					'alice', 'private/builds', 'named', 'builds', 'reader', 'hash',
					'salt', '2026-01-01T00:00:00.000Z'
				),
				(
					'alice', 'private/orphan', 'named', 'orphan', 'stale', 'hash',
					'salt', '2026-01-01T00:00:00.000Z'
				);
		`);

		applyMigration(database, '0026_cache_incarnation_expand.sql');
		applyMigration(database, '0027_cache_generation_contract_assertions.sql');
		applyMigration(database, '0028_drop_cache_credential_lifecycle_guard.sql');
		applyMigration(database, '0029_cache_identity_contract.sql');
		applyMigration(database, '0030_cache_credential_lifecycle_guard.sql');

		const contractedTables = [
			'attestation_ref',
			'blob_ref',
			'cache_lifecycle',
			'tenant_cache_read_credential'
		];
		const retiredColumns = [
			...contractedTables.flatMap((table) =>
				database
					.prepare(`PRAGMA table_info(${table})`)
					.all()
					.filter((column) => column.name === 'cache')
					.map((column) => `${table}.${String(column.name)}`)
			),
			...database
				.prepare('PRAGMA table_info(tenant)')
				.all()
				.filter((column) => column.name === 'read_mode')
				.map((column) => `tenant.${String(column.name)}`)
		];
		const primaryKeys = contractedTables.map((table) => ({
			table,
			columns: database
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.filter((column) => Number(column.pk) > 0)
				.map((column) => String(column.name))
		}));
		const indexes = database
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'index'
					AND tbl_name IN (
						'attestation_ref', 'blob_ref', 'cache_lifecycle',
						'tenant_cache_read_credential'
					)
				 ORDER BY name`
			)
			.all()
			.map((row) => String(row.name));
		const cacheGenerationColumn = {
			...database
				.prepare(
					`SELECT name, "notnull" AS required
					 FROM pragma_table_info('blob_ref')
					 WHERE name = 'cache_generation'`
				)
				.get()
		};

		expect({
			retiredColumns,
			primaryKeys,
			indexes,
			cacheGenerationColumn,
			blob: { ...database.prepare('SELECT * FROM blob_ref').get() },
			attestation: {
				...database.prepare('SELECT * FROM attestation_ref').get()
			},
			lifecycles: database
				.prepare(
					`SELECT cache_kind, cache_name, access, generation
					 FROM cache_lifecycle ORDER BY cache_kind, cache_name`
				)
				.all()
				.map((row) => ({
					...row,
					cache_name: row.cache_name ?? undefined
				})),
			credentials: database
				.prepare(
					`SELECT cache_kind, cache_name, read_user
					 FROM tenant_cache_read_credential
					 ORDER BY cache_kind, cache_name`
				)
				.all()
				.map((row) => ({ ...row }))
		}).toStrictEqual({
			retiredColumns: [],
			primaryKeys: contractedTables.map((table) => ({ table, columns: [] })),
			indexes: [
				'attestation_ref_default_identity_idx',
				'attestation_ref_digest_idx',
				'attestation_ref_named_identity_idx',
				'blob_ref_default_identity_idx',
				'blob_ref_named_identity_idx',
				'blob_ref_nar_hash_idx',
				'blob_ref_tenant_nar_hash_native_idx',
				'cache_lifecycle_default_identity_idx',
				'cache_lifecycle_named_identity_idx',
				'tenant_cache_read_credential_default_identity_idx',
				'tenant_cache_read_credential_named_identity_idx'
			],
			cacheGenerationColumn: { name: 'cache_generation', required: 1 },
			blob: {
				tenant: 'alice',
				cache_kind: 'named',
				cache_name: 'guides',
				store_path_hash: 'blob-path',
				generation: 2,
				nar_hash: 'sha256:blob',
				cache_generation: 1
			},
			attestation: {
				tenant: 'alice',
				cache_kind: 'named',
				cache_name: 'builds',
				store_path_hash: 'attestation-path',
				generation: 4,
				predicate_type: 'https://example.test/predicate',
				digest: 'digest'
			},
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
					generation: 4
				},
				{
					cache_kind: 'named',
					cache_name: 'guides',
					access: 'public',
					generation: 3
				}
			],
			credentials: [
				{
					cache_kind: 'named',
					cache_name: 'builds',
					read_user: 'reader'
				}
			]
		});
	});

	it.each([
		{
			source: 'blob reference',
			insert: `INSERT INTO blob_ref (
				tenant, cache, cache_kind, cache_name, store_path_hash,
				generation, nar_hash, cache_generation
			) VALUES (
				'alice', 'orphan', 'named', 'orphan', 'path', 1,
				'sha256:orphan', NULL
			)`
		},
		{
			source: 'attestation reference',
			insert: `INSERT INTO attestation_ref (
				tenant, cache, cache_kind, cache_name, store_path_hash,
				generation, predicate_type, digest
			) VALUES (
				'alice', 'orphan', 'named', 'orphan', 'path', 1,
				'https://example.test/predicate', 'digest'
			)`
		}
	])('refuses a $source without a lifecycle', ({ insert }) => {
		applyCompatibleContract(database);
		database.exec(insert);
		applyMigration(database, '0026_cache_incarnation_expand.sql');

		expect(() => {
			applyMigration(database, '0027_cache_generation_contract_assertions.sql');
		}).toThrow(/CHECK constraint failed/u);
	});

	it.each([
		{
			name: 'missing named cache',
			legacyCache: 'missing',
			cacheKind: 'named',
			cacheNameSql: "'missing'"
		},
		{
			name: 'deleted named cache',
			legacyCache: 'private/deleted',
			prepare: () => {
				database.exec(`
					INSERT INTO cache_lifecycle (
						tenant, cache, cache_kind, cache_name, access, generation,
						deleted_at, updated_at
					) VALUES (
						'alice', 'private/deleted', 'named', 'deleted', 'private', 2,
						'2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
					)
				`);
			},
			cacheKind: 'named',
			cacheNameSql: "'deleted'"
		},
		{
			name: 'missing default cache',
			legacyCache: '',
			prepare: () => {
				database.exec(
					"DELETE FROM cache_lifecycle WHERE cache_kind = 'default'"
				);
			},
			cacheKind: 'default',
			cacheNameSql: 'NULL'
		},
		{
			name: 'deleted default cache',
			legacyCache: '',
			prepare: () => {
				database.exec(
					"UPDATE cache_lifecycle SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE cache_kind = 'default'"
				);
			},
			cacheKind: 'default',
			cacheNameSql: 'NULL'
		}
	])(
		'blocks the previous writer from creating a credential for a $name',
		({ prepare, legacyCache, cacheKind, cacheNameSql }) => {
			applyCompatibleContract(database);
			prepare?.();
			applyMigration(database, '0026_cache_incarnation_expand.sql');
			applyMigration(database, '0027_cache_generation_contract_assertions.sql');

			expect(() => {
				database.exec(`
					INSERT INTO tenant_cache_read_credential (
						tenant, cache, cache_kind, cache_name, read_user,
						read_password_hash, read_password_salt, created_at
					) VALUES (
						'alice', '${legacyCache}', '${cacheKind}', ${cacheNameSql},
						'reader', 'hash', 'salt', '2026-01-03T00:00:00.000Z'
					)
				`);
			}).toThrow();
		}
	);

	it('removes a credential for a cache deleted before the contract', () => {
		applyCompatibleContract(database);
		database.exec(`
			INSERT INTO cache_lifecycle (
				tenant, cache, cache_kind, cache_name, access, generation,
				deleted_at, updated_at
			) VALUES (
				'alice', 'private/builds', 'named', 'builds', 'private', 2,
				'2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
			);
			INSERT INTO tenant_cache_read_credential (
				tenant, cache, cache_kind, cache_name, read_user,
				read_password_hash, read_password_salt, created_at
			) VALUES (
				'alice', 'private/builds', 'named', 'builds', 'reader', 'hash',
				'salt', '2026-01-02T00:00:00.000Z'
			)
		`);

		applyMigration(database, '0026_cache_incarnation_expand.sql');
		applyMigration(database, '0027_cache_generation_contract_assertions.sql');

		expect(
			database
				.prepare('SELECT * FROM tenant_cache_read_credential')
				.all()
				.map((row) => ({ ...row }))
		).toStrictEqual([]);
	});

	it('retains the cache credential guard after the structural contract', () => {
		applyNativeContract(database);

		expect(() => {
			database.exec(`
				INSERT INTO tenant_cache_read_credential (
					tenant, cache_kind, cache_name, read_user,
					read_password_hash, read_password_salt, created_at
				) VALUES (
					'alice', 'named', 'missing', 'reader', 'hash', 'salt',
					'2026-01-03T00:00:00.000Z'
				)
			`);
		}).toThrow();
	});

	it('removes credentials written while the structural contract replaces the guard', () => {
		applyCompatibleContract(database);
		applyMigration(database, '0026_cache_incarnation_expand.sql');
		applyMigration(database, '0027_cache_generation_contract_assertions.sql');
		applyMigration(database, '0028_drop_cache_credential_lifecycle_guard.sql');
		applyMigration(database, '0029_cache_identity_contract.sql');
		database.exec(`
			INSERT INTO tenant_cache_read_credential (
				tenant, cache_kind, cache_name, read_user,
				read_password_hash, read_password_salt, created_at
			) VALUES (
				'alice', 'named', 'missing', 'reader', 'hash', 'salt',
				'2026-01-03T00:00:00.000Z'
			)
		`);

		applyMigration(database, '0030_cache_credential_lifecycle_guard.sql');

		expect(
			database
				.prepare('SELECT * FROM tenant_cache_read_credential')
				.all()
				.map((row) => ({ ...row }))
		).toStrictEqual([]);
	});

	it.each([
		{
			change: 'tombstoned',
			mutate: (target: DatabaseSync) => {
				target.exec(`
					UPDATE cache_lifecycle
					SET deleted_at = '2026-01-04T00:00:00.000Z'
					WHERE tenant = 'alice'
						AND cache_kind = 'named'
						AND cache_name = 'builds'
				`);
			}
		},
		{
			change: 'deleted',
			mutate: (target: DatabaseSync) => {
				target.exec(`
					DELETE FROM cache_lifecycle
					WHERE tenant = 'alice'
						AND cache_kind = 'named'
						AND cache_name = 'builds'
				`);
			}
		}
	])(
		'removes a credential when its cache lifecycle is $change',
		({ mutate }) => {
			applyNativeContract(database);
			database.exec(`
			INSERT INTO cache_lifecycle (
				tenant, cache_kind, cache_name, access, generation, updated_at
			) VALUES (
				'alice', 'named', 'builds', 'private', 1,
				'2026-01-03T00:00:00.000Z'
			);
			INSERT INTO tenant_cache_read_credential (
				tenant, cache_kind, cache_name, read_user,
				read_password_hash, read_password_salt, created_at
			) VALUES (
				'alice', 'named', 'builds', 'reader', 'hash', 'salt',
				'2026-01-03T00:00:00.000Z'
			)
		`);

			mutate(database);

			expect(
				database
					.prepare('SELECT * FROM tenant_cache_read_credential')
					.all()
					.map((row) => ({ ...row }))
			).toStrictEqual([]);
		}
	);

	it('enforces the native default and named cache identities', () => {
		applyNativeContract(database);
		const insertDefault = database.prepare(
			`INSERT INTO blob_ref (
				tenant, cache_kind, cache_name, store_path_hash, generation,
				nar_hash, cache_generation
			) VALUES ('alice', 'default', NULL, ?, 1, ?, 1)`
		);
		const insertNamed = database.prepare(
			`INSERT INTO blob_ref (
				tenant, cache_kind, cache_name, store_path_hash, generation,
				nar_hash, cache_generation
			) VALUES ('alice', 'named', ?, ?, 1, ?, 1)`
		);
		const insertInvalidDefault = database.prepare(
			`INSERT INTO blob_ref (
				tenant, cache_kind, cache_name, store_path_hash, generation,
				nar_hash, cache_generation
			) VALUES ('alice', 'default', 'bad-default', ?, 1, ?, 1)`
		);

		insertDefault.run('default-path', 'sha256:default');
		expect(() => {
			insertDefault.run('default-path', 'sha256:duplicate');
		}).toThrow(/UNIQUE constraint failed/u);

		insertNamed.run('builds', 'named-path', 'sha256:builds');
		expect(() => {
			insertNamed.run('builds', 'named-path', 'sha256:duplicate');
		}).toThrow(/UNIQUE constraint failed/u);
		expect(() => {
			insertNamed.run('guides', 'named-path', 'sha256:guides');
		}).not.toThrow();
		expect(() => {
			insertInvalidDefault.run('invalid-path', 'sha256:invalid');
		}).toThrow(/CHECK constraint failed/u);
	});

	it('retains the native NAR-authority query plan', () => {
		applyNativeContract(database);

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

		expect(plan).toStrictEqual([
			expect.stringContaining('blob_ref_tenant_nar_hash_native_idx')
		]);
	});
});
