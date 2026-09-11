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

/**
 * The digest of each migration's SQL, keyed by its journal tag.
 */
export type MigrationDigests = ReadonlyMap<string, string>;

// Share Drizzle's bookkeeping table so either migrator recognises the latest
// recorded timestamp. Drizzle stores the migration content hash in `hash`; this
// migrator stores the stable journal tag there.
const trackingTable = '__drizzle_migrations';

// Drizzle recorded an empty hash for every migration up to this index. Later
// migrations were applied by this migrator, which always records the tag, so an
// empty hash above the boundary means the row did not come from either.
const lastLegacyDrizzleMigrationIndex = 24;

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

/**
 * A recorded migration's SQL no longer matches what this build carries.
 */
export class DurableObjectMigrationDigestError extends Error {
	constructor(
		readonly tag: string,
		readonly expected: string,
		readonly actual: string
	) {
		super(
			`Durable Object migration ${tag} has digest ${actual}; expected ${expected}`
		);
		this.name = 'DurableObjectMigrationDigestError';
	}
}

/**
 * The store's recorded history is not a history this build can continue.
 */
export class DurableObjectMigrationJournalError extends Error {
	constructor(
		readonly tag: string,
		readonly detail: string
	) {
		super(`Durable Object migration journal is invalid at ${tag}: ${detail}`);
		this.name = 'DurableObjectMigrationJournalError';
	}
}

/**
 * A tracking row carries a verification state this build does not know.
 */
export class DurableObjectMigrationVerificationStateError extends Error {
	constructor(
		readonly tag: string,
		readonly verificationState: string
	) {
		super(
			`Durable Object migration ${tag} has unknown verification state ${verificationState}`
		);
		this.name = 'DurableObjectMigrationVerificationStateError';
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

/**
 * How much a recorded digest proves. `verified` was written by this migrator,
 * so the digest is the SQL the store ran. `unverified-baseline` was adopted for
 * a row Drizzle wrote before digests were recorded.
 */
type VerificationState = 'verified' | 'unverified-baseline';

interface TrackingRow {
	readonly hash: string;
	readonly when: number;
	readonly digest: string | undefined;
	readonly verificationState: VerificationState;
}

function addColumnIfMissing<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	column: string
): void {
	try {
		database.run(sql.raw(`ALTER TABLE ${trackingTable} ADD COLUMN ${column}`));
	} catch (error) {
		if (!isAlreadyApplied(error)) {
			throw error;
		}
	}
}

function readTracking<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>
): TrackingRow[] {
	database.run(
		sql.raw(
			`CREATE TABLE IF NOT EXISTS ${trackingTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
		)
	);
	addColumnIfMissing(database, 'digest text');
	addColumnIfMissing(database, 'verification_state text');
	database.run(
		sql.raw(
			`UPDATE ${trackingTable} SET verification_state = CASE WHEN digest IS NULL THEN 'unverified-baseline' ELSE 'verified' END WHERE verification_state IS NULL`
		)
	);

	const rows = database.values(
		sql.raw(
			`SELECT id, hash, created_at, digest, verification_state FROM ${trackingTable} ORDER BY created_at, id`
		)
	);

	return rows.map((row) => {
		const hash = String(row[1]);
		const verificationState = row[4];

		if (
			verificationState !== 'verified' &&
			verificationState !== 'unverified-baseline'
		) {
			throw new DurableObjectMigrationVerificationStateError(
				hash,
				String(verificationState)
			);
		}

		return {
			hash,
			when: Number(row[2]),
			digest: typeof row[3] === 'string' ? row[3] : undefined,
			verificationState
		};
	});
}

function hasSchemaTables<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>
): boolean {
	return (
		database.values(
			sql.raw(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table'
				   AND name NOT LIKE 'sqlite_%'
				   AND name != '${trackingTable}'
				 LIMIT 1`
			)
		).length > 0
	);
}

function assertRowMatchesEntry(
	row: TrackingRow,
	entry: JournalEntry,
	digests: MigrationDigests
): void {
	if (!Number.isFinite(row.when) || row.when !== entry.when) {
		throw new DurableObjectMigrationJournalError(
			entry.tag,
			`recorded timestamp ${String(row.when)} does not equal ${String(entry.when)}`
		);
	}

	if (row.hash !== '' && row.hash !== entry.tag) {
		throw new DurableObjectMigrationJournalError(
			entry.tag,
			`recorded tag ${row.hash} is neither the stable tag nor the legacy empty hash`
		);
	}

	if (row.hash === '' && entry.idx > lastLegacyDrizzleMigrationIndex) {
		throw new DurableObjectMigrationJournalError(
			entry.tag,
			'the legacy empty hash is not valid after the Drizzle migration boundary'
		);
	}

	if (row.verificationState === 'verified' && row.hash !== entry.tag) {
		throw new DurableObjectMigrationJournalError(
			entry.tag,
			'a verified migration must use its stable tag'
		);
	}

	const expectedDigest = digests.get(entry.tag);

	if (
		expectedDigest !== undefined &&
		row.digest !== undefined &&
		row.digest !== expectedDigest
	) {
		throw new DurableObjectMigrationDigestError(
			entry.tag,
			expectedDigest,
			row.digest
		);
	}
}

/**
 * Refuse a store whose recorded history this build cannot continue.
 *
 * The recorded rows must be a prefix of the bundled journal: same order, same
 * timestamps, and either the stable tag or the legacy empty hash that Drizzle
 * wrote below the boundary. A row this migrator verified must carry its tag.
 *
 * Rows beyond the bundle are migrations a newer Worker applied before this one
 * woke, which happens on a rollback. They are admitted only when that Worker
 * verified them, because an unverified successor is a history this build cannot
 * reason about.
 *
 * An empty journal over existing application tables means the store was
 * migrated by something that kept no record, so the schema cannot be trusted to
 * match any journal position. That is checked on every admission rather than
 * only when the store is new.
 */
export function admitMigrationSource<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	bundle: MigrationBundle,
	digests: MigrationDigests
): void {
	const rows = readTracking(database);

	if (rows.length === 0) {
		if (hasSchemaTables(database)) {
			throw new DurableObjectMigrationJournalError(
				'missing-journal',
				'the journal is empty but application tables already exist'
			);
		}

		return;
	}

	const entries = bundle.journal.entries.toSorted((a, b) => a.idx - b.idx);

	for (const [index, row] of rows.entries()) {
		const entry = entries[index];

		if (entry === undefined) {
			if (row.verificationState !== 'verified') {
				throw new DurableObjectMigrationJournalError(
					row.hash === '' ? 'unknown-migration' : row.hash,
					'an unverified migration follows the migrations this build carries'
				);
			}

			continue;
		}

		assertRowMatchesEntry(row, entry, digests);
	}
}

function applyMigration<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	entry: JournalEntry,
	statements: readonly string[],
	digest: string | undefined
): void {
	const storedDigest = digest ?? sql.raw('NULL');
	const verificationState: VerificationState =
		digest === undefined ? 'unverified-baseline' : 'verified';

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
			sql`INSERT INTO ${sql.identifier(trackingTable)} (hash, created_at, digest, verification_state) VALUES (${entry.tag}, ${entry.when}, ${storedDigest}, ${verificationState})`
		);
	});
}

/**
 * Brings a Durable Object's SQLite schema up to the bundled migrations, after
 * {@link admitMigrationSource} has accepted the store's recorded history.
 *
 * A migration whose tag is already recorded is skipped. Each migration runs in
 * its own transaction and records the digest it was applied from, so a later
 * build can tell what this store actually ran.
 */
export function applyMigrations<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	bundle: MigrationBundle,
	digests: MigrationDigests = new Map()
): void {
	admitMigrationSource(database, bundle, digests);

	// Admission proved the recorded rows are a prefix of the journal, so the
	// migrations still to run are the entries past them.
	const applied = readTracking(database).length;
	const entries = bundle.journal.entries.toSorted((a, b) => a.idx - b.idx);

	for (const entry of entries.slice(applied)) {
		applyMigration(
			database,
			entry,
			statementsOf(bundle, entry),
			digests.get(entry.tag)
		);
	}
}
