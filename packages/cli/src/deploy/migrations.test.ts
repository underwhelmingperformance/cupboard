import { describe, expect, it } from 'vitest';

import { databaseIdSchema } from './identifiers.ts';
import {
	applyD1Migrations,
	applyDeclaredD1Migrations,
	applyLegacyBootstrapD1Migrations,
	type D1Migration,
	type D1MigrationApi,
	parseD1Migrations
} from './migrations.ts';

describe('parseD1Migrations', () => {
	it('sorts by name and splits on the statement breakpoint', () => {
		const result = parseD1Migrations([
			{ name: '0001_b.sql', sql: 'CREATE TABLE b (id);' },
			{
				name: '0000_a.sql',
				sql: 'CREATE TABLE a (id);\n--> statement-breakpoint\nCREATE INDEX ai ON a (id);\n'
			}
		]);

		expect(result).toStrictEqual([
			{
				name: '0000_a.sql',
				sha256:
					'754845157e66525f94122aa5011798ff0688ba3c9328d934b0e6f0055dcc650d',
				statements: ['CREATE TABLE a (id);', 'CREATE INDEX ai ON a (id);']
			},
			{
				name: '0001_b.sql',
				sha256:
					'bdd8eb0524337a0c0ce3e73bdc5ebf54e8ff466192de42b64cf88bb771f97568',
				statements: ['CREATE TABLE b (id);']
			}
		]);
	});
});

function fakeApi(alreadyApplied: readonly string[]): {
	api: D1MigrationApi;
	batches: string[][];
} {
	const batches: string[][] = [];
	const applied = new Set(alreadyApplied);

	return {
		batches,
		api: {
			queryBatch(_databaseId, statements) {
				batches.push([...statements]);
				return Promise.resolve();
			},
			queryRows: () => Promise.resolve([...applied])
		}
	};
}

describe('applyD1Migrations', () => {
	const migrations: D1Migration[] = [
		{
			name: '0000_a.sql',
			sha256: 'a'.repeat(64),
			statements: ['CREATE TABLE a (id);']
		},
		{
			name: '0001_b.sql',
			sha256: 'b'.repeat(64),
			statements: ['CREATE TABLE b (id);', 'CREATE TABLE c (id);']
		}
	];

	it('runs only pending migrations and records them', async () => {
		const { api, batches } = fakeApi(['0000_a.sql']);

		const result = await applyD1Migrations(
			api,
			databaseIdSchema.parse('db-1'),
			migrations
		);

		expect(result).toStrictEqual(['0001_b.sql']);
		expect(batches).toStrictEqual([
			[
				'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);'
			],
			[
				'CREATE TABLE b (id);',
				'CREATE TABLE c (id);',
				"INSERT INTO d1_migrations (name) VALUES ('0001_b.sql');"
			]
		]);
	});

	it('is a no-op when everything is applied', async () => {
		const { api, batches } = fakeApi(['0000_a.sql', '0001_b.sql']);

		const result = await applyD1Migrations(
			api,
			databaseIdSchema.parse('db-1'),
			migrations
		);

		expect(result).toStrictEqual([]);
		expect(batches).toStrictEqual([
			[
				'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);'
			]
		]);
	});

	it('retries a migration as one batch after a failed attempt', async () => {
		const migration = migrations[1];

		if (migration === undefined) {
			throw new Error('The retry fixture migration is missing.');
		}

		const batches: string[][] = [];
		let attempt = 0;
		const api: D1MigrationApi = {
			queryBatch(_databaseId, statements) {
				batches.push([...statements]);
				attempt += 1;

				return attempt === 2
					? Promise.reject(new Error('D1 batch failed'))
					: Promise.resolve();
			},
			queryRows: () => Promise.resolve([])
		};
		const databaseId = databaseIdSchema.parse('db-1');

		await expect(
			applyD1Migrations(api, databaseId, [migration])
		).rejects.toThrow('D1 batch failed');
		await expect(
			applyD1Migrations(api, databaseId, [migration])
		).resolves.toStrictEqual(['0001_b.sql']);

		expect(batches).toStrictEqual([
			[expect.stringContaining('CREATE TABLE IF NOT EXISTS d1_migrations')],
			[
				'CREATE TABLE b (id);',
				'CREATE TABLE c (id);',
				"INSERT INTO d1_migrations (name) VALUES ('0001_b.sql');"
			],
			[expect.stringContaining('CREATE TABLE IF NOT EXISTS d1_migrations')],
			[
				'CREATE TABLE b (id);',
				'CREATE TABLE c (id);',
				"INSERT INTO d1_migrations (name) VALUES ('0001_b.sql');"
			]
		]);
	});
});

describe('applyDeclaredD1Migrations', () => {
	const migrations: D1Migration[] = [
		{
			name: '0000_bootstrap.sql',
			sha256: 'a'.repeat(64),
			statements: ['CREATE TABLE bootstrap (id);']
		},
		{
			name: '0001_expand.sql',
			sha256: 'b'.repeat(64),
			statements: ['ALTER TABLE bootstrap ADD COLUMN native_id TEXT;']
		},
		{
			name: '0002_contract.sql',
			sha256: 'c'.repeat(64),
			statements: ['DROP TABLE bootstrap;']
		}
	];

	it('applies only the exact next set and records immutable checksums', async () => {
		const batches: string[][] = [];
		let query = 0;
		const api: D1MigrationApi = {
			queryBatch(_databaseId, statements) {
				batches.push([...statements]);
				return Promise.resolve();
			},
			queryRows() {
				query += 1;
				return Promise.resolve(query === 1 ? ['0000_bootstrap.sql'] : []);
			}
		};

		await expect(
			applyDeclaredD1Migrations(
				api,
				databaseIdSchema.parse('db-1'),
				migrations,
				['0001_expand.sql']
			)
		).resolves.toStrictEqual(['0001_expand.sql']);
		expect(batches).toStrictEqual([
			[
				'ALTER TABLE bootstrap ADD COLUMN native_id TEXT;',
				"INSERT INTO d1_migrations (name) VALUES ('0001_expand.sql');",
				`INSERT INTO structural_migration_checksum (kind, migration_id, sha256, applied_at) VALUES ('d1', '0001_expand.sql', '${'b'.repeat(64)}', CURRENT_TIMESTAMP);`
			]
		]);
	});

	it('refuses to skip a pending migration', async () => {
		let query = 0;
		const api: D1MigrationApi = {
			queryBatch: () => Promise.resolve(),
			queryRows: () => {
				query += 1;
				return Promise.resolve(query === 1 ? ['0000_bootstrap.sql'] : []);
			}
		};

		await expect(
			applyDeclaredD1Migrations(
				api,
				databaseIdSchema.parse('db-1'),
				migrations,
				['0002_contract.sql']
			)
		).rejects.toThrow('next contiguous D1 migration set');
	});

	it.each([
		{
			name: 'resumes after the first declared migration',
			applied: ['0000_bootstrap.sql', '0001_expand.sql'],
			expected: ['0002_contract.sql']
		},
		{
			name: 'returns without work when the declared set is complete',
			applied: ['0000_bootstrap.sql', '0001_expand.sql', '0002_contract.sql'],
			expected: []
		}
	])('$name', async ({ applied, expected }) => {
		const batches: string[][] = [];
		let query = 0;
		const api: D1MigrationApi = {
			queryBatch(_databaseId, statements) {
				batches.push([...statements]);
				return Promise.resolve();
			},
			queryRows() {
				query += 1;
				return Promise.resolve(query === 1 ? applied : []);
			}
		};

		await expect(
			applyDeclaredD1Migrations(
				api,
				databaseIdSchema.parse('db-1'),
				migrations,
				['0001_expand.sql', '0002_contract.sql']
			)
		).resolves.toStrictEqual(expected);
		expect(batches).toHaveLength(expected.length);
	});

	it('refuses a changed applied migration', async () => {
		let query = 0;
		const api: D1MigrationApi = {
			queryBatch: () => Promise.resolve(),
			queryRows: () => {
				query += 1;
				return Promise.resolve(
					query === 1
						? ['0000_bootstrap.sql']
						: [`0000_bootstrap.sql:${'f'.repeat(64)}`]
				);
			}
		};

		await expect(
			applyDeclaredD1Migrations(
				api,
				databaseIdSchema.parse('db-1'),
				migrations,
				[]
			)
		).rejects.toThrow('changed after it was applied');
	});
});

describe('applyLegacyBootstrapD1Migrations', () => {
	const migrations: D1Migration[] = [
		{
			name: '0000_legacy.sql',
			sha256: 'a'.repeat(64),
			statements: ['CREATE TABLE legacy (id);']
		},
		{
			name: '0001_ledger.sql',
			sha256: 'b'.repeat(64),
			statements: ['CREATE TABLE structural_migration_checksum (id);']
		},
		{
			name: '0002_expand.sql',
			sha256: 'c'.repeat(64),
			statements: ['ALTER TABLE legacy ADD COLUMN native_id TEXT;']
		}
	];

	function bootstrapApi(initialApplied: readonly string[]): {
		readonly api: D1MigrationApi;
		readonly batches: string[][];
	} {
		const applied = [...initialApplied];
		const checksums = new Map<string, string>();
		const batches: string[][] = [];

		return {
			batches,
			api: {
				queryBatch(_databaseId, statements) {
					batches.push([...statements]);

					for (const migration of migrations) {
						if (
							statements.includes(
								`INSERT INTO d1_migrations (name) VALUES ('${migration.name}');`
							)
						) {
							applied.push(migration.name);
						}

						if (
							statements.some((statement) =>
								statement.includes(migration.sha256)
							)
						) {
							checksums.set(migration.name, migration.sha256);
						}
					}

					return Promise.resolve();
				},
				queryRows(_databaseId, sql) {
					if (sql.includes('structural_migration_checksum')) {
						return Promise.resolve(
							[...checksums].map(([name, checksum]) => `${name}:${checksum}`)
						);
					}

					return Promise.resolve([...applied]);
				}
			}
		};
	}

	it('records the legacy prefix and applies only the declared bootstrap range', async () => {
		const { api, batches } = bootstrapApi(['0000_legacy.sql']);

		await expect(
			applyLegacyBootstrapD1Migrations(
				api,
				databaseIdSchema.parse('db-1'),
				migrations,
				'0000_legacy.sql',
				['0001_ledger.sql', '0002_expand.sql']
			)
		).resolves.toStrictEqual(['0001_ledger.sql', '0002_expand.sql']);
		expect(batches).toStrictEqual([
			[
				'CREATE TABLE structural_migration_checksum (id);',
				"INSERT INTO d1_migrations (name) VALUES ('0001_ledger.sql');",
				expect.stringContaining("'0000_legacy.sql'"),
				expect.stringContaining("'0001_ledger.sql'")
			],
			[
				'ALTER TABLE legacy ADD COLUMN native_id TEXT;',
				"INSERT INTO d1_migrations (name) VALUES ('0002_expand.sql');",
				expect.stringContaining("'0002_expand.sql'")
			]
		]);
	});

	it('resumes after the bootstrap ledger migration commits', async () => {
		const { api, batches } = bootstrapApi([
			'0000_legacy.sql',
			'0001_ledger.sql'
		]);

		await expect(
			applyLegacyBootstrapD1Migrations(
				api,
				databaseIdSchema.parse('db-1'),
				migrations,
				'0000_legacy.sql',
				['0001_ledger.sql', '0002_expand.sql']
			)
		).resolves.toStrictEqual(['0002_expand.sql']);
		expect(batches).toStrictEqual([
			[
				'ALTER TABLE legacy ADD COLUMN native_id TEXT;',
				"INSERT INTO d1_migrations (name) VALUES ('0002_expand.sql');",
				expect.stringContaining("'0002_expand.sql'")
			]
		]);
	});

	it('refuses a migration history outside the declared legacy fingerprint', async () => {
		const { api } = bootstrapApi([]);

		await expect(
			applyLegacyBootstrapD1Migrations(
				api,
				databaseIdSchema.parse('db-1'),
				migrations,
				'0000_legacy.sql',
				['0001_ledger.sql', '0002_expand.sql']
			)
		).rejects.toThrow('supported legacy bootstrap state');
	});
});
