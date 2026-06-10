import { describe, expect, it } from 'vitest';

import type { DurableObjectMigration } from './config.ts';
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
	queries: string[];
} {
	const queries: string[] = [];
	const applied = new Set(alreadyApplied);

	return {
		queries,
		api: {
			query(_databaseId, sql) {
				queries.push(sql);
				return Promise.resolve();
			},
			queryRows() {
				return Promise.resolve([...applied]);
			}
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
		const { api, queries } = fakeApi(['0000_a.sql']);

		const result = await applyD1Migrations(api, 'db-1', migrations);

		expect(result).toStrictEqual(['0001_b.sql']);
		expect(queries).toStrictEqual([
			'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);',
			'CREATE TABLE b (id);',
			'CREATE TABLE c (id);',
			"INSERT INTO d1_migrations (name) VALUES ('0001_b.sql');"
		]);
	});

	it('is a no-op when everything is applied', async () => {
		const { api, queries } = fakeApi(['0000_a.sql', '0001_b.sql']);

		const result = await applyD1Migrations(api, 'db-1', migrations);

		expect(result).toStrictEqual([]);
		expect(queries).toStrictEqual([
			'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);'
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
			name: 'redeploy at the latest tag sends nothing',
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
