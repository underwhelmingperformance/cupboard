import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type SchemaTransition,
	schemaTransitions
} from '@cupboard/protocol/deployment';
import { describe, expect, it, vi } from 'vitest';

import {
	checkD1Migrations,
	ContractOrderError,
	deployOrder,
	MigrationApplyError,
	MigrationJournalOrderError,
	MigrationSchemaMismatchError,
	type MigrationSet,
	readMigrationSet,
	TransitionSequenceError,
	withControlDatabaseTransfer
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
	'0003_independent.sql': 'CREATE TABLE later (id INTEGER PRIMARY KEY);'
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
const laterSources: Record<string, string> = {
	'0000_base.sql': 'CREATE TABLE tenant (id TEXT PRIMARY KEY, legacy TEXT);',
	'0001_expand.sql': 'ALTER TABLE tenant ADD COLUMN access TEXT;',
	'0002_contract.sql': 'ALTER TABLE tenant DROP COLUMN legacy;',
	'0003_later.sql': 'CREATE TABLE later (id INTEGER PRIMARY KEY, legacy TEXT);',
	'0004_later_contract.sql': 'ALTER TABLE later DROP COLUMN legacy;',
	'0005_later_index.sql': 'CREATE INDEX later_id ON later (id);'
};
const laterFiles = Object.keys(laterSources).toSorted(byCodeUnit);
const laterSet: MigrationSet = {
	files: laterFiles,
	journal: laterFiles,
	sql: (file) => laterSources[file] ?? ''
};
const laterTransitions: readonly SchemaTransition<string>[] = [
	cacheIdentity,
	{
		id: 'later',
		expand: ['0003_later.sql'],
		contract: ['0004_later_contract.sql']
	},
	{
		id: 'later-index',
		expand: ['0005_later_index.sql'],
		contract: [],
		independent: true
	}
];

const sharedTransitions = schemaTransitions.filter(
	(transition) => transition.database === undefined
);
const precedingSharedTransitions = sharedTransitions.slice(
	0,
	sharedTransitions.findIndex(
		(transition) => transition.id === 'cas-demotion-progress'
	)
);

describe('checkD1Migrations', () => {
	it("accepts the repository's migrations", () => {
		const result = checkD1Migrations(
			withControlDatabaseTransfer(readMigrationSet(repositoryMigrations)),
			sharedTransitions
		);

		expect(result).toStrictEqual({
			applied: sharedTransitions.flatMap((transition) => [
				...transition.expand,
				...transition.contract
			]).length,
			replayed: [
				'cas-demotion-progress',
				'attestation-list-revision',
				'tenant-namespace-cleanup',
				'native-artifact-publication',
				'shared-listing-generation',
				'shared-listing-jobs'
			]
		});
	});

	it('installs the namespace guard before the reader transition contracts', () => {
		const completeCount = sharedTransitions.findIndex(
			(transition) => transition.id === 'attestation-list-revision'
		);
		const order = deployOrder(sharedTransitions, completeCount);
		if (order === undefined) {
			throw new Error('The reader transition has no valid deployment order');
		}
		const guardIndex = order.files.indexOf(
			'0051_tenant_namespace_cleanup_guard.sql'
		);
		const readerIndex = order.files.indexOf(
			'0050_attestation_list_revision_contract.sql'
		);
		expect({
			guardPresent: guardIndex !== -1,
			readerPresent: readerIndex !== -1,
			guardBeforeReaders: guardIndex < readerIndex
		}).toStrictEqual({
			guardPresent: true,
			readerPresent: true,
			guardBeforeReaders: true
		});
	});

	it('preserves replay coverage for the preceding CAS and artifact transitions', () => {
		const full = readMigrationSet(repositoryMigrations);
		const transitions = precedingSharedTransitions;
		const includedFiles = new Set(
			transitions.flatMap((transition) => [
				...transition.expand,
				...transition.contract
			])
		);
		const preceding: MigrationSet = {
			files: full.files.filter((file) => includedFiles.has(file)),
			journal: full.journal.filter((file) => includedFiles.has(file)),
			sql: full.sql
		};
		expect(
			checkD1Migrations(withControlDatabaseTransfer(preceding), transitions)
		).toStrictEqual({
			applied: 48,
			replayed: [
				'cas-storage',
				'cache-path-intersection-index',
				'native-artifact-storage'
			]
		});
	});

	it('expands path authority after contracted cache identity and contracts the path index before renaming its table', () => {
		const earlierTransitions = precedingSharedTransitions.filter(
			(transition) => transition.id !== 'cache-path-intersection-index'
		);
		const order = deployOrder(earlierTransitions, 1);
		expect(order).toStrictEqual({
			files: [
				...(schemaTransitions[0]?.expand ?? []),
				...(schemaTransitions[0]?.contract ?? []),
				'0031_deployment_transitions.sql',
				'0033_tenant_local_step_attempts.sql',
				'0034_publication_identity.sql',
				'0035_blob_reference_read_authority.sql',
				'0037_tenant_retry_clock.sql',
				'0038_tenant_schema_progress.sql',
				'0039_control_refresh_sessions.sql',
				'0040_control_subject_nonces.sql',
				'0041_control_database_split.sql',
				'0043_cas_storage_expand.sql',
				'0046_native_artifact_storage.sql',
				'0032_attestation_ref_path_index.sql',
				'0036_path_read_authority_contract.sql',
				'0042_control_database_contract.sql',
				'0044_cas_storage_contract.sql',
				'0047_attestation_cas_retention_index.sql'
			],
			ahead: [
				'local-step-attempts',
				'publication-identity',
				'blob-reference-read-authority',
				'tenant-retry-clock',
				'tenant-schema-progress',
				'control-refresh-sessions',
				'control-subject-nonces',
				'control-database-split',
				'cas-storage',
				'native-artifact-storage'
			]
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

	it('reports the migration that does not apply when closing the database also fails', () => {
		const set = migrationSet({
			'0001_expand.sql': 'ALTER TABLE tenant ADD COLUMN legacy TEXT;'
		});
		const close = vi
			.spyOn(DatabaseSync.prototype, 'close')
			.mockImplementation(() => {
				throw new Error('the database could not be closed');
			});
		let caught: unknown;

		try {
			checkD1Migrations(set, [cacheIdentity, independent]);
		} catch (error) {
			caught = error;
		} finally {
			close.mockRestore();
		}

		expect({
			isApplyError: caught instanceof MigrationApplyError,
			file: caught instanceof MigrationApplyError && caught.file
		}).toStrictEqual({ isApplyError: true, file: '0001_expand.sql' });
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
				'CREATE TABLE later (id INTEGER PRIMARY KEY);--> statement-breakpoint\nINSERT INTO later (id) SELECT count(retired) FROM tenant;'
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

	it('accepts an independent expand migration that indexes a table from the transition before it', () => {
		expect(checkD1Migrations(laterSet, laterTransitions)).toStrictEqual({
			applied: laterFiles.length,
			replayed: ['later-index']
		});
	});

	// Each statement applies in both orders, but the table that the independent
	// expand migration creates first lacks the column that the contract
	// migration would add.
	it('fails when an independent expand migration changes the schema that an earlier contract migration produces', () => {
		const set = migrationSet({
			'0002_contract.sql':
				'CREATE TABLE IF NOT EXISTS later (id INTEGER PRIMARY KEY, retired TEXT);',
			'0003_independent.sql':
				'CREATE TABLE IF NOT EXISTS later (id INTEGER PRIMARY KEY);'
		});

		let caught: unknown;

		try {
			checkD1Migrations(set, [cacheIdentity, independent]);
		} catch (error) {
			caught = error;
		}

		expect(caught).toStrictEqual(
			new MigrationSchemaMismatchError(
				'with deployment-transitions expanded ahead of the earlier contract migrations',
				[
					'table later: CREATE TABLE later (id INTEGER PRIMARY KEY, retired TEXT)',
					'column later.retired 1 TEXT notnull=0 pk=0 hidden=0 default=null'
				],
				['table later: CREATE TABLE later (id INTEGER PRIMARY KEY)']
			)
		);
	});
});

describe('deployOrder', () => {
	it('has no order when the deploy refuses a transition that is not independent after an incomplete one', () => {
		expect(deployOrder(laterTransitions, 0)).toBeUndefined();
	});

	it.each([
		{
			completeCount: 1,
			files: [
				'0000_base.sql',
				'0001_expand.sql',
				'0002_contract.sql',
				'0003_later.sql',
				'0005_later_index.sql',
				'0004_later_contract.sql'
			],
			ahead: ['later-index']
		},
		{
			completeCount: 2,
			files: laterFiles,
			ahead: []
		}
	])(
		"returns the deploy's order with $completeCount transitions complete",
		({ completeCount, files, ahead }) => {
			expect(deployOrder(laterTransitions, completeCount)).toStrictEqual({
				files,
				ahead
			});
		}
	);
});

it('checks the control database migration independently of the shared sequence', () => {
	const directory = path.resolve(
		import.meta.dirname,
		'../packages/server/drizzle-control-d1'
	);
	const transitions = schemaTransitions.filter(
		(transition) => transition.database === 'CONTROL_DB'
	);
	expect(
		checkD1Migrations(readMigrationSet(directory), transitions)
	).toStrictEqual({ applied: 1, replayed: [] });
});

it('refuses the shared contract before external control data work completes', () => {
	expect(() =>
		checkD1Migrations(readMigrationSet(repositoryMigrations), sharedTransitions)
	).toThrow(MigrationApplyError);
});
