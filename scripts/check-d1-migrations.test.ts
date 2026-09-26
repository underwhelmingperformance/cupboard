import path from 'node:path';

import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { describe, expect, it } from 'vitest';

import {
	checkD1Migrations,
	MigrationApplyError,
	MigrationJournalOrderError,
	type MigrationSet,
	readMigrationSet
} from './check-d1-migrations.ts';

const repositoryMigrations = path.resolve(
	import.meta.dirname,
	'..',
	'packages/server/drizzle-d1'
);

const sources: Record<string, string> = {
	'0000_base.sql': 'CREATE TABLE tenant (id TEXT PRIMARY KEY, legacy TEXT);',
	'0001_expand.sql': 'ALTER TABLE tenant ADD COLUMN access TEXT;',
	'0002_contract.sql': 'ALTER TABLE tenant DROP COLUMN legacy;'
};

function migrationSet(
	overrides: Partial<Record<keyof typeof sources, string>> = {},
	journal?: readonly string[]
): MigrationSet {
	const files = Object.keys(sources).toSorted(byCodeUnit);

	return {
		files,
		journal: journal ?? files,
		sql: (file) => overrides[file] ?? sources[file] ?? ''
	};
}

describe('checkD1Migrations', () => {
	it("accepts the repository's migrations", () => {
		const set = readMigrationSet(repositoryMigrations);

		expect(checkD1Migrations(set)).toStrictEqual({
			applied: set.files.length
		});
	});

	it('fails when the journal lists the files in a different order', () => {
		const set = migrationSet({}, [
			'0000_base.sql',
			'0002_contract.sql',
			'0001_expand.sql'
		]);

		expect(() => checkD1Migrations(set)).toThrow(
			new MigrationJournalOrderError(set.files, set.journal)
		);
	});

	it('fails when a migration does not apply in name order', () => {
		const set = migrationSet({
			'0001_expand.sql': 'ALTER TABLE tenant ADD COLUMN legacy TEXT;'
		});

		let caught: unknown;

		try {
			checkD1Migrations(set);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MigrationApplyError);
		expect({
			file: caught instanceof MigrationApplyError && caught.file,
			statement: caught instanceof MigrationApplyError && caught.statement
		}).toStrictEqual({
			file: '0001_expand.sql',
			statement: 'ALTER TABLE tenant ADD COLUMN legacy TEXT;'
		});
	});
});
