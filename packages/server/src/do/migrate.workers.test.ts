import { runInDurableObject } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import migrations from '../../drizzle/migrations.js';
import {
	latestMigrationIndex,
	migrateThrough,
	testServerFor
} from '../test-support.ts';

import {
	admitMigrationSource,
	applyMigrations,
	DurableObjectMigrationError,
	DurableObjectMigrationJournalError,
	type MigrationBundle,
	type MigrationDigests,
	migrationsThrough
} from './migrate.ts';

type Storage = DurableObjectState['storage'];

const column = (storage: Storage, query: string): string[] =>
	drizzle(storage)
		.values(sql.raw(query))
		.map((row) => String(row[0]));

const appliedTags = (storage: Storage): string[] =>
	column(storage, 'SELECT hash FROM __drizzle_migrations ORDER BY created_at');

const tableNames = (storage: Storage): string[] =>
	column(
		storage,
		String.raw`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\_\_%' ESCAPE '\' ORDER BY name`
	);

const columnNames = (storage: Storage, table: string): string[] =>
	drizzle(storage)
		.values(sql.raw(`PRAGMA table_info(${table})`))
		.map((row) => String(row[1]));

const preContractMigrations = migrationsThrough(
	migrations,
	latestMigrationIndex
);
const everyTag = preContractMigrations.journal.entries
	.toSorted((a, b) => a.idx - b.idx)
	.map((entry) => entry.tag);

/**
 * Writes a tracking row directly, so a test can put the store in a state no
 * current build produces: a Drizzle-era empty hash, a tag this build does not
 * carry, or a digest that no longer matches.
 */
function recordTrackingRow(
	storage: Storage,
	row: {
		hash: string;
		when: number;
		digest?: string;
		verificationState?: string;
	}
): void {
	const database = drizzle(storage);
	database.run(
		sql.raw(
			'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric, digest text, verification_state text)'
		)
	);
	database.run(
		sql`INSERT INTO __drizzle_migrations (hash, created_at, digest, verification_state) VALUES (${row.hash}, ${row.when}, ${row.digest ?? sql.raw('NULL')}, ${row.verificationState ?? sql.raw('NULL')})`
	);
}

describe('applyMigrations', () => {
	it('applies every migration and records each by tag on a fresh store', async () => {
		const tags = await runInDurableObject(
			testServerFor('migrate-fresh'),
			(_instance, state) => {
				applyMigrations(drizzle(state.storage), preContractMigrations);

				return appliedTags(state.storage);
			}
		);

		expect(tags).toStrictEqual(everyTag);
	});

	it('is a no-op when every migration is already applied', async () => {
		const result = await runInDurableObject(
			testServerFor('migrate-idempotent'),
			async (_instance, state) => {
				await migrateThrough(state, latestMigrationIndex);

				const tablesBefore = tableNames(state.storage);

				applyMigrations(drizzle(state.storage), preContractMigrations);

				return {
					tags: appliedTags(state.storage),
					tablesBefore,
					tablesAfter: tableNames(state.storage)
				};
			}
		);

		expect(result).toStrictEqual({
			tags: everyTag,
			tablesBefore: result.tablesBefore,
			tablesAfter: result.tablesBefore
		});
	});

	it('brings a store that slept at an earlier migration up to date', async () => {
		const result = await runInDurableObject(
			testServerFor('migrate-sleeping'),
			async (_instance, state) => {
				await migrateThrough(state, 22);

				applyMigrations(drizzle(state.storage), preContractMigrations);

				return {
					tags: appliedTags(state.storage),
					pendingUploadColumns: columnNames(state.storage, 'pending_upload')
				};
			}
		);

		expect(result.tags).toStrictEqual(everyTag);
		expect(result.pendingUploadColumns).toContain('session_id');
	});

	it('refuses a store whose journal has a gap', async () => {
		// A missing record means something changed the schema without recording
		// it, so the remaining records no longer say which migrations ran.
		const outcome = await runInDurableObject(
			testServerFor('migrate-gap'),
			async (_instance, state) => {
				await migrateThrough(state, 24);

				const database = drizzle(state.storage);
				database.run(
					sql.raw(
						"DELETE FROM __drizzle_migrations WHERE hash = '0022_maintenance_indexes'"
					)
				);

				try {
					applyMigrations(database, migrations);
					return { threw: false as const };
				} catch (error) {
					return {
						threw: true as const,
						isJournalError: error instanceof DurableObjectMigrationJournalError
					};
				}
			}
		);

		expect(outcome).toStrictEqual({ threw: true, isJournalError: true });
	});

	it('raises the underlying cause when a statement genuinely fails', async () => {
		const bundle: MigrationBundle = {
			journal: {
				entries: [
					{ idx: 0, when: 1, tag: '0000_widget' },
					{ idx: 1, when: 2, tag: '0001_bad_index' }
				]
			},
			migrations: {
				m0000: 'CREATE TABLE widget (id text PRIMARY KEY);',
				m0001: 'CREATE INDEX widget_missing_idx ON widget (nope);'
			}
		};

		const outcome = await runInDurableObject(
			testServerFor('migrate-genuine-failure'),
			(_instance, state) => {
				try {
					applyMigrations(drizzle(state.storage), bundle);
					return { threw: false as const };
				} catch (error) {
					return {
						threw: true as const,
						isMigrationError: error instanceof DurableObjectMigrationError,
						tag:
							error instanceof DurableObjectMigrationError
								? error.tag
								: undefined,
						// The first migration committed before the second failed.
						applied: appliedTags(state.storage),
						tables: tableNames(state.storage)
					};
				}
			}
		);

		expect(outcome).toStrictEqual({
			threw: true,
			isMigrationError: true,
			tag: '0001_bad_index',
			applied: ['0000_widget'],
			tables: ['widget']
		});
	});
});

describe('admitMigrationSource', () => {
	const bundle: MigrationBundle = {
		journal: {
			entries: [
				{ idx: 0, when: 1, tag: '0000_widget' },
				{ idx: 1, when: 2, tag: '0001_gadget' }
			]
		},
		migrations: {
			m0000: 'CREATE TABLE widget (id text PRIMARY KEY);',
			m0001: 'CREATE TABLE gadget (id text PRIMARY KEY);'
		}
	};
	const digests: MigrationDigests = new Map([
		['0000_widget', 'digest-0000'],
		['0001_gadget', 'digest-0001']
	]);

	function admissionOf(
		storage: Storage,
		source: MigrationBundle = bundle
	): { refused: boolean; error: string | undefined } {
		try {
			admitMigrationSource(drizzle(storage), source, digests);
			return { refused: false, error: undefined };
		} catch (error) {
			return {
				refused: true,
				error: error instanceof Error ? error.name : String(error)
			};
		}
	}

	it('admits a store with no journal and no application tables', async () => {
		const outcome = await runInDurableObject(
			testServerFor('admit-empty'),
			(_instance, state) => admissionOf(state.storage)
		);

		expect(outcome).toStrictEqual({ refused: false, error: undefined });
	});

	it('refuses an empty journal over application tables', async () => {
		const outcome = await runInDurableObject(
			testServerFor('admit-unrecorded-schema'),
			(_instance, state) => {
				drizzle(state.storage).run(
					sql.raw('CREATE TABLE widget (id text PRIMARY KEY)')
				);

				return admissionOf(state.storage);
			}
		);

		expect(outcome).toStrictEqual({
			refused: true,
			error: 'DurableObjectMigrationJournalError'
		});
	});

	it('refuses a recorded tag this build does not carry at that position', async () => {
		const outcome = await runInDurableObject(
			testServerFor('admit-unknown-tag'),
			(_instance, state) => {
				recordTrackingRow(state.storage, { hash: '0000_sprocket', when: 1 });

				return admissionOf(state.storage);
			}
		);

		expect(outcome).toStrictEqual({
			refused: true,
			error: 'DurableObjectMigrationJournalError'
		});
	});

	it('accepts the legacy empty hash below the Drizzle boundary', async () => {
		const outcome = await runInDurableObject(
			testServerFor('admit-legacy-hash'),
			(_instance, state) => {
				recordTrackingRow(state.storage, { hash: '', when: 1 });

				return admissionOf(state.storage);
			}
		);

		expect(outcome).toStrictEqual({ refused: false, error: undefined });
	});

	it('refuses the legacy empty hash above the Drizzle boundary', async () => {
		const lateBundle: MigrationBundle = {
			journal: { entries: [{ idx: 25, when: 1, tag: '0025_late' }] },
			migrations: { m0025: 'CREATE TABLE late (id text PRIMARY KEY);' }
		};

		const outcome = await runInDurableObject(
			testServerFor('admit-late-legacy-hash'),
			(_instance, state) => {
				recordTrackingRow(state.storage, { hash: '', when: 1 });

				return admissionOf(state.storage, lateBundle);
			}
		);

		expect(outcome).toStrictEqual({
			refused: true,
			error: 'DurableObjectMigrationJournalError'
		});
	});

	it('refuses a recorded digest that no longer matches the migration', async () => {
		const outcome = await runInDurableObject(
			testServerFor('admit-digest-drift'),
			(_instance, state) => {
				recordTrackingRow(state.storage, {
					hash: '0000_widget',
					when: 1,
					digest: 'digest-from-an-older-file',
					verificationState: 'verified'
				});

				return admissionOf(state.storage);
			}
		);

		expect(outcome).toStrictEqual({
			refused: true,
			error: 'DurableObjectMigrationDigestError'
		});
	});

	it('admits verified migrations a newer build applied before this one woke', async () => {
		const outcome = await runInDurableObject(
			testServerFor('admit-verified-successor'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				applyMigrations(database, bundle, digests);
				recordTrackingRow(state.storage, {
					hash: '0002_from_a_newer_build',
					when: 3,
					digest: 'digest-0002',
					verificationState: 'verified'
				});

				return admissionOf(state.storage);
			}
		);

		expect(outcome).toStrictEqual({ refused: false, error: undefined });
	});

	it('refuses an unverified migration beyond the ones this build carries', async () => {
		const outcome = await runInDurableObject(
			testServerFor('admit-unverified-successor'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				applyMigrations(database, bundle, digests);
				recordTrackingRow(state.storage, { hash: '0002_unrecorded', when: 3 });

				return admissionOf(state.storage);
			}
		);

		expect(outcome).toStrictEqual({
			refused: true,
			error: 'DurableObjectMigrationJournalError'
		});
	});
});
