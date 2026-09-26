import path from 'node:path';

import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type SchemaTransition,
	schemaTransitions
} from '@cupboard/protocol/deployment';
import { describe, expect, it } from 'vitest';

import {
	checkD1Migrations,
	ContractOrderError,
	deployOrder,
	MigrationApplyError,
	MigrationJournalOrderError,
	MigrationSchemaMismatchError,
	type MigrationSet,
	readMigrationSet,
	TransitionSequenceError
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

// A release with three transitions: the first has contract migrations, the
// second is dependent and creates a table, and the third is independent and
// indexes that table.
const sweepSources: Record<string, string> = {
	'0000_base.sql': 'CREATE TABLE tenant (id TEXT PRIMARY KEY, legacy TEXT);',
	'0001_expand.sql': 'ALTER TABLE tenant ADD COLUMN access TEXT;',
	'0002_contract.sql': 'ALTER TABLE tenant DROP COLUMN legacy;',
	'0003_sweep.sql': 'CREATE TABLE sweep (id INTEGER PRIMARY KEY, legacy TEXT);',
	'0004_sweep_contract.sql': 'ALTER TABLE sweep DROP COLUMN legacy;',
	'0005_sweep_index.sql': 'CREATE INDEX sweep_id ON sweep (id);'
};
const sweepFiles = Object.keys(sweepSources).toSorted(byCodeUnit);
const sweepSet: MigrationSet = {
	files: sweepFiles,
	journal: sweepFiles,
	sql: (file) => sweepSources[file] ?? ''
};
const sweepTransitions: readonly SchemaTransition<string>[] = [
	cacheIdentity,
	{
		id: 'sweep',
		expand: ['0003_sweep.sql'],
		contract: ['0004_sweep_contract.sql']
	},
	{
		id: 'sweep-index',
		expand: ['0005_sweep_index.sql'],
		contract: [],
		independent: true
	}
];

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
			replayed: ['deployment-transitions']
		});
	});

	it('accepts a consistent set and replays the independent expand migration ahead of the contract migration', () => {
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

		expect(() => checkD1Migrations(set, [cacheIdentity, independent])).toThrow(
			new MigrationJournalOrderError(set.files, set.journal)
		);
	});

	it.each([
		{
			name: 'a file that no transition lists',
			transitions: [
				{ ...cacheIdentity, expand: ['0000_base.sql', '0001_expand.sql'] },
				{ ...independent, expand: [] }
			],
			found: ['0000_base.sql', '0001_expand.sql', '0002_contract.sql']
		},
		{
			name: 'a transition listed out of order',
			transitions: [independent, cacheIdentity],
			found: [
				'0003_independent.sql',
				'0000_base.sql',
				'0001_expand.sql',
				'0002_contract.sql'
			]
		},
		{
			name: 'a file listed twice',
			transitions: [
				cacheIdentity,
				{
					...independent,
					expand: ['0002_contract.sql', '0003_independent.sql']
				}
			],
			found: [
				'0000_base.sql',
				'0001_expand.sql',
				'0002_contract.sql',
				'0002_contract.sql',
				'0003_independent.sql'
			]
		}
	])('fails when the transitions have $name', ({ transitions, found }) => {
		expect(() => checkD1Migrations(migrationSet(), transitions)).toThrow(
			new TransitionSequenceError(migrationSet().files, found)
		);
	});

	it('fails when a contract migration sorts before an expand migration of the same transition', () => {
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

		expect(caught).toStrictEqual(
			new ContractOrderError(
				'cache-identity',
				'0002_contract.sql',
				'0001_expand.sql'
			)
		);
	});

	it('fails when a migration does not apply in name order', () => {
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
		expect({
			file: caught instanceof MigrationApplyError && caught.file,
			context: caught instanceof MigrationApplyError && caught.context
		}).toStrictEqual({ file: '0001_expand.sql', context: 'in name order' });
	});

	// The deploy can apply an independent transition's expand migrations before
	// the contract migrations of the transitions before it. An expand migration
	// that reads a column that a contract migration renames therefore applies
	// in name order but not in the deploy's order.
	it('fails when an independent expand migration references a column that an earlier contract migration renames', () => {
		const set = migrationSet({
			'0002_contract.sql':
				'ALTER TABLE tenant RENAME COLUMN legacy TO retired;',
			'0003_independent.sql':
				'CREATE TABLE sweep (id INTEGER PRIMARY KEY);--> statement-breakpoint\nINSERT INTO sweep (id) SELECT count(retired) FROM tenant;'
		});

		// Without the independent flag the check replays only name order.
		const inNameOrder = checkD1Migrations(set, [
			cacheIdentity,
			{ ...independent, independent: undefined }
		]);

		let caught: unknown;

		try {
			checkD1Migrations(set, [cacheIdentity, independent]);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MigrationApplyError);
		expect({
			inNameOrder,
			file: caught instanceof MigrationApplyError && caught.file,
			context: caught instanceof MigrationApplyError && caught.context
		}).toStrictEqual({
			inNameOrder: { applied: 4, replayed: [] },
			file: '0003_independent.sql',
			context:
				'with deployment-transitions expanded ahead of the earlier contract migrations'
		});
	});

	it('accepts an independent expand migration that indexes a table that the preceding transition, which is not independent, creates', () => {
		expect(checkD1Migrations(sweepSet, sweepTransitions)).toStrictEqual({
			applied: sweepFiles.length,
			replayed: ['sweep-index']
		});
	});

	// Each statement applies in both orders, but the table that the independent
	// expand migration creates first lacks the column that the contract
	// migration would add.
	it('fails when an independent expand migration changes the schema that an earlier contract migration produces', () => {
		const set = migrationSet({
			'0002_contract.sql':
				'CREATE TABLE IF NOT EXISTS sweep (id INTEGER PRIMARY KEY, retired TEXT);',
			'0003_independent.sql':
				'CREATE TABLE IF NOT EXISTS sweep (id INTEGER PRIMARY KEY);'
		});

		let caught: unknown;

		try {
			checkD1Migrations(set, [cacheIdentity, independent]);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MigrationSchemaMismatchError);
		expect({
			context: caught instanceof MigrationSchemaMismatchError && caught.context,
			missing: caught instanceof MigrationSchemaMismatchError && caught.missing,
			unexpected:
				caught instanceof MigrationSchemaMismatchError && caught.unexpected
		}).toStrictEqual({
			context:
				'with deployment-transitions expanded ahead of the earlier contract migrations',
			missing: [
				'table sweep: CREATE TABLE sweep (id INTEGER PRIMARY KEY, retired TEXT)',
				'column sweep.retired 1 TEXT notnull=0 pk=0 hidden=0 default=null'
			],
			unexpected: ['table sweep: CREATE TABLE sweep (id INTEGER PRIMARY KEY)']
		});
	});
});

describe('deployOrder', () => {
	it('has no order when the deploy refuses a transition that is not independent after an incomplete one', () => {
		expect(deployOrder(sweepTransitions, 0)).toBeUndefined();
	});

	it.each([
		{
			completeCount: 1,
			files: [
				'0000_base.sql',
				'0001_expand.sql',
				'0002_contract.sql',
				'0003_sweep.sql',
				'0005_sweep_index.sql',
				'0004_sweep_contract.sql'
			],
			ahead: ['sweep-index']
		},
		{
			completeCount: 2,
			files: sweepFiles,
			ahead: []
		}
	])(
		"returns the deploy's order with $completeCount transitions complete",
		({ completeCount, files, ahead }) => {
			expect(deployOrder(sweepTransitions, completeCount)).toStrictEqual({
				files,
				ahead
			});
		}
	);
});
