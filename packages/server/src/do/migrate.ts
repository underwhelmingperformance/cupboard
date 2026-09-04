import { sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { sha256Hex } from '../crypto/crypto.ts';

interface JournalEntry {
	readonly idx: number;
	readonly when: number;
	readonly tag: string;
}

export interface MigrationBundle {
	readonly journal: { readonly entries: readonly JournalEntry[] };
	readonly migrations: Record<string, string>;
}

// Drizzle's migrator created this table and wrote an empty `hash`. This
// migrator keeps using it and stores the journal tag in `hash`.
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

function sourceOf(bundle: MigrationBundle, entry: JournalEntry): string {
	const source = bundle.migrations[migrationKey(entry.idx)];

	if (source === undefined) {
		throw new Error(`Missing migration SQL for ${entry.tag}`);
	}

	return source;
}

function statementsOf(bundle: MigrationBundle, entry: JournalEntry): string[] {
	return sourceOf(bundle, entry)
		.split(statementBreakpoint)
		.map((statement) => statement.trim())
		.filter((statement) => statement !== '');
}

/**
 * The SHA-256 of each migration's SQL as the bundle ships it, keyed by tag.
 */
type MigrationDigests = ReadonlyMap<string, string>;

const bundleDigests = new WeakMap<MigrationBundle, MigrationDigests>();

// Every object in the isolate initialises from the same bundle, so the digests
// are computed once and memoised.
async function digestsOf(bundle: MigrationBundle): Promise<MigrationDigests> {
	const memoised = bundleDigests.get(bundle);

	if (memoised !== undefined) {
		return memoised;
	}

	const digests = new Map(
		await Promise.all(
			bundle.journal.entries.map(
				async (entry) =>
					[entry.tag, await sha256Hex(sourceOf(bundle, entry))] as const
			)
		)
	);

	bundleDigests.set(bundle, digests);

	return digests;
}

function digestOf(digests: MigrationDigests, entry: JournalEntry): string {
	const digest = digests.get(entry.tag);

	if (digest === undefined) {
		throw new Error(`Missing migration digest for ${entry.tag}`);
	}

	return digest;
}

// SQLite reports an additive change that is already in place with one of these.
// Skipping it lets `addColumnIfMissing` run on every start, and lets a store
// whose rows are a valid prefix but whose schema already holds a later object
// converge.
function isAlreadyApplied(error: unknown): boolean {
	return causeMessages(error).some(
		(message) =>
			/already exists/i.test(message) || /duplicate column name/i.test(message)
	);
}

type MigrationDatabase<TSchema extends Record<string, unknown>> =
	DrizzleSqliteDODatabase<TSchema>;

/**
 * How much a recorded digest proves. `verified` rows were written with the
 * digest of the SQL the store ran. `unverified-baseline` rows were written
 * before digests were recorded; their digest was adopted from the bundle
 * afterwards.
 */
type VerificationState = 'verified' | 'unverified-baseline';

interface TrackingRow {
	// `id` is declared `SERIAL PRIMARY KEY`, which SQLite does not treat as a
	// rowid alias, so rows Drizzle inserted have a NULL `id`. `rowid` is the key
	// every row has.
	readonly rowId: number;
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
			`SELECT rowid, hash, created_at, digest, verification_state FROM ${trackingTable} ORDER BY created_at, id`
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
			rowId: Number(row[0]),
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
	expectedDigest: string
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

	if (row.digest !== undefined && row.digest !== expectedDigest) {
		throw new DurableObjectMigrationDigestError(
			entry.tag,
			expectedDigest,
			row.digest
		);
	}
}

/**
 * Refuses a store whose recorded history this build cannot continue, and
 * returns the recorded rows once they are accepted.
 *
 * The recorded rows must be a prefix of the bundled journal: same order, same
 * timestamps, and either the stable tag or the legacy empty hash that Drizzle
 * wrote at index 0024 and earlier. A row this migrator verified must carry its
 * tag, and a recorded digest must match the SQL this build ships.
 *
 * Rows beyond the bundle are migrations a newer build applied before this one
 * ran, which a rollback leaves behind. They are admitted only when that build
 * recorded them as verified, with the digest it applied; without that there is
 * no evidence of what the schema now contains.
 *
 * An empty journal over existing application tables is refused on every
 * admission: the store was migrated by something that kept no record, so no
 * journal position describes its schema.
 */
export async function admitMigrationSource<
	TSchema extends Record<string, unknown>
>(
	database: MigrationDatabase<TSchema>,
	bundle: MigrationBundle
): Promise<TrackingRow[]> {
	return admit(database, bundle, await digestsOf(bundle));
}

function admit<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	bundle: MigrationBundle,
	digests: MigrationDigests
): TrackingRow[] {
	const rows = readTracking(database);

	if (rows.length === 0) {
		if (hasSchemaTables(database)) {
			throw new DurableObjectMigrationJournalError(
				'missing-journal',
				'the journal is empty but application tables already exist'
			);
		}

		return rows;
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

		assertRowMatchesEntry(row, entry, digestOf(digests, entry));
	}

	return rows;
}

// Digest and state are written together: `readTracking` stamps `verified` on
// any row that has a digest and no state, so a digest written first would be
// relabelled as verified on the next start.
function adoptBaselineDigest<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	row: TrackingRow,
	digest: string
): void {
	const verificationState: VerificationState = 'unverified-baseline';

	database.run(
		sql`UPDATE ${sql.identifier(trackingTable)} SET digest = ${digest}, verification_state = ${verificationState} WHERE rowid = ${row.rowId}`
	);
}

function applyMigration<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	entry: JournalEntry,
	statements: readonly string[],
	digest: string
): void {
	const verificationState: VerificationState = 'verified';

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
			sql`INSERT INTO ${sql.identifier(trackingTable)} (hash, created_at, digest, verification_state) VALUES (${entry.tag}, ${entry.when}, ${digest}, ${verificationState})`
		);
	});
}

/**
 * Brings a Durable Object's SQLite schema up to the bundled migrations, after
 * {@link admitMigrationSource} has accepted the store's recorded history.
 *
 * A migration whose tag is already recorded is skipped. A recorded row with no
 * digest adopts the bundled SQL's digest as an unverified baseline, so a later
 * edit to that migration is refused. Each migration still to run executes in
 * its own transaction and records the digest it was applied from, so a later
 * build can tell what this store actually ran.
 */
export async function applyMigrations<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	bundle: MigrationBundle
): Promise<void> {
	const digests = await digestsOf(bundle);
	const rows = admit(database, bundle, digests);
	const entries = bundle.journal.entries.toSorted((a, b) => a.idx - b.idx);

	// Admission proved the recorded rows are a prefix of the journal, so each
	// row pairs with the entry at its position and the migrations still to run
	// are the entries past them.
	for (const [index, row] of rows.entries()) {
		const entry = entries[index];

		if (entry === undefined || row.digest !== undefined) {
			continue;
		}

		adoptBaselineDigest(database, row, digestOf(digests, entry));
	}

	for (const entry of entries.slice(rows.length)) {
		applyMigration(
			database,
			entry,
			statementsOf(bundle, entry),
			digestOf(digests, entry)
		);
	}
}
