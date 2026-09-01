import { createHash } from 'node:crypto';

import type { DatabaseId } from './identifiers.ts';

/**
 * A D1 migration ready to apply: its filename (the applied-marker recorded in
 * the tracking table) and the individual statements to run in order.
 */
export interface D1Migration {
	readonly name: string;
	readonly sha256: string;
	readonly statements: readonly string[];
}

export interface RawMigrationFile {
	readonly name: string;
	readonly sql: string;
}

const statementBreakpoint = '--> statement-breakpoint';

/**
 * Parse Drizzle's `.sql` migration files into ordered, statement-split
 * migrations. Drizzle separates statements with a `--> statement-breakpoint`
 * marker; the D1 query API accepts the statements as a transactional batch.
 */
export function parseD1Migrations(
	files: readonly RawMigrationFile[]
): D1Migration[] {
	return files
		.toSorted((left, right) => left.name.localeCompare(right.name))
		.map((file) => ({
			name: file.name,
			sha256: createHash('sha256').update(file.sql).digest('hex'),
			statements: file.sql
				.split(statementBreakpoint)
				.map((statement) => statement.trim())
				.filter((statement) => statement.length > 0)
		}));
}

export class D1MigrationSequenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'D1MigrationSequenceError';
	}
}

export interface D1MigrationApi {
	queryBatch(
		databaseId: DatabaseId,
		statements: readonly string[]
	): Promise<void>;
	queryRows(databaseId: DatabaseId, sql: string): Promise<readonly string[]>;
}

const ensureTrackingTable =
	'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);';

function quote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Apply the D1 migrations that have not yet run, tracking applied names in a
 * `d1_migrations` table (the same scheme `wrangler d1 migrations apply` uses).
 * Idempotent: a second run with no new migrations is a no-op. Returns the names
 * applied this run.
 */
export async function applyD1Migrations(
	api: D1MigrationApi,
	databaseId: DatabaseId,
	migrations: readonly D1Migration[]
): Promise<string[]> {
	await api.queryBatch(databaseId, [ensureTrackingTable]);

	const applied = new Set(
		await api.queryRows(databaseId, 'SELECT name FROM d1_migrations;')
	);

	const pending = migrations.filter(
		(migration) => !applied.has(migration.name)
	);
	const newlyApplied: string[] = [];

	for (const migration of pending) {
		await api.queryBatch(databaseId, [
			...migration.statements,
			`INSERT INTO d1_migrations (name) VALUES (${quote(migration.name)});`
		]);

		newlyApplied.push(migration.name);
	}

	return newlyApplied;
}

/**
 * Applies one manifest-declared contiguous set of D1 migrations. The bootstrap
 * migration must already have created both migration tracking tables.
 */
export async function applyDeclaredD1Migrations(
	api: D1MigrationApi,
	databaseId: DatabaseId,
	allMigrations: readonly D1Migration[],
	declaredNames: readonly string[]
): Promise<string[]> {
	const appliedNames = await api.queryRows(
		databaseId,
		'SELECT name FROM d1_migrations ORDER BY id;'
	);
	const storedChecksumRows = await api.queryRows(
		databaseId,
		"SELECT migration_id || ':' || sha256 AS name FROM structural_migration_checksum WHERE kind = 'd1' ORDER BY migration_id;"
	);
	const appliedChecksums = new Map(
		storedChecksumRows.map((entry) => {
			const separator = entry.indexOf(':');

			if (separator < 1) {
				throw new D1MigrationSequenceError(
					`Invalid stored D1 migration checksum ${entry}`
				);
			}

			return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
		})
	);
	const migrationByName = new Map(
		allMigrations.map((migration) => [migration.name, migration] as const)
	);

	for (const [index, name] of appliedNames.entries()) {
		if (allMigrations[index]?.name !== name) {
			throw new D1MigrationSequenceError(
				`Applied D1 migration ${name} is not the expected migration at position ${String(index)}`
			);
		}
	}

	const expectedNames = allMigrations
		.slice(appliedNames.length, appliedNames.length + declaredNames.length)
		.map((migration) => migration.name);

	if (expectedNames.join('\n') !== declaredNames.join('\n')) {
		throw new D1MigrationSequenceError(
			'The manifest does not declare the next contiguous D1 migration set'
		);
	}

	for (const name of appliedNames) {
		const storedChecksum = appliedChecksums.get(name);
		const migration = migrationByName.get(name);

		if (storedChecksum !== undefined && storedChecksum !== migration?.sha256) {
			throw new D1MigrationSequenceError(
				`D1 migration ${name} changed after it was applied`
			);
		}
	}

	for (const name of declaredNames) {
		const migration = migrationByName.get(name);

		if (migration === undefined) {
			throw new D1MigrationSequenceError(
				`The artifact does not contain D1 migration ${name}`
			);
		}

		await api.queryBatch(databaseId, [
			...migration.statements,
			`INSERT INTO d1_migrations (name) VALUES (${quote(migration.name)});`,
			`INSERT INTO structural_migration_checksum (kind, migration_id, sha256, applied_at) VALUES ('d1', ${quote(migration.name)}, ${quote(migration.sha256)}, CURRENT_TIMESTAMP);`
		]);
	}

	return [...declaredNames];
}
