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
	admitMigrationSource,
	applyMigrations,
	assertMigrationCeiling,
	DurableObjectMigrationCeilingError,
	DurableObjectMigrationDigestError,
	DurableObjectMigrationError,
	DurableObjectMigrationJournalError,
	DurableObjectMigrationVerificationStateError,
	hasAppliedMigrationAfter,
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
		const result = await runInDurableObject(
			testServerFor('migrate-fresh'),
			(_instance, state) => {
				applyMigrations(drizzle(state.storage), preContractMigrations);

				return {
					tags: appliedTags(state.storage),
					pendingUploadColumns: columnNames(state.storage, 'pending_upload')
				};
			}
		);

		expect(result.tags).toStrictEqual(everyTag);
		expect(result.pendingUploadColumns).toContain('writer_epoch');
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

	it('refuses changed SQL beneath an applied migration tag', async () => {
		const bundle: MigrationBundle = {
			journal: { entries: [{ idx: 0, when: 1, tag: '0000_expand' }] },
			migrations: { m0000: 'CREATE TABLE expanded (id text PRIMARY KEY);' }
		};
		const outcome = await runInDurableObject(
			testServerFor('migrate-digest-mismatch'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				applyMigrations(database, bundle, new Map([['0000_expand', 'first']]));

				try {
					applyMigrations(
						database,
						bundle,
						new Map([['0000_expand', 'changed']])
					);
					return { threw: false };
				} catch (error) {
					return {
						threw: true,
						isDigestError: error instanceof DurableObjectMigrationDigestError,
						tag:
							error instanceof DurableObjectMigrationDigestError
								? error.tag
								: undefined
					};
				}
			}
		);

		expect(outcome).toStrictEqual({
			threw: true,
			isDigestError: true,
			tag: '0000_expand'
		});
	});

	it('refuses a store which has advanced beyond the runtime ceiling', async () => {
		const bundle: MigrationBundle = {
			journal: {
				entries: [
					{ idx: 0, when: 1, tag: '0000_expand' },
					{ idx: 1, when: 2, tag: '0001_contract' }
				]
			},
			migrations: {
				m0000: 'CREATE TABLE expanded (id text PRIMARY KEY);',
				m0001: 'CREATE TABLE contracted (id text PRIMARY KEY);'
			}
		};
		const digests = new Map([
			['0000_expand', 'expand'],
			['0001_contract', 'contract']
		]);
		const outcome = await runInDurableObject(
			testServerFor('migrate-runtime-ceiling'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				applyMigrations(database, bundle, digests);

				try {
					applyMigrations(database, migrationsThrough(bundle, 0), digests);
					return { threw: false };
				} catch (error) {
					return {
						threw: true,
						isCeilingError: error instanceof DurableObjectMigrationCeilingError,
						tag:
							error instanceof DurableObjectMigrationCeilingError
								? error.tag
								: undefined
					};
				}
			}
		);

		expect(outcome).toStrictEqual({
			threw: true,
			isCeilingError: true,
			tag: '0001_contract'
		});
	});

	it('refuses a verified successor tag which is absent from the runtime', async () => {
		const current: MigrationBundle = {
			journal: { entries: [{ idx: 0, when: 1, tag: '0000_expand' }] },
			migrations: { m0000: 'CREATE TABLE expanded (id text PRIMARY KEY);' }
		};
		const successor: MigrationBundle = {
			journal: {
				entries: [
					...current.journal.entries,
					{ idx: 1, when: 2, tag: '0001_successor' }
				]
			},
			migrations: {
				...current.migrations,
				m0001: 'CREATE TABLE successor (id text PRIMARY KEY);'
			}
		};
		const outcome = await runInDurableObject(
			testServerFor('migrate-unknown-successor-ceiling'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				applyMigrations(
					database,
					successor,
					new Map([
						['0000_expand', 'expand'],
						['0001_successor', 'successor']
					])
				);

				try {
					assertMigrationCeiling(
						database,
						current,
						new Map([['0000_expand', 'expand']])
					);
					return { threw: false };
				} catch (error) {
					return {
						threw: true,
						isCeilingError: error instanceof DurableObjectMigrationCeilingError,
						tag:
							error instanceof DurableObjectMigrationCeilingError
								? error.tag
								: undefined
					};
				}
			}
		);

		expect(outcome).toStrictEqual({
			threw: true,
			isCeilingError: true,
			tag: '0001_successor'
		});
	});

	it.each([
		{
			id: 'missing',
			name: 'a missing predecessor row',
			rows: [
				{ hash: '', when: 1 },
				{ hash: '', when: 3 }
			]
		},
		{
			id: 'duplicate',
			name: 'a duplicate predecessor row',
			rows: [
				{ hash: '', when: 1 },
				{ hash: '', when: 1 },
				{ hash: '', when: 2 }
			]
		},
		{
			id: 'unknown',
			name: 'an unknown predecessor tag',
			rows: [
				{ hash: 'unknown', when: 1 },
				{ hash: '', when: 2 }
			]
		}
	])('refuses source admission with $name', async ({ id, rows }) => {
		const bundle: MigrationBundle = {
			journal: {
				entries: [
					{ idx: 0, when: 1, tag: '0000_expand' },
					{ idx: 1, when: 2, tag: '0001_backfill' },
					{ idx: 2, when: 3, tag: '0002_contract' }
				]
			},
			migrations: {
				m0000: 'CREATE TABLE expanded (id text PRIMARY KEY);',
				m0001: 'CREATE TABLE backfilled (id text PRIMARY KEY);',
				m0002: 'CREATE TABLE contracted (id text PRIMARY KEY);'
			}
		};
		const outcome = await runInDurableObject(
			testServerFor(`migrate-invalid-source-${id}`),
			(_instance, state) => {
				const database = drizzle(state.storage);
				database.run(
					sql.raw(
						'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)'
					)
				);

				for (const row of rows) {
					database.run(
						sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${row.hash}, ${row.when})`
					);
				}

				try {
					admitMigrationSource(
						database,
						bundle,
						bundle,
						new Map(),
						'cache-lifecycle-v1'
					);
					return { threw: false };
				} catch (error) {
					return {
						threw: true,
						isJournalError: error instanceof DurableObjectMigrationJournalError
					};
				}
			}
		);

		expect(outcome).toStrictEqual({ threw: true, isJournalError: true });
	});

	it('accepts a contiguous sleeping predecessor journal', async () => {
		const bundle: MigrationBundle = {
			journal: {
				entries: [
					{ idx: 0, when: 1, tag: '0000_expand' },
					{ idx: 1, when: 2, tag: '0001_backfill' },
					{ idx: 2, when: 3, tag: '0002_contract' }
				]
			},
			migrations: {
				m0000: 'CREATE TABLE expanded (id text PRIMARY KEY);',
				m0001: 'CREATE TABLE backfilled (id text PRIMARY KEY);',
				m0002: 'CREATE TABLE contracted (id text PRIMARY KEY);'
			}
		};
		const outcome = await runInDurableObject(
			testServerFor('migrate-sleeping-source'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				database.run(
					sql.raw(
						'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)'
					)
				);
				for (const row of [
					{ hash: '', when: 1 },
					{ hash: '', when: 2 }
				]) {
					database.run(
						sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${row.hash}, ${row.when})`
					);
				}

				admitMigrationSource(
					database,
					bundle,
					bundle,
					new Map(),
					'cache-lifecycle-v1'
				);
				applyMigrations(database, bundle, undefined, {
					enforceCeiling: false
				});

				return appliedTags(state.storage);
			}
		);

		expect(outcome).toStrictEqual(['', '', '0002_contract']);
	});

	it('refuses an empty journal when application tables exist', async () => {
		const bundle: MigrationBundle = {
			journal: { entries: [{ idx: 0, when: 1, tag: '0000_expand' }] },
			migrations: { m0000: 'CREATE TABLE expanded (id text PRIMARY KEY);' }
		};
		const outcome = await runInDurableObject(
			testServerFor('migrate-missing-journal'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				database.run(sql.raw('CREATE TABLE cache (id text PRIMARY KEY)'));

				try {
					admitMigrationSource(
						database,
						bundle,
						bundle,
						new Map(),
						'cache-lifecycle-v1'
					);
					return { threw: false };
				} catch (error) {
					return {
						threw: true,
						isJournalError: error instanceof DurableObjectMigrationJournalError,
						tag:
							error instanceof DurableObjectMigrationJournalError
								? error.tag
								: undefined
					};
				}
			}
		);

		expect(outcome).toStrictEqual({
			threw: true,
			isJournalError: true,
			tag: 'missing-journal'
		});
	});

	it('refuses an empty journal over an adopted application schema', async () => {
		const bundle: MigrationBundle = {
			journal: { entries: [{ idx: 0, when: 1, tag: '0000_expand' }] },
			migrations: { m0000: 'CREATE TABLE expanded (id text PRIMARY KEY);' }
		};
		const outcome = await runInDurableObject(
			testServerFor('migrate-adopted-missing-journal'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				database.run(sql.raw('CREATE TABLE cache (id text PRIMARY KEY)'));
				database.run(
					sql.raw(
						'CREATE TABLE __cupboard_runtime_adoption (id text PRIMARY KEY)'
					)
				);
				database.run(
					sql.raw(
						"INSERT INTO __cupboard_runtime_adoption (id) VALUES ('cache-lifecycle-v1')"
					)
				);

				try {
					admitMigrationSource(
						database,
						bundle,
						bundle,
						new Map(),
						'cache-lifecycle-v1'
					);
					return { threw: false };
				} catch (error) {
					return {
						threw: true,
						isJournalError: error instanceof DurableObjectMigrationJournalError,
						tag:
							error instanceof DurableObjectMigrationJournalError
								? error.tag
								: undefined
					};
				}
			}
		);

		expect(outcome).toStrictEqual({
			threw: true,
			isJournalError: true,
			tag: 'missing-journal'
		});
	});

	it('refuses a legacy empty hash after the Drizzle migration boundary', async () => {
		const bundle: MigrationBundle = {
			journal: { entries: [{ idx: 25, when: 1, tag: '0025_stable' }] },
			migrations: { m0025: 'CREATE TABLE stable (id text PRIMARY KEY);' }
		};
		const outcome = await runInDurableObject(
			testServerFor('migrate-late-empty-hash'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				database.run(
					sql.raw(
						'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)'
					)
				);
				database.run(
					sql.raw(
						"INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', 1)"
					)
				);

				try {
					admitMigrationSource(
						database,
						bundle,
						bundle,
						new Map(),
						'cache-lifecycle-v1'
					);
					return { threw: false };
				} catch (error) {
					return {
						threw: true,
						isJournalError: error instanceof DurableObjectMigrationJournalError
					};
				}
			}
		);

		expect(outcome).toStrictEqual({ threw: true, isJournalError: true });
	});

	it('allows an additive pass after validating a later runtime ceiling', async () => {
		const bundle: MigrationBundle = {
			journal: {
				entries: [
					{ idx: 0, when: 1, tag: '0000_expand' },
					{ idx: 1, when: 2, tag: '0001_contract' }
				]
			},
			migrations: {
				m0000: 'CREATE TABLE expanded (id text PRIMARY KEY);',
				m0001: 'CREATE TABLE contracted (id text PRIMARY KEY);'
			}
		};
		const digests = new Map([
			['0000_expand', 'expand'],
			['0001_contract', 'contract']
		]);
		const outcome = await runInDurableObject(
			testServerFor('migrate-later-runtime-restart'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				applyMigrations(database, bundle, digests);
				assertMigrationCeiling(database, bundle, digests);
				applyMigrations(database, migrationsThrough(bundle, 0), digests, {
					enforceCeiling: false
				});

				return appliedTags(state.storage);
			}
		);

		expect(outcome).toStrictEqual(['0000_expand', '0001_contract']);
	});

	it('records source admission before applying additive migrations', async () => {
		const bundle: MigrationBundle = {
			journal: {
				entries: [
					{ idx: 0, when: 1, tag: '0000_predecessor' },
					{ idx: 1, when: 2, tag: '0001_additive' }
				]
			},
			migrations: {
				m0000: 'CREATE TABLE predecessor (id text PRIMARY KEY);',
				m0001: 'CREATE TABLE additive (id text PRIMARY KEY);'
			}
		};
		const digests = new Map([
			['0000_predecessor', 'predecessor'],
			['0001_additive', 'additive']
		]);
		const outcome = await runInDurableObject(
			testServerFor('migrate-source-adoption'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				applyMigrations(database, migrationsThrough(bundle, 0), digests);
				admitMigrationSource(
					database,
					migrationsThrough(bundle, 0),
					bundle,
					digests,
					'cache-lifecycle-v1'
				);
				applyMigrations(database, bundle, digests, {
					enforceCeiling: false
				});
				admitMigrationSource(
					database,
					migrationsThrough(bundle, 0),
					bundle,
					digests,
					'cache-lifecycle-v1'
				);

				return appliedTags(state.storage);
			}
		);

		expect(outcome).toStrictEqual(['0000_predecessor', '0001_additive']);
	});

	it('refuses source admission after a successor migration was applied', async () => {
		const bundle: MigrationBundle = {
			journal: {
				entries: [
					{ idx: 0, when: 1, tag: '0000_predecessor' },
					{ idx: 1, when: 2, tag: '0001_successor' }
				]
			},
			migrations: {
				m0000: 'CREATE TABLE predecessor (id text PRIMARY KEY);',
				m0001: 'CREATE TABLE successor (id text PRIMARY KEY);'
			}
		};
		const digests = new Map([
			['0000_predecessor', 'predecessor'],
			['0001_successor', 'successor']
		]);
		const outcome = await runInDurableObject(
			testServerFor('migrate-source-admission-successor'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				applyMigrations(database, bundle, digests);

				try {
					admitMigrationSource(
						database,
						migrationsThrough(bundle, 0),
						bundle,
						digests,
						'cache-lifecycle-v1'
					);
					return { threw: false };
				} catch (error) {
					return {
						threw: true,
						isCeilingError: error instanceof DurableObjectMigrationCeilingError,
						tag:
							error instanceof DurableObjectMigrationCeilingError
								? error.tag
								: undefined
					};
				}
			}
		);

		expect(outcome).toStrictEqual({
			threw: true,
			isCeilingError: true,
			tag: '0001_successor'
		});
	});

	it('records and enforces a digest for an inferred historical baseline', async () => {
		const bundle: MigrationBundle = {
			journal: { entries: [{ idx: 0, when: 1, tag: '0000_expand' }] },
			migrations: { m0000: 'CREATE TABLE expanded (id text PRIMARY KEY);' }
		};
		const outcome = await runInDurableObject(
			testServerFor('migrate-unverified-baseline'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				database.run(
					sql.raw(
						'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)'
					)
				);
				database.run(
					sql.raw(
						"INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', 1)"
					)
				);

				applyMigrations(
					database,
					bundle,
					new Map([['0000_expand', 'current']])
				);
				let hasChangedDigest = false;

				try {
					applyMigrations(
						database,
						bundle,
						new Map([['0000_expand', 'changed']])
					);
				} catch (error) {
					hasChangedDigest = error instanceof DurableObjectMigrationDigestError;
				}

				return {
					hasChangedDigest,
					rows: database
						.values(
							sql.raw(
								'SELECT hash, digest, verification_state FROM __drizzle_migrations WHERE created_at = 1'
							)
						)
						.map((row) => [
							String(row[0]),
							typeof row[1] === 'string' ? row[1] : undefined,
							String(row[2])
						])
				};
			}
		);

		expect(outcome).toStrictEqual({
			hasChangedDigest: true,
			rows: [['', 'current', 'unverified-baseline']]
		});
	});

	it('rejects an unknown migration verification state', async () => {
		const bundle: MigrationBundle = {
			journal: { entries: [{ idx: 0, when: 1, tag: '0000_expand' }] },
			migrations: { m0000: 'CREATE TABLE expanded (id text PRIMARY KEY);' }
		};
		const isRejected = await runInDurableObject(
			testServerFor('migrate-invalid-verification-state'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				applyMigrations(
					database,
					bundle,
					new Map([['0000_expand', 'current']])
				);
				database.run(
					sql.raw(
						"UPDATE __drizzle_migrations SET verification_state = 'unknown' WHERE hash = '0000_expand'"
					)
				);

				try {
					applyMigrations(
						database,
						bundle,
						new Map([['0000_expand', 'current']])
					);
					return false;
				} catch (error) {
					return error instanceof DurableObjectMigrationVerificationStateError;
				}
			}
		);

		expect(isRejected).toBe(true);
	});

	it('distinguishes additive storage from a later local contract', async () => {
		const bundle: MigrationBundle = {
			journal: {
				entries: [
					{ idx: 0, when: 1, tag: '0000_expand' },
					{ idx: 1, when: 2, tag: '0001_contract' }
				]
			},
			migrations: {
				m0000: 'CREATE TABLE expanded (id text PRIMARY KEY);',
				m0001: 'CREATE TABLE contracted (id text PRIMARY KEY);'
			}
		};
		const result = await runInDurableObject(
			testServerFor('migrate-contract-boundary'),
			(_instance, state) => {
				const database = drizzle(state.storage);
				applyMigrations(database, migrationsThrough(bundle, 0));
				const hasContractBefore = hasAppliedMigrationAfter(database, bundle, 0);
				applyMigrations(database, bundle);

				return {
					hasContractBefore,
					hasContractAfter: hasAppliedMigrationAfter(database, bundle, 0)
				};
			}
		);

		expect(result).toStrictEqual({
			hasContractBefore: false,
			hasContractAfter: true
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
					return { threw: false };
				} catch (error) {
					return {
						threw: true,
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
