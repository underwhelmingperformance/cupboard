import { createHash } from 'node:crypto';

import type { DatabaseId } from './identifiers.ts';

/**
 * A D1 migration ready to apply: its filename (the applied-marker recorded in
 * the tracking table), the digest of the file it was parsed from, and the
 * individual statements to run in order.
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

export interface D1MigrationApi {
	queryBatch(
		databaseId: DatabaseId,
		statements: readonly string[]
	): Promise<void>;
	queryRows(databaseId: DatabaseId, sql: string): Promise<readonly string[]>;
}

/**
 * A migration file changed after this tool applied it. The database ran the
 * earlier contents, so applying the file again would not produce the schema
 * the new contents describe.
 */
export class D1MigrationDigestError extends Error {
	constructor(
		readonly migrationName: string,
		readonly recordedSha256: string,
		readonly fileSha256: string
	) {
		super(`D1 migration ${migrationName} does not match its recorded digest`);
		this.name = 'D1MigrationDigestError';
	}
}

/**
 * How much a recorded digest proves. Either way a later change to the file is
 * refused, because the recorded digest no longer matches it.
 *
 * `verified` was recorded when this tool applied the migration, so the digest
 * is what the database ran. `unverified-baseline` was adopted for a name
 * already applied before digests were recorded: it proves the name ran, but
 * the digest was read from the file rather than observed during the apply.
 */
type VerificationState = 'verified' | 'unverified-baseline';

interface RecordedMigration {
	readonly sha256?: string;
	readonly verificationState?: VerificationState;
}

const ensureTrackingTable =
	'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);';

const trackingColumnsQuery =
	"SELECT name FROM pragma_table_info('d1_migrations');";

// One column, because the query API returns a single string per row. Migration
// names contain no colon, so the first and last separators bound the digest.
const recordedMigrationsQuery =
	"SELECT name || ':' || COALESCE(sha256, '') || ':' || COALESCE(verification_state, '') FROM d1_migrations;";

function quote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function parseRecorded(entry: string): [string, RecordedMigration] {
	const firstSeparator = entry.indexOf(':');
	const lastSeparator = entry.lastIndexOf(':');
	const name = entry.slice(0, firstSeparator);
	const sha256 = entry.slice(firstSeparator + 1, lastSeparator);
	const state = entry.slice(lastSeparator + 1);

	return [
		name,
		{
			...(sha256 !== '' && { sha256 }),
			...(state !== '' && { verificationState: state as VerificationState })
		}
	];
}

/**
 * Add the digest columns to a tracking table created before this tool recorded
 * digests. `ALTER TABLE ... ADD COLUMN` fails when the column already exists,
 * so the current columns decide what to add.
 */
async function ensureDigestColumns(
	api: D1MigrationApi,
	databaseId: DatabaseId
): Promise<void> {
	const columns = new Set(
		await api.queryRows(databaseId, trackingColumnsQuery)
	);
	const additions = [
		...(columns.has('sha256')
			? []
			: ['ALTER TABLE d1_migrations ADD COLUMN sha256 TEXT;']),
		...(columns.has('verification_state')
			? []
			: ['ALTER TABLE d1_migrations ADD COLUMN verification_state TEXT;'])
	];

	if (additions.length > 0) {
		await api.queryBatch(databaseId, additions);
	}
}

/**
 * Apply the D1 migrations that have not yet run, tracking applied names in a
 * `d1_migrations` table (the same scheme `wrangler d1 migrations apply` uses)
 * alongside the digest of the file each name was applied from. Idempotent: a
 * second run with no new migrations applies nothing and records nothing.
 *
 * A migration this tool applied is refused when its file no longer matches the
 * recorded digest. A name applied before digests were recorded adopts the
 * checked-in digest as an unverified baseline.
 *
 * Returns the names applied this run.
 */
export async function applyD1Migrations(
	api: D1MigrationApi,
	databaseId: DatabaseId,
	migrations: readonly D1Migration[]
): Promise<string[]> {
	await api.queryBatch(databaseId, [ensureTrackingTable]);
	await ensureDigestColumns(api, databaseId);

	const recordedEntries = await api.queryRows(
		databaseId,
		recordedMigrationsQuery
	);
	const recorded = new Map(
		recordedEntries.map((entry) => parseRecorded(entry))
	);
	const baselines: string[] = [];
	const pending: D1Migration[] = [];

	for (const migration of migrations) {
		const evidence = recorded.get(migration.name);

		if (evidence === undefined) {
			pending.push(migration);
			continue;
		}

		if (evidence.sha256 !== undefined) {
			if (evidence.sha256 !== migration.sha256) {
				throw new D1MigrationDigestError(
					migration.name,
					evidence.sha256,
					migration.sha256
				);
			}

			continue;
		}

		baselines.push(
			`UPDATE d1_migrations SET sha256 = ${quote(migration.sha256)}, verification_state = 'unverified-baseline' WHERE name = ${quote(migration.name)};`
		);
	}

	if (baselines.length > 0) {
		await api.queryBatch(databaseId, baselines);
	}

	const newlyApplied: string[] = [];

	for (const migration of pending) {
		await api.queryBatch(databaseId, [
			...migration.statements,
			`INSERT INTO d1_migrations (name, sha256, verification_state) VALUES (${quote(migration.name)}, ${quote(migration.sha256)}, 'verified');`
		]);

		newlyApplied.push(migration.name);
	}

	return newlyApplied;
}
