import type { SingleStepMigrationParam } from 'cloudflare/resources/workers/workers';

import type { DurableObjectMigration } from './config.ts';
import type { DatabaseId } from './identifiers.ts';

/**
 * A D1 migration ready to apply: its filename (the applied-marker recorded in
 * the tracking table) and the individual statements to run in order.
 */
export interface D1Migration {
	readonly name: string;
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
 * marker; the D1 query API takes one statement at a time.
 */
export function parseD1Migrations(
	files: readonly RawMigrationFile[]
): D1Migration[] {
	return files
		.toSorted((left, right) => left.name.localeCompare(right.name))
		.map((file) => ({
			name: file.name,
			statements: file.sql
				.split(statementBreakpoint)
				.map((statement) => statement.trim())
				.filter((statement) => statement.length > 0)
		}));
}

export interface D1MigrationApi {
	query(databaseId: DatabaseId, sql: string): Promise<void>;
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
	await api.query(databaseId, ensureTrackingTable);

	const applied = new Set(
		await api.queryRows(databaseId, 'SELECT name FROM d1_migrations;')
	);

	const pending = migrations.filter(
		(migration) => !applied.has(migration.name)
	);
	const newlyApplied: string[] = [];

	for (const migration of pending) {
		for (const statement of migration.statements) {
			await api.query(databaseId, statement);
		}

		await api.query(
			databaseId,
			`INSERT INTO d1_migrations (name) VALUES (${quote(migration.name)});`
		);

		newlyApplied.push(migration.name);
	}

	return newlyApplied;
}

/**
 * Decide which Durable Object migration step to send, given the migration tag
 * the deployed script already reports. On a first deploy (no tag) the full set
 * of new-SQLite-class steps is sent; once the tag matches the latest config
 * migration, no migration payload is sent. Mirrors wrangler's
 * `getMigrationsToUpload`, reduced to the steps this Worker uses.
 */
export function computeDurableObjectMigration(
	deployedTag: string | undefined,
	migrations: readonly DurableObjectMigration[]
): SingleStepMigrationParam | undefined {
	if (migrations.length === 0) {
		return undefined;
	}

	const latest = migrations.at(-1);

	if (latest === undefined || deployedTag === latest.tag) {
		return undefined;
	}

	const foundIndex =
		deployedTag === undefined
			? -1
			: migrations.findIndex((migration) => migration.tag === deployedTag);

	const steps = migrations.slice(foundIndex + 1);
	const newSqliteClasses = steps.flatMap((step) => [...step.newSqliteClasses]);

	return {
		new_tag: latest.tag,
		...(deployedTag !== undefined && { old_tag: deployedTag }),
		...(newSqliteClasses.length > 0 && { new_sqlite_classes: newSqliteClasses })
	};
}
