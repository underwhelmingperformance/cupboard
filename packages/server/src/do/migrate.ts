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

export type MigrationDigests = ReadonlyMap<string, string>;

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
const runtimeAdoptionTable = '__cupboard_runtime_adoption';
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

export class DurableObjectMigrationSourceMissingError extends Error {
	constructor(public readonly tag: string) {
		super(`Missing migration SQL for ${tag}`);
		this.name = 'DurableObjectMigrationSourceMissingError';
	}
}

export function migrationsThroughTag(
	bundle: MigrationBundle,
	throughTag: string
): MigrationBundle {
	const entry = bundle.journal.entries.find(
		(candidate) => candidate.tag === throughTag
	);

	if (entry === undefined) {
		throw new DurableObjectMigrationSourceMissingError(throughTag);
	}

	return migrationsThrough(bundle, entry.idx);
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
		throw new DurableObjectMigrationSourceMissingError(entry.tag);
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
	readonly rows: readonly TrackingRow[];
}

interface TrackingRow {
	readonly hash: string;
	readonly when: number;
	readonly digest: string | undefined;
	readonly verificationState: 'verified' | 'unverified-baseline';
}

function readTracking<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>
): TrackingState {
	database.run(
		sql.raw(
			`CREATE TABLE IF NOT EXISTS ${trackingTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
		)
	);
	try {
		database.run(
			sql.raw(`ALTER TABLE ${trackingTable} ADD COLUMN digest text`)
		);
	} catch (error) {
		if (!isAlreadyApplied(error)) {
			throw error;
		}
	}
	try {
		database.run(
			sql.raw(`ALTER TABLE ${trackingTable} ADD COLUMN verification_state text`)
		);
	} catch (error) {
		if (!isAlreadyApplied(error)) {
			throw error;
		}
	}
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

	return {
		rows: rows.map((row) => {
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
		})
	};
}

function hasExistingDurableObjectTables<
	TSchema extends Record<string, unknown>
>(database: MigrationDatabase<TSchema>): boolean {
	return (
		database.values(
			sql.raw(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table'
				   AND name NOT LIKE 'sqlite_%'
				   AND name NOT IN ('${trackingTable}', '${runtimeAdoptionTable}')
				 LIMIT 1`
			)
		).length > 0
	);
}

export function hasAppliedMigrationAfter<
	TSchema extends Record<string, unknown>
>(
	database: MigrationDatabase<TSchema>,
	bundle: MigrationBundle,
	afterIndex: number
): boolean {
	const tracking = readTracking(database);
	const entries = bundle.journal.entries.toSorted((a, b) => a.idx - b.idx);
	assertJournalPrefix(tracking, entries, new Map());

	return tracking.rows.some((_row, index) => {
		const entry = entries[index];

		return entry !== undefined && entry.idx > afterIndex;
	});
}

function applyMigration<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	entry: JournalEntry,
	statements: readonly string[],
	digest: string | undefined
): void {
	const storedDigest = digest ?? sql.raw('NULL');
	const verificationState =
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

export class DurableObjectMigrationCeilingError extends Error {
	constructor(public readonly tag: string) {
		super(
			`Durable Object migration ${tag} exceeds the configured runtime ceiling`
		);
		this.name = 'DurableObjectMigrationCeilingError';
	}
}

export class DurableObjectMigrationVerificationStateError extends Error {
	constructor(
		public readonly tag: string,
		public readonly verificationState: string
	) {
		super(
			`Durable Object migration ${tag} has unknown verification state ${verificationState}`
		);
		this.name = 'DurableObjectMigrationVerificationStateError';
	}
}

export class DurableObjectMigrationJournalError extends Error {
	constructor(
		public readonly tag: string,
		public readonly detail: string
	) {
		super(`Durable Object migration journal is invalid at ${tag}: ${detail}`);
		this.name = 'DurableObjectMigrationJournalError';
	}
}

function assertJournalPrefix(
	tracking: TrackingState,
	entries: readonly JournalEntry[],
	digests: MigrationDigests,
	options: { readonly allowSuccessors?: boolean } = {}
): void {
	if (
		tracking.rows.length > entries.length &&
		options.allowSuccessors !== true
	) {
		const successor = tracking.rows[entries.length];

		throw new DurableObjectMigrationCeilingError(
			successor?.hash === undefined || successor.hash === ''
				? 'unknown-migration'
				: successor.hash
		);
	}

	for (const [index, row] of tracking.rows.slice(0, entries.length).entries()) {
		const expected = entries[index];

		if (expected === undefined) {
			throw new DurableObjectMigrationCeilingError(
				row.hash === '' ? 'unknown-migration' : row.hash
			);
		}

		if (!Number.isFinite(row.when) || row.when !== expected.when) {
			throw new DurableObjectMigrationJournalError(
				expected.tag,
				`recorded timestamp ${String(row.when)} does not equal ${String(expected.when)}`
			);
		}

		if (row.hash !== '' && row.hash !== expected.tag) {
			throw new DurableObjectMigrationJournalError(
				expected.tag,
				`recorded tag ${row.hash} is neither the stable tag nor the legacy empty hash`
			);
		}

		if (row.hash === '' && expected.idx > lastLegacyDrizzleMigrationIndex) {
			throw new DurableObjectMigrationJournalError(
				expected.tag,
				'the legacy empty hash is not valid after the Drizzle migration boundary'
			);
		}

		if (row.verificationState === 'verified' && row.hash !== expected.tag) {
			throw new DurableObjectMigrationJournalError(
				expected.tag,
				'a verified migration must use its stable tag'
			);
		}

		const expectedDigest = digests.get(expected.tag);

		if (
			expectedDigest !== undefined &&
			row.digest !== undefined &&
			row.digest !== expectedDigest
		) {
			throw new DurableObjectMigrationDigestError(
				expected.tag,
				expectedDigest,
				row.digest
			);
		}
	}
}

export function assertMigrationCeiling<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	bundle: MigrationBundle,
	digests: MigrationDigests
): void {
	const entries = bundle.journal.entries.toSorted((a, b) => a.idx - b.idx);
	assertJournalPrefix(readTracking(database), entries, digests);
}

function assertMigrationSource<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	bundle: MigrationBundle,
	digests: MigrationDigests
): void {
	const tracking = readTracking(database);

	if (tracking.rows.length === 0) {
		assertJournalPresence(database);
		return;
	}

	const entries = bundle.journal.entries.toSorted((a, b) => a.idx - b.idx);

	assertJournalPrefix(tracking, entries, digests);
}

function assertJournalPresence<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>
): void {
	if (
		readTracking(database).rows.length === 0 &&
		hasExistingDurableObjectTables(database)
	) {
		throw new DurableObjectMigrationJournalError(
			'missing-journal',
			'the journal is empty but application tables already exist'
		);
	}
}

export function admitMigrationSource<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	sourceBundle: MigrationBundle,
	runtimeBundle: MigrationBundle,
	digests: MigrationDigests,
	adoptionId: string
): void {
	database.run(
		sql.raw(
			`CREATE TABLE IF NOT EXISTS ${runtimeAdoptionTable} (id text PRIMARY KEY)`
		)
	);
	assertJournalPresence(database);
	const isAdopted =
		database.values(
			sql`SELECT id FROM ${sql.identifier(runtimeAdoptionTable)} WHERE id = ${adoptionId}`
		).length > 0;

	if (!isAdopted) {
		assertMigrationSource(database, sourceBundle, digests);
		database.run(
			sql`INSERT INTO ${sql.identifier(runtimeAdoptionTable)} (id) VALUES (${adoptionId})`
		);
	}

	assertMigrationCeiling(database, runtimeBundle, digests);
}

/**
 * Brings a Durable Object's SQLite schema up to the bundled migrations.
 *
 * A migration is skipped only when the journal contains its exact position.
 * Historical Drizzle rows through migration 0024 use their original timestamp
 * and empty hash. Each migration runs in its own transaction, and an unexpected
 * statement failure retains its cause.
 */
export function applyMigrations<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	bundle: MigrationBundle,
	digests?: MigrationDigests,
	options: { readonly enforceCeiling?: boolean } = {}
): void {
	if (digests !== undefined && options.enforceCeiling !== false) {
		assertMigrationCeiling(database, bundle, digests);
	}

	const entries = bundle.journal.entries.toSorted((a, b) => a.idx - b.idx);
	const tracking = readTracking(database);
	assertJournalPrefix(tracking, entries, digests ?? new Map(), {
		allowSuccessors: options.enforceCeiling === false
	});

	for (const [index, entry] of entries.entries()) {
		const expectedDigest = digests?.get(entry.tag);
		const applied = tracking.rows[index];

		if (applied !== undefined) {
			if (
				expectedDigest !== undefined &&
				applied.digest === undefined &&
				applied.verificationState === 'unverified-baseline'
			) {
				database.run(
					sql`UPDATE ${sql.identifier(trackingTable)} SET digest = ${expectedDigest} WHERE created_at = ${entry.when} AND hash = ${applied.hash} AND digest IS NULL AND verification_state = 'unverified-baseline'`
				);
			}

			continue;
		}

		applyMigration(
			database,
			entry,
			statementsOf(bundle, entry),
			expectedDigest
		);
	}
}
