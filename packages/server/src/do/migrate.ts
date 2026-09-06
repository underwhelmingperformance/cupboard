import { sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

interface JournalEntry {
	readonly idx: number;
	readonly when: number;
	readonly tag: string;
}

export interface MigrationBundle {
	readonly journal: { readonly entries: readonly JournalEntry[] };
	readonly migrations: Record<string, string>;
}

export function migrationsThrough(
	bundle: MigrationBundle,
	throughIndex: number
): MigrationBundle {
	return {
		journal: {
			entries: bundle.journal.entries.filter(
				(entry) => entry.idx <= throughIndex
			)
		},
		migrations: Object.fromEntries(
			Object.entries(bundle.migrations).filter(
				([key]) => Math.trunc(Number(key.slice(1))) <= throughIndex
			)
		)
	};
}

// Share Drizzle's bookkeeping table so either migrator recognises the latest
// recorded timestamp. Drizzle stores the migration content hash in `hash`; this
// migrator stores the stable journal tag there.
const trackingTable = '__drizzle_migrations';

const statementBreakpoint = '--> statement-breakpoint';

/**
 * Thrown when a migration statement fails for a reason other than the change
 * already being present. It names the migration and the offending statement and
 * keeps the underlying database error as its cause, so the real fault reaches
 * the logs.
 */
export class DurableObjectMigrationError extends Error {
	constructor(
		readonly tag: string,
		readonly statement: string,
		override readonly cause: unknown
	) {
		super(`Durable Object migration ${tag} failed: ${rootMessage(cause)}`);
		this.name = 'DurableObjectMigrationError';
	}
}

// Drizzle wraps the SQLite error, so use the last error in the cause chain in
// the migration diagnostic.
function causeMessages(error: unknown): string[] {
	const messages: string[] = [];
	const seen = new Set<unknown>();

	let current: unknown = error;

	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		messages.push(current.message);
		current = current.cause;
	}

	return messages.length > 0 ? messages : [String(error)];
}

function rootMessage(error: unknown): string {
	const messages = causeMessages(error);

	return messages.at(-1) ?? String(error);
}

function migrationKey(index: number): string {
	return `m${index.toString().padStart(4, '0')}`;
}

function statementsOf(bundle: MigrationBundle, entry: JournalEntry): string[] {
	const source = bundle.migrations[migrationKey(entry.idx)];

	if (source === undefined) {
		throw new Error(`Missing migration SQL for ${entry.tag}`);
	}

	return source
		.split(statementBreakpoint)
		.map((statement) => statement.trim())
		.filter((statement) => statement !== '');
}

// SQLite reports an additive change that is already in place with one of these.
// Re-running such a statement against a store that already holds the object is a
// no-op, so a Durable Object whose migration history diverged from this build
// converges.
function isAlreadyApplied(error: unknown): boolean {
	return causeMessages(error).some(
		(message) =>
			/already exists/i.test(message) || /duplicate column name/i.test(message)
	);
}

type MigrationDatabase<TSchema extends Record<string, unknown>> =
	DrizzleSqliteDODatabase<TSchema>;

interface TrackingState {
	readonly appliedTags: ReadonlySet<string>;
	readonly threshold: number;
}

function readTracking<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>
): TrackingState {
	database.run(
		sql.raw(
			`CREATE TABLE IF NOT EXISTS ${trackingTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
		)
	);

	const rows = database.values(
		sql.raw(`SELECT hash, created_at FROM ${trackingTable}`)
	);

	const appliedTags = new Set<string>();
	let threshold = -Infinity;

	for (const row of rows) {
		const hash = String(row[0]);
		const when = Number(row[1]);

		if (hash !== '') {
			appliedTags.add(hash);
		}

		if (Number.isFinite(when) && when > threshold) {
			threshold = when;
		}
	}

	return { appliedTags, threshold };
}

function applyMigration<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	entry: JournalEntry,
	statements: readonly string[]
): void {
	database.transaction((tx) => {
		for (const statement of statements) {
			try {
				tx.run(sql.raw(statement));
			} catch (error) {
				if (isAlreadyApplied(error)) {
					continue;
				}

				throw new DurableObjectMigrationError(entry.tag, statement, error);
			}
		}

		tx.run(
			sql`INSERT INTO ${sql.identifier(trackingTable)} (hash, created_at) VALUES (${entry.tag}, ${entry.when})`
		);
	});
}

/**
 * Brings a Durable Object's SQLite schema up to the bundled migrations.
 *
 * A migration is skipped when its tag is recorded or its timestamp is no later
 * than the latest recorded migration. This recognises stores managed by
 * Drizzle, then records stable journal tags for later runs. Each migration runs
 * in its own transaction, and an unexpected statement failure retains its
 * cause.
 */
export function applyMigrations<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	bundle: MigrationBundle
): void {
	const { appliedTags, threshold } = readTracking(database);

	const entries = bundle.journal.entries.toSorted((a, b) => a.idx - b.idx);

	for (const entry of entries) {
		if (appliedTags.has(entry.tag) || entry.when <= threshold) {
			continue;
		}

		applyMigration(database, entry, statementsOf(bundle, entry));
	}
}
