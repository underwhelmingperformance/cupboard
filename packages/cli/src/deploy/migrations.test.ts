import { describe, expect, it } from 'vitest';

import type { DurableObjectMigration } from './config.ts';
import { databaseIdSchema } from './identifiers.ts';
import {
	applyD1Migrations,
	computeDurableObjectMigration,
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
				statements: ['CREATE TABLE a (id);', 'CREATE INDEX ai ON a (id);']
			},
			{ name: '0001_b.sql', statements: ['CREATE TABLE b (id);'] }
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
		{ name: '0000_a.sql', statements: ['CREATE TABLE a (id);'] },
		{
			name: '0001_b.sql',
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

describe('computeDurableObjectMigration', () => {
	const migrations: DurableObjectMigration[] = [
		{ tag: 'v1', newSqliteClasses: ['CupboardServer'] }
	];

	it.each([
		{
			name: 'first deploy sends the new-sqlite-class step',
			deployedTag: undefined,
			expected: { new_tag: 'v1', new_sqlite_classes: ['CupboardServer'] }
		},
		{
			name: 'redeploy at the latest tag omits the migration payload',
			deployedTag: 'v1',
			expected: undefined
		}
	])('$name', ({ deployedTag, expected }) => {
		expect(
			computeDurableObjectMigration(deployedTag, migrations)
		).toStrictEqual(expected);
	});

	it('returns undefined when there are no migrations', () => {
		expect(computeDurableObjectMigration(undefined, [])).toBeUndefined();
	});
});
