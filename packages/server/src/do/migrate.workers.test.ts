import { runInDurableObject } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import migrations from '../../drizzle/migrations.js';
import {
	latestPreContractMigrationIndex,
	migrateThrough,
	testServerFor
} from '../test-support.ts';

import {
	applyMigrations,
	DurableObjectMigrationError,
	type MigrationBundle,
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
	latestPreContractMigrationIndex
);
const everyTag = preContractMigrations.journal.entries
	.toSorted((a, b) => a.idx - b.idx)
	.map((entry) => entry.tag);

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
				await migrateThrough(state, latestPreContractMigrationIndex);

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

	it('converges a store whose schema already holds an unrecorded change', async () => {
		// A Durable Object initialised by a divergent build can carry a later
		// migration's objects without that migration recorded. Dropping the record
		// of a migration whose objects remain reproduces that: re-running it must
		// skip the change that is already present and converge cleanly.
		const result = await runInDurableObject(
			testServerFor('migrate-diverged'),
			async (_instance, state) => {
				await migrateThrough(state, 22);

				const database = drizzle(state.storage);
				database.run(
					sql.raw(
						"DELETE FROM __drizzle_migrations WHERE hash = '0022_maintenance_indexes'"
					)
				);

				applyMigrations(database, preContractMigrations);

				return {
					tags: appliedTags(state.storage),
					pendingUploadColumns: columnNames(state.storage, 'pending_upload')
				};
			}
		);

		expect(result.tags).toStrictEqual(everyTag);
		expect(result.pendingUploadColumns).toContain('session_id');
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
