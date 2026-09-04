import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { databaseIdSchema } from './identifiers.ts';
import {
	applyD1Migrations,
	type D1Migration,
	type D1MigrationApi,
	D1MigrationDigestError,
	parseD1Migrations
} from './migrations.ts';

function digestOf(sql: string): string {
	return createHash('sha256').update(sql).digest('hex');
}

describe('parseD1Migrations', () => {
	it('sorts by name, splits on the statement breakpoint and digests the file', () => {
		const first =
			'CREATE TABLE a (id);\n--> statement-breakpoint\nCREATE INDEX ai ON a (id);\n';
		const second = 'CREATE TABLE b (id);';

		const result = parseD1Migrations([
			{ name: '0001_b.sql', sql: second },
			{ name: '0000_a.sql', sql: first }
		]);

		expect(result).toStrictEqual([
			{
				name: '0000_a.sql',
				sha256: digestOf(first),
				statements: ['CREATE TABLE a (id);', 'CREATE INDEX ai ON a (id);']
			},
			{
				name: '0001_b.sql',
				sha256: digestOf(second),
				statements: ['CREATE TABLE b (id);']
			}
		]);
	});
});

interface RecordedRow {
	readonly name: string;
	readonly sha256?: string;
	readonly verificationState?: 'verified' | 'unverified-baseline';
}

/**
 * A database whose tracking table holds the given rows. `columns` states which
 * columns the table already has, so a test can start from a tracking table
 * created before digests were recorded.
 */
function fakeApi(
	rows: readonly RecordedRow[],
	columns: readonly string[] = [
		'id',
		'name',
		'applied_at',
		'sha256',
		'verification_state'
	]
): { api: D1MigrationApi; batches: string[][] } {
	const batches: string[][] = [];

	return {
		batches,
		api: {
			queryBatch(_databaseId, statements) {
				batches.push([...statements]);
				return Promise.resolve();
			},
			queryRows(_databaseId, sql) {
				if (sql.includes('pragma_table_info')) {
					return Promise.resolve([...columns]);
				}

				return Promise.resolve(
					rows.map(
						(row) =>
							`${row.name}:${row.sha256 ?? ''}:${row.verificationState ?? ''}`
					)
				);
			}
		}
	};
}

describe('applyD1Migrations', () => {
	const first = 'CREATE TABLE a (id);';
	const second = 'CREATE TABLE b (id);';
	const migrations: D1Migration[] = [
		{ name: '0000_a.sql', sha256: digestOf(first), statements: [first] },
		{ name: '0001_b.sql', sha256: digestOf(second), statements: [second] }
	];
	const databaseId = databaseIdSchema.parse('db-1');

	it('runs only pending migrations and records the digest it applied', async () => {
		const { api, batches } = fakeApi([
			{
				name: '0000_a.sql',
				sha256: digestOf(first),
				verificationState: 'verified'
			}
		]);

		const result = await applyD1Migrations(api, databaseId, migrations);

		expect(result).toStrictEqual(['0001_b.sql']);
		expect(batches.at(-1)).toStrictEqual([
			second,
			`INSERT INTO d1_migrations (name, sha256, verification_state) VALUES ('0001_b.sql', '${digestOf(second)}', 'verified');`
		]);
	});

	it('applies and records nothing when every digest already matches', async () => {
		const { api, batches } = fakeApi(
			migrations.map((migration) => ({
				name: migration.name,
				sha256: migration.sha256,
				verificationState: 'verified' as const
			}))
		);

		const result = await applyD1Migrations(api, databaseId, migrations);

		expect(result).toStrictEqual([]);
		expect(batches).toStrictEqual([
			[expect.stringContaining('CREATE TABLE IF NOT EXISTS d1_migrations')]
		]);
	});

	it('adds the digest columns to a tracking table that predates them', async () => {
		const { api, batches } = fakeApi([], ['id', 'name', 'applied_at']);

		await applyD1Migrations(api, databaseId, []);

		expect(batches.at(1)).toStrictEqual([
			'ALTER TABLE d1_migrations ADD COLUMN sha256 TEXT;',
			'ALTER TABLE d1_migrations ADD COLUMN verification_state TEXT;'
		]);
	});

	it('adopts an unverified baseline for a name applied before digests were recorded', async () => {
		const { api, batches } = fakeApi([{ name: '0000_a.sql' }]);

		const result = await applyD1Migrations(api, databaseId, migrations);

		expect(result).toStrictEqual(['0001_b.sql']);
		expect(batches.at(1)).toStrictEqual([
			`UPDATE d1_migrations SET sha256 = '${digestOf(first)}', verification_state = 'unverified-baseline' WHERE name = '0000_a.sql';`
		]);
	});

	it('refuses a migration whose file changed after it was applied', async () => {
		const { api } = fakeApi([
			{
				name: '0000_a.sql',
				sha256: digestOf('CREATE TABLE a (other);'),
				verificationState: 'verified'
			}
		]);

		await expect(
			applyD1Migrations(api, databaseId, migrations)
		).rejects.toBeInstanceOf(D1MigrationDigestError);
	});

	it('refuses a historical migration edited after its baseline was adopted', async () => {
		const { api } = fakeApi([
			{
				name: '0000_a.sql',
				sha256: digestOf('CREATE TABLE a (other);'),
				verificationState: 'unverified-baseline'
			}
		]);

		await expect(
			applyD1Migrations(api, databaseId, migrations)
		).rejects.toBeInstanceOf(D1MigrationDigestError);
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
			queryRows: (_databaseId, sql) =>
				Promise.resolve(
					sql.includes('pragma_table_info')
						? ['id', 'name', 'applied_at', 'sha256', 'verification_state']
						: []
				)
		};

		await expect(
			applyD1Migrations(api, databaseId, [migration])
		).rejects.toThrow('D1 batch failed');
		await expect(
			applyD1Migrations(api, databaseId, [migration])
		).resolves.toStrictEqual(['0001_b.sql']);

		expect(batches.at(-1)).toStrictEqual([
			second,
			`INSERT INTO d1_migrations (name, sha256, verification_state) VALUES ('0001_b.sql', '${digestOf(second)}', 'verified');`
		]);
	});
});
