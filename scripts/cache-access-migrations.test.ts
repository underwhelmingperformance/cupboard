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
