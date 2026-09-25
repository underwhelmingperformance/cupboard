import path from 'node:path';

import {
	type SchemaTransition,
	schemaTransitions
} from '@cupboard/protocol/deployment';
import { describe, expect, it } from 'vitest';

import {
	byCodeUnit,
	checkD1Migrations,
	ContractOrderError,
	independentReplayOrder,
	MigrationApplyError,
	MigrationSequenceError,
	type MigrationSet,
	readMigrationSet
} from './check-d1-migrations.ts';

const repositoryMigrations = path.resolve(
	import.meta.dirname,
	'..',
	'packages/server/drizzle-d1'
);

// A release with one transition that widens then narrows a table, and an
// independent one that adds a table of its own.
const sources: Record<string, string> = {
	'0000_base.sql': 'CREATE TABLE tenant (id TEXT PRIMARY KEY, legacy TEXT);',
	'0001_expand.sql': 'ALTER TABLE tenant ADD COLUMN access TEXT;',
	'0002_contract.sql': 'ALTER TABLE tenant DROP COLUMN legacy;',
	'0003_independent.sql': 'CREATE TABLE sweep (id INTEGER PRIMARY KEY);'
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

const cacheIdentity: SchemaTransition = {
	id: 'cache-identity',
	expand: ['0000_base.sql', '0001_expand.sql'],
	contract: ['0002_contract.sql']
};
const independent: SchemaTransition = {
	id: 'deployment-transitions',
	expand: ['0003_independent.sql'],
	contract: [],
	independent: true
};

describe('checkD1Migrations', () => {
	it("accepts the repository's migrations", () => {
		const result = checkD1Migrations(
			readMigrationSet(repositoryMigrations),
			schemaTransitions
		);

		expect(result).toStrictEqual({
			applied: schemaTransitions.flatMap((transition) => [
				...transition.expand,
				...transition.contract
			]).length,
			replayed: ['deployment-transitions', 'local-step-sweep']
		});
	});

	it('accepts a consistent set and replays the independent expand ahead of the contract', () => {
		expect(
			checkD1Migrations(migrationSet(), [cacheIdentity, independent])
		).toStrictEqual({ applied: 4, replayed: ['deployment-transitions'] });
	});

	it('fails when the journal lists the files in a different order', () => {
		const set = migrationSet({}, [
			'0000_base.sql',
			'0001_expand.sql',
			'0003_independent.sql',
			'0002_contract.sql'
		]);

		let caught: unknown;

		try {
			checkD1Migrations(set, [cacheIdentity, independent]);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MigrationSequenceError);
		expect(caught).toMatchObject({ source: 'journal' });
	});

	it.each([
		{
			name: 'a file no transition lists',
			transitions: [
				{ ...cacheIdentity, expand: ['0000_base.sql', '0001_expand.sql'] },
				{ ...independent, expand: [] }
			]
		},
		{
			name: 'a transition listed out of order',
			transitions: [independent, cacheIdentity]
		},
		{
			name: 'a file listed twice',
			transitions: [
				cacheIdentity,
				{
					...independent,
					expand: ['0002_contract.sql', '0003_independent.sql']
				}
			]
		}
	])('fails when the transitions have $name', ({ transitions }) => {
		let caught: unknown;

		try {
			checkD1Migrations(migrationSet(), transitions);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MigrationSequenceError);
		expect(caught).toMatchObject({ source: 'transitions' });
	});

	it('fails when a contract sorts before its expand', () => {
		const misordered: SchemaTransition = {
			id: 'cache-identity',
			expand: ['0000_base.sql', '0002_contract.sql'],
			contract: ['0001_expand.sql']
		};

		let caught: unknown;

		try {
			checkD1Migrations(migrationSet(), [misordered, independent]);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ContractOrderError);
		expect(caught).toMatchObject({
			transition: 'cache-identity',
			lastExpand: '0002_contract.sql',
			firstContract: '0001_expand.sql'
		});
	});

	it('fails when a migration does not apply in journal order', () => {
		const set = migrationSet({
			'0001_expand.sql': 'ALTER TABLE tenant ADD COLUMN legacy TEXT;'
		});

		let caught: unknown;

		try {
			checkD1Migrations(set, [cacheIdentity, independent]);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MigrationApplyError);
		expect(caught).toMatchObject({ file: '0001_expand.sql' });
	});

	// The deploy applies an independent expand before the contracts of the
	// transitions before it, so an expand that reads what a contract renames
	// applies in the journal order but not in the deploy's.
	it('fails when an independent expand references what an earlier contract renames', () => {
		const set = migrationSet({
			'0002_contract.sql':
				'ALTER TABLE tenant RENAME COLUMN legacy TO retired;',
			'0003_independent.sql':
				'CREATE TABLE sweep (id INTEGER PRIMARY KEY);--> statement-breakpoint\nINSERT INTO sweep (id) SELECT count(retired) FROM tenant;'
		});

		const inJournalOrder = (() => {
			try {
				checkD1Migrations(set, [
					cacheIdentity,
					{ ...independent, independent: undefined }
				]);
				return 'applied';
			} catch {
				return 'failed';
			}
		})();

		let caught: unknown;

		try {
			checkD1Migrations(set, [cacheIdentity, independent]);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MigrationApplyError);
		expect({
			inJournalOrder,
			file: caught instanceof MigrationApplyError && caught.file,
			message: caught instanceof Error && caught.message.split('\n', 1)[0]
		}).toStrictEqual({
			inJournalOrder: 'applied',
			file: '0003_independent.sql',
			message:
				'D1 migration 0003_independent.sql failed to apply with the deployment-transitions expand ahead of the earlier contracts:'
		});
	});
});

describe('independentReplayOrder', () => {
	it('moves the independent expand ahead of the earlier contracts only', () => {
		const later: SchemaTransition = {
			id: 'cache-identity',
			expand: ['0004_later.sql'],
			contract: ['0005_later_contract.sql']
		};

		expect(
			independentReplayOrder([cacheIdentity, independent, later], 1)
		).toStrictEqual([
			'0000_base.sql',
			'0001_expand.sql',
			'0003_independent.sql',
			'0002_contract.sql',
			'0004_later.sql',
			'0005_later_contract.sql'
		]);
	});
});
