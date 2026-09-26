import { DatabaseSync } from 'node:sqlite';

import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStep,
	type SchemaTransition
} from '@cupboard/protocol/deployment';
import { describe, expect, it } from 'vitest';

import {
	LocalStepUnreachedError,
	MisclassifiedD1MigrationsError,
	TransitionIncompleteError,
	TransitionMigrationsMissingError,
	TransitionNotExpandedError
} from '../errors.ts';

import type { D1QueryApi } from './d1-query.ts';
import {
	isFreshDeployment,
	UnknownDeploymentTransitionError,
	UnrecognisedTransitionContractedError
} from './deployment-state.ts';
import { databaseIdSchema } from './identifiers.ts';
import {
	applyD1Migrations,
	type D1Migration,
	D1MigrationDigestError
} from './migrations.ts';
import {
	completeTransitions,
	planTransitions,
	prepareTransitions,
	type TransitionEvent,
	type TransitionWalk
} from './transitions.ts';

const databaseId = databaseIdSchema.parse('database');
const initial = new Date('2026-01-01T00:00:00.000Z');

// The migrations of a release with two transitions. The first has contract
// migrations, which run only after every active or suspended tenant has
// recorded local step 4. The second is independent of the first.
const migrations: readonly D1Migration[] = [
	{
		name: '0000_base.sql',
		sha256: '0'.repeat(64),
		statements: [
			'CREATE TABLE tenant (id TEXT PRIMARY KEY, status TEXT NOT NULL, local_step INTEGER);'
		]
	},
	{
		name: '0001_phase.sql',
		sha256: '1'.repeat(64),
		statements: [
			'CREATE TABLE deployment_phase (id TEXT PRIMARY KEY, phase TEXT NOT NULL, required_local_step INTEGER NOT NULL, updated_at TEXT NOT NULL);'
		]
	},
	{
		name: '0002_expand.sql',
		sha256: '2'.repeat(64),
		statements: ['ALTER TABLE tenant ADD COLUMN legacy TEXT;']
	},
	{
		name: '0003_contract.sql',
		sha256: '3'.repeat(64),
		statements: ['ALTER TABLE tenant DROP COLUMN legacy;']
	},
	{
		name: '0004_independent.sql',
		sha256: '4'.repeat(64),
		statements: ['CREATE TABLE sweep (id INTEGER PRIMARY KEY);']
	}
];

const cacheIdentity: SchemaTransition = {
	id: 'cache-identity',
	expand: ['0000_base.sql', '0001_phase.sql', '0002_expand.sql'],
	contract: ['0003_contract.sql'],
	contractStep: expansionLocalStep,
	reportableStepOnComplete: currentLocalStep,
	compatibilityPhase: true,
	completedBy: 'v0.0.34'
};
const independent: SchemaTransition = {
	id: 'deployment-transitions',
	expand: ['0004_independent.sql'],
	contract: [],
	independent: true
};
const dependent: SchemaTransition = {
	id: 'deployment-transitions',
	expand: ['0004_independent.sql'],
	contract: []
};

const sweep: SchemaTransition<'sweep'> = { ...dependent, id: 'sweep' };

// An independent transition whose expand migration indexes the table that
// `sweep` creates.
const sweepIndexMigration: D1Migration = {
	name: '0005_sweep_index.sql',
	sha256: '5'.repeat(64),
	statements: ['CREATE INDEX sweep_id ON sweep (id);']
};
const sweepIndex: SchemaTransition<'sweep-index'> = {
	id: 'sweep-index',
	expand: ['0005_sweep_index.sql'],
	contract: [],
	independent: true
};

// The fixture throws this for an interrupted write, as if the run had stopped
// there.
class InterruptedWriteError extends Error {}

interface Fixture {
	readonly database: DatabaseSync;
	readonly api: D1QueryApi;
	readonly writes: string[];
	readonly events: string[];
	readonly servingChecks: number;
	readonly woken: LocalStep[];
	/**
	The next write batch that contains a matching statement throws.
	*/
	interruptAt(isInterrupted: (statement: string) => boolean): void;
	walk<Id extends string>(
		transitions: readonly SchemaTransition<Id>[],
		options?: {
			readonly now?: Date;
			readonly wakeTenants?: boolean;
			readonly migrations?: readonly D1Migration[];
		}
	): TransitionWalk<Id>;
}

function eventText(event: TransitionEvent<string>): string {
	switch (event.kind) {
		case 'reconciled': {
			return `${event.transition}:reconciled:${event.state}`;
		}

		case 'expanded': {
			return `${event.transition}:expanded:${event.applied.join('+')}`;
		}

		case 'tenants-ready': {
			return `${event.transition}:tenants-ready:${String(event.step)}`;
		}

		case 'complete': {
			return `${event.transition}:complete:${event.applied.join('+')}`;
		}
	}
}

/**
 * A walk over an in-memory SQLite database, so the deploy's statements run
 * as D1 runs them. The fixture records every write batch, counts the serving
 * checks, records each step passed to `wakeTenants`, and sets every
 * tenant's step to that step.
 */
function fixture(): Fixture {
	const database = new DatabaseSync(':memory:');
	const writes: string[] = [];
	const events: string[] = [];
	const woken: LocalStep[] = [];
	const counters = { servingChecks: 0 };
	let interruption: ((statement: string) => boolean) | undefined;
	const api: D1QueryApi = {
		queryBatch: (_id, statements) => {
			if (
				interruption !== undefined &&
				statements.some((statement) => interruption?.(statement) === true)
			) {
				interruption = undefined;
				return Promise.reject(new InterruptedWriteError());
			}

			writes.push(...statements);
			for (const statement of statements) {
				database.exec(statement);
			}
			return Promise.resolve();
		},
		queryRows: (_id, statement) =>
			Promise.resolve(
				database
					.prepare(statement)
					.all()
					.flatMap((row) =>
						Object.values(row).filter(
							(value): value is string => typeof value === 'string'
						)
					)
			)
	};

	return {
		database,
		api,
		writes,
		events,
		woken,
		get servingChecks() {
			return counters.servingChecks;
		},
		interruptAt: (isInterrupted) => {
			interruption = isInterrupted;
		},
		walk: (transitions, options = {}) => ({
			api,
			databaseId,
			transitions: planTransitions(
				options.migrations ?? migrations,
				transitions
			),
			hooks: {
				now: () => options.now ?? initial,
				checkServing: () => {
					counters.servingChecks += 1;
					return Promise.resolve();
				},
				...(options.wakeTenants !== false && {
					wakeTenants: (step: LocalStep) => {
						woken.push(step);
						database.prepare('UPDATE tenant SET local_step = ?').run(step);
						return Promise.resolve();
					}
				}),
				report: (event) => {
					events.push(eventText(event));
				}
			}
		})
	};
}

function applied(database: DatabaseSync): string[] {
	return database
		.prepare('SELECT name FROM d1_migrations ORDER BY name')
		.all()
		.flatMap((row) => (typeof row.name === 'string' ? [row.name] : []));
}

// Each row as `state@updated_at`, followed by `;contracted@contracted_at` when
// the row records that the contract migrations ran.
function recorded(database: DatabaseSync): Record<string, string> {
	const rows = database
		.prepare(
			'SELECT id, state, updated_at, contracted_at FROM deployment_transition ORDER BY id'
		)
		.all();

	return Object.fromEntries(
		rows.map((row) => [
			String(row.id),
			`${String(row.state)}@${String(row.updated_at)}${typeof row.contracted_at === 'string' ? `;contracted@${row.contracted_at}` : ''}`
		])
	);
}

function phase(database: DatabaseSync): string | undefined {
	const row = database
		.prepare(
			"SELECT phase || '@' || required_local_step AS phase FROM deployment_phase WHERE id = 'current'"
		)
		.get();

	return typeof row?.phase === 'string' ? row.phase : undefined;
}

// A tenant table with `count` active tenants that have never reported.
function seedTenants(database: DatabaseSync, count: number): void {
	const insert = database.prepare(
		'INSERT INTO tenant (id, status) VALUES (?, ?)'
	);

	for (let index = 0; index < count; index += 1) {
		insert.run(`tenant-${String(index)}`, 'active');
	}
}

async function seedApplied(
	api: D1QueryApi,
	through: string,
	writes: string[]
): Promise<void> {
	const index = migrations.findIndex((migration) => migration.name === through);
	await applyD1Migrations(api, databaseId, migrations.slice(0, index + 1));
	writes.length = 0;
}

const transitionTable =
	'CREATE TABLE deployment_transition (id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, contracted_at TEXT)';

// A later release added `later-transition`, applied its migration and
// recorded it in `later`, and the operator then rolled back to this build.
async function rollBackFromLaterRelease(
	world: Fixture,
	later: { readonly state: string; readonly contractedAt?: string }
): Promise<void> {
	world.database.exec(transitionTable);
	const insert = world.database.prepare(
		'INSERT INTO deployment_transition VALUES (?, ?, ?, ?)'
	);
	const insertUncontracted = world.database.prepare(
		'INSERT INTO deployment_transition (id, state, updated_at) VALUES (?, ?, ?)'
	);
	insert.run(
		'cache-identity',
		'complete',
		'2026-01-01T00:00:00.000Z',
		'2026-01-01T00:00:00.000Z'
	);
	insertUncontracted.run(
		'deployment-transitions',
		'complete',
		'2026-01-01T00:00:00.000Z'
	);

	if (later.contractedAt === undefined) {
		insertUncontracted.run(
			'later-transition',
			later.state,
			'2026-01-02T00:00:00.000Z'
		);
	} else {
		insert.run(
			'later-transition',
			later.state,
			'2026-01-02T00:00:00.000Z',
			later.contractedAt
		);
	}

	await applyD1Migrations(world.api, databaseId, [
		...migrations,
		{
			name: '0005_later.sql',
			sha256: '5'.repeat(64),
			statements: ['CREATE TABLE later (id INTEGER PRIMARY KEY);']
		}
	]);
	world.writes.length = 0;
}

describe('planTransitions', () => {
	it('assigns each migration to its transition', () => {
		expect(
			planTransitions(migrations, [cacheIdentity, independent]).map(
				(planned) => ({
					id: planned.transition.id,
					expand: planned.expand.map((migration) => migration.name),
					contract: planned.contract.map((migration) => migration.name)
				})
			)
		).toStrictEqual([
			{
				id: 'cache-identity',
				expand: ['0000_base.sql', '0001_phase.sql', '0002_expand.sql'],
				contract: ['0003_contract.sql']
			},
			{
				id: 'deployment-transitions',
				expand: ['0004_independent.sql'],
				contract: []
			}
		]);
	});

	it.each([
		{
			name: 'a migration that no transition lists',
			artifact: [
				...migrations,
				{ name: '0005_new.sql', sha256: '5'.repeat(64), statements: [] }
			],
			transitions: [cacheIdentity, independent]
		},
		{
			name: 'a listed migration that the artifact lacks',
			artifact: migrations.slice(0, -1),
			transitions: [cacheIdentity, independent]
		},
		{
			name: 'transitions out of name order',
			artifact: migrations,
			transitions: [independent, cacheIdentity]
		}
	])('throws for $name', ({ artifact, transitions }) => {
		const expected = transitions.flatMap((transition) => [
			...transition.expand,
			...transition.contract
		]);
		const found = artifact.map((migration) => migration.name);

		expect(() => planTransitions(artifact, transitions)).toThrow(
			new MisclassifiedD1MigrationsError(expected, found)
		);
	});
});

describe('transition walk', () => {
	it('applies every transition, contracts included, before the upload on a fresh database', async () => {
		const world = fixture();

		const states = await prepareTransitions(
			world.walk([cacheIdentity, independent]),
			true
		);
		await completeTransitions(world.walk([cacheIdentity, independent]));

		expect({
			states: [...states],
			applied: applied(world.database),
			recorded: recorded(world.database),
			phase: phase(world.database),
			events: world.events,
			servingChecks: world.servingChecks,
			woken: world.woken
		}).toStrictEqual({
			states: [
				['cache-identity', 'complete'],
				['deployment-transitions', 'complete']
			],
			applied: migrations.map((migration) => migration.name),
			recorded: {
				'cache-identity':
					'complete@2026-01-01T00:00:00.000Z;contracted@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: 'contracted@5',
			events: [
				'cache-identity:expanded:0000_base.sql+0001_phase.sql+0002_expand.sql',
				'cache-identity:complete:0003_contract.sql',
				'deployment-transitions:expanded:0004_independent.sql',
				'deployment-transitions:complete:'
			],
			servingChecks: 1,
			woken: []
		});
	});

	// A deployment on the release before phases existed has the base schema
	// and neither a deployment_transition nor a deployment_phase table.
	it('expands both transitions before the upload and contracts the first after it on a deployment from a release before `deployment_phase` existed', async () => {
		const world = fixture();
		await seedApplied(world.api, '0000_base.sql', world.writes);
		seedTenants(world.database, 2);

		await prepareTransitions(world.walk([cacheIdentity, independent]), false);
		const prepared = {
			applied: applied(world.database),
			recorded: recorded(world.database),
			phase: phase(world.database),
			events: [...world.events]
		};
		world.events.length = 0;

		await completeTransitions(world.walk([cacheIdentity, independent]));

		expect({
			prepared,
			applied: applied(world.database),
			recorded: recorded(world.database),
			phase: phase(world.database),
			events: world.events,
			servingChecks: world.servingChecks,
			woken: world.woken
		}).toStrictEqual({
			prepared: {
				applied: [
					'0000_base.sql',
					'0001_phase.sql',
					'0002_expand.sql',
					'0004_independent.sql'
				],
				recorded: {
					'cache-identity': 'expanded@2026-01-01T00:00:00.000Z',
					'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
				},
				phase: undefined,
				events: [
					'cache-identity:expanded:0001_phase.sql+0002_expand.sql',
					'deployment-transitions:expanded:0004_independent.sql',
					'deployment-transitions:complete:'
				]
			},
			applied: migrations.map((migration) => migration.name),
			recorded: {
				'cache-identity':
					'complete@2026-01-01T00:00:00.000Z;contracted@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: 'contracted@5',
			events: [
				'cache-identity:tenants-ready:4',
				'cache-identity:complete:0003_contract.sql'
			],
			servingChecks: 1,
			woken: [expansionLocalStep]
		});
	});

	it('reconciles a contracted phase to complete and applies only the new transition', async () => {
		const world = fixture();
		await seedApplied(world.api, '0003_contract.sql', world.writes);
		world.database.exec(
			"INSERT INTO deployment_phase VALUES ('current', 'contracted', 5, '2025-12-01T00:00:00.000Z')"
		);

		await prepareTransitions(world.walk([cacheIdentity, independent]), false);
		await completeTransitions(world.walk([cacheIdentity, independent]));

		expect({
			applied: applied(world.database),
			recorded: recorded(world.database),
			phase: phase(world.database),
			events: world.events,
			servingChecks: world.servingChecks
		}).toStrictEqual({
			applied: migrations.map((migration) => migration.name),
			recorded: {
				'cache-identity':
					'complete@2026-01-01T00:00:00.000Z;contracted@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: 'contracted@5',
			events: [
				'cache-identity:reconciled:complete',
				'deployment-transitions:expanded:0004_independent.sql',
				'deployment-transitions:complete:'
			],
			servingChecks: 1
		});
	});

	// The preceding release's deploy can apply the cache-identity contract
	// migrations after this build recorded `expanded`, when an operator rolls
	// back and forward.
	it('raises a recorded expanded state to complete from a contracted phase', async () => {
		const world = fixture();
		await seedApplied(world.api, '0003_contract.sql', world.writes);
		await prepareTransitions(world.walk([cacheIdentity, independent]), false);
		world.database.exec(
			"INSERT INTO deployment_phase VALUES ('current', 'contracted', 5, '2026-01-02T00:00:00.000Z')"
		);
		world.events.length = 0;

		await completeTransitions(
			world.walk([cacheIdentity, independent], {
				now: new Date('2026-01-03T00:00:00.000Z')
			})
		);

		expect({
			recorded: recorded(world.database),
			events: world.events,
			servingChecks: world.servingChecks
		}).toStrictEqual({
			recorded: {
				'cache-identity':
					'complete@2026-01-03T00:00:00.000Z;contracted@2026-01-03T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			events: ['cache-identity:reconciled:complete'],
			servingChecks: 1
		});
	});

	// A fresh database has no Workers serving the preceding build, so every
	// transition completes before the upload, in list order.
	it('applies a transition that is not independent before the upload on a fresh database', async () => {
		const world = fixture();

		const states = await prepareTransitions(
			world.walk([cacheIdentity, dependent]),
			true
		);

		expect({
			states: [...states],
			applied: applied(world.database),
			events: world.events
		}).toStrictEqual({
			states: [
				['cache-identity', 'complete'],
				['deployment-transitions', 'complete']
			],
			applied: migrations.map((migration) => migration.name),
			events: [
				'cache-identity:expanded:0000_base.sql+0001_phase.sql+0002_expand.sql',
				'cache-identity:complete:0003_contract.sql',
				'deployment-transitions:expanded:0004_independent.sql',
				'deployment-transitions:complete:'
			]
		});
	});

	// v0.0.34 and v0.0.35 record `native-reads` once every active or suspended
	// tenant has recorded local step 4, before they apply the contract
	// migrations.
	it('completes a deployment that the preceding release left at native-reads', async () => {
		const world = fixture();
		await seedApplied(world.api, '0002_expand.sql', world.writes);
		seedTenants(world.database, 1);
		world.database.exec(
			"INSERT INTO deployment_phase VALUES ('current', 'native-reads', 4, '2025-12-01T00:00:00.000Z')"
		);

		await prepareTransitions(world.walk([cacheIdentity, independent]), false);
		const prepared = {
			applied: applied(world.database),
			recorded: recorded(world.database),
			phase: phase(world.database),
			events: [...world.events]
		};
		world.events.length = 0;

		await completeTransitions(world.walk([cacheIdentity, independent]));

		expect({
			prepared,
			applied: applied(world.database),
			recorded: recorded(world.database),
			phase: phase(world.database),
			events: world.events,
			servingChecks: world.servingChecks,
			woken: world.woken
		}).toStrictEqual({
			prepared: {
				applied: [
					'0000_base.sql',
					'0001_phase.sql',
					'0002_expand.sql',
					'0004_independent.sql'
				],
				recorded: {
					'cache-identity': 'expanded@2026-01-01T00:00:00.000Z',
					'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
				},
				phase: 'native-reads@4',
				events: [
					'cache-identity:reconciled:expanded',
					'deployment-transitions:expanded:0004_independent.sql',
					'deployment-transitions:complete:'
				]
			},
			applied: migrations.map((migration) => migration.name),
			recorded: {
				'cache-identity':
					'complete@2026-01-01T00:00:00.000Z;contracted@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: 'contracted@5',
			events: [
				'cache-identity:tenants-ready:4',
				'cache-identity:complete:0003_contract.sql'
			],
			servingChecks: 1,
			woken: [expansionLocalStep]
		});
	});

	it('writes the compatibility phase again when a run stopped after recording the transition complete', async () => {
		const world = fixture();
		await seedApplied(world.api, '0002_expand.sql', world.writes);
		await prepareTransitions(world.walk([cacheIdentity, independent]), false);
		world.interruptAt(
			(statement) =>
				statement.startsWith('INSERT INTO deployment_phase') &&
				statement.includes("VALUES ('current', 'contracted'")
		);

		let caught: unknown;

		try {
			await completeTransitions(world.walk([cacheIdentity, independent]));
		} catch (error) {
			caught = error;
		}

		const interrupted = {
			recorded: recorded(world.database),
			phase: phase(world.database)
		};
		const later = new Date('2026-02-01T00:00:00.000Z');
		await prepareTransitions(
			world.walk([cacheIdentity, independent], { now: later }),
			false
		);
		await completeTransitions(
			world.walk([cacheIdentity, independent], { now: later })
		);

		expect(caught).toBeInstanceOf(InterruptedWriteError);
		expect({
			interrupted,
			rerun: {
				recorded: recorded(world.database),
				phase: phase(world.database)
			}
		}).toStrictEqual({
			interrupted: {
				recorded: {
					'cache-identity':
						'complete@2026-01-01T00:00:00.000Z;contracted@2026-01-01T00:00:00.000Z',
					'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
				},
				phase: 'native-reads@4'
			},
			rerun: {
				recorded: {
					'cache-identity':
						'complete@2026-01-01T00:00:00.000Z;contracted@2026-01-01T00:00:00.000Z',
					'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
				},
				phase: 'contracted@5'
			}
		});
	});

	it('reports the tenants below the required local step and leaves the contract migrations unapplied', async () => {
		const world = fixture();
		await seedApplied(world.api, '0002_expand.sql', world.writes);
		seedTenants(world.database, 3);
		world.database
			.prepare("UPDATE tenant SET local_step = ? WHERE id = 'tenant-1'")
			.run(expansionLocalStep);

		await prepareTransitions(world.walk([cacheIdentity, independent]), false);

		let caught: unknown;

		try {
			await completeTransitions(
				world.walk([cacheIdentity, independent], { wakeTenants: false })
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(LocalStepUnreachedError);
		expect({
			pending: caught instanceof LocalStepUnreachedError && caught.pending,
			stragglers:
				caught instanceof LocalStepUnreachedError && caught.stragglers,
			applied: applied(world.database),
			recorded: recorded(world.database),
			phase: phase(world.database)
		}).toStrictEqual({
			pending: 2,
			stragglers: ['tenant-0', 'tenant-2'],
			applied: [
				'0000_base.sql',
				'0001_phase.sql',
				'0002_expand.sql',
				'0004_independent.sql'
			],
			recorded: {
				'cache-identity': 'expanded@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: undefined
		});
	});

	it('writes native-reads and then contracted to the deployment_phase row for the preceding release', async () => {
		const world = fixture();
		await seedApplied(world.api, '0002_expand.sql', world.writes);
		seedTenants(world.database, 1);
		await prepareTransitions(world.walk([cacheIdentity, independent]), false);
		world.writes.length = 0;

		await completeTransitions(world.walk([cacheIdentity, independent]));

		expect(
			world.writes
				.filter((statement) =>
					statement.startsWith('INSERT INTO deployment_phase')
				)
				.map((statement) =>
					/VALUES \('current', '([^']*)', (\d+)/.exec(statement)?.slice(1)
				)
		).toStrictEqual([
			['native-reads', '4'],
			['contracted', '5']
		]);
	});

	it('is idempotent when run again at each point and never lowers a state', async () => {
		const world = fixture();
		await seedApplied(world.api, '0000_base.sql', world.writes);
		const later = new Date('2026-02-01T00:00:00.000Z');

		await prepareTransitions(world.walk([cacheIdentity, independent]), false);
		await prepareTransitions(
			world.walk([cacheIdentity, independent], { now: later }),
			false
		);
		const afterPrepare = recorded(world.database);
		await completeTransitions(world.walk([cacheIdentity, independent]));
		const afterComplete = recorded(world.database);
		world.writes.length = 0;
		world.events.length = 0;

		await prepareTransitions(
			world.walk([cacheIdentity, independent], { now: later }),
			false
		);
		await completeTransitions(
			world.walk([cacheIdentity, independent], { now: later })
		);

		expect({
			afterPrepare,
			afterComplete,
			rerun: recorded(world.database),
			phase: phase(world.database),
			rerunEvents: world.events,
			rerunMigrationWrites: world.writes.filter((statement) =>
				statement.startsWith('INSERT INTO d1_migrations')
			),
			servingChecks: world.servingChecks
		}).toStrictEqual({
			afterPrepare: {
				'cache-identity': 'expanded@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			afterComplete: {
				'cache-identity':
					'complete@2026-01-01T00:00:00.000Z;contracted@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			rerun: {
				'cache-identity':
					'complete@2026-01-01T00:00:00.000Z;contracted@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: 'contracted@5',
			rerunEvents: [],
			rerunMigrationWrites: [],
			servingChecks: 2
		});
	});

	it.each([
		{ name: 'expanded', state: 'expanded' },
		{ name: 'complete without contract migrations', state: 'complete' }
	])(
		'leaves a transition that this build does not define unchanged when it is $name',
		async ({ state }) => {
			const world = fixture();
			await rollBackFromLaterRelease(world, { state });

			await prepareTransitions(world.walk([cacheIdentity, independent]), false);
			await completeTransitions(world.walk([cacheIdentity, independent]));

			expect({
				recorded: recorded(world.database),
				applied: applied(world.database),
				events: world.events,
				servingChecks: world.servingChecks
			}).toStrictEqual({
				recorded: {
					'cache-identity':
						'complete@2026-01-01T00:00:00.000Z;contracted@2026-01-01T00:00:00.000Z',
					'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z',
					'later-transition': `${state}@2026-01-02T00:00:00.000Z`
				},
				applied: [
					'0000_base.sql',
					'0001_phase.sql',
					'0002_expand.sql',
					'0003_contract.sql',
					'0004_independent.sql',
					'0005_later.sql'
				],
				events: [],
				servingChecks: 1
			});
		}
	);

	// A later release adds `later-transition`, whose contract migrations drop a
	// column. Its deploy stops after the first of them, and the operator rolls
	// back to this build.
	it('refuses a transition that this build does not define once a later release has started its contract migrations', async () => {
		const world = fixture();
		const laterMigrations: readonly D1Migration[] = [
			...migrations,
			{
				name: '0005_later.sql',
				sha256: '5'.repeat(64),
				statements: ['ALTER TABLE tenant ADD COLUMN later TEXT;']
			},
			{
				name: '0006_later_contract.sql',
				sha256: '6'.repeat(64),
				statements: ['ALTER TABLE tenant DROP COLUMN later;']
			},
			{
				name: '0007_later_contract.sql',
				sha256: '7'.repeat(64),
				statements: ['CREATE TABLE later_done (id INTEGER PRIMARY KEY);']
			}
		];
		const later: SchemaTransition<'later-transition'> = {
			id: 'later-transition',
			expand: ['0005_later.sql'],
			contract: ['0006_later_contract.sql', '0007_later_contract.sql'],
			independent: true
		};
		await seedApplied(world.api, '0000_base.sql', world.writes);
		await prepareTransitions(world.walk([cacheIdentity, independent]), false);
		await completeTransitions(world.walk([cacheIdentity, independent]));
		const laterRelease = world.walk([cacheIdentity, independent, later], {
			migrations: laterMigrations
		});
		await prepareTransitions(laterRelease, false);
		world.interruptAt((statement) => statement.includes('later_done'));
		await expect(completeTransitions(laterRelease)).rejects.toBeInstanceOf(
			InterruptedWriteError
		);
		world.writes.length = 0;

		await expect(
			prepareTransitions(world.walk([cacheIdentity, independent]), false)
		).rejects.toStrictEqual(
			new UnrecognisedTransitionContractedError('later-transition')
		);
		expect({
			laterRow: recorded(world.database)['later-transition'],
			writes: world.writes
		}).toStrictEqual({
			laterRow:
				'expanded@2026-01-01T00:00:00.000Z;contracted@2026-01-01T00:00:00.000Z',
			writes: []
		});
	});

	// The upload happens between the two halves of the deploy, and another
	// writer can record the contracted phase in that window.
	it('stops after the upload when the contracted phase appears without the contract migrations', async () => {
		const world = fixture();
		await seedApplied(world.api, '0002_expand.sql', world.writes);
		await prepareTransitions(world.walk([cacheIdentity, independent]), false);
		world.database.exec(
			"INSERT INTO deployment_phase VALUES ('current', 'contracted', 5, '2026-01-02T00:00:00.000Z')"
		);
		world.writes.length = 0;

		let caught: unknown;

		try {
			await completeTransitions(world.walk([cacheIdentity, independent]));
		} catch (error) {
			caught = error;
		}

		expect({
			caught,
			writes: world.writes,
			servingChecks: world.servingChecks
		}).toStrictEqual({
			caught: new TransitionMigrationsMissingError('cache-identity', [
				'0003_contract.sql'
			]),
			writes: [],
			servingChecks: 0
		});
	});

	// A first deploy can stop after the migration that creates `tenant` and
	// before the upload. The next run must still treat the database as fresh,
	// or a transition that is not independent would block it.
	it('finishes a first deploy that stopped before the upload', async () => {
		const world = fixture();
		world.interruptAt((statement) =>
			statement.startsWith('ALTER TABLE tenant ADD COLUMN legacy')
		);
		await expect(
			prepareTransitions(world.walk([cacheIdentity, dependent]), true)
		).rejects.toBeInstanceOf(InterruptedWriteError);

		const isFresh = await isFreshDeployment(world.api, databaseId, () =>
			Promise.resolve(false)
		);
		await prepareTransitions(world.walk([cacheIdentity, dependent]), isFresh);

		expect({ isFresh, recorded: recorded(world.database) }).toStrictEqual({
			isFresh: true,
			recorded: {
				'cache-identity':
					'complete@2026-01-01T00:00:00.000Z;contracted@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			}
		});
	});

	it('corrects the local step of a contracted phase row', async () => {
		const world = fixture();
		await seedApplied(world.api, '0004_independent.sql', world.writes);
		world.database.exec(
			"INSERT INTO deployment_phase VALUES ('current', 'contracted', 4, '2025-12-01T00:00:00.000Z')"
		);

		await prepareTransitions(world.walk([cacheIdentity, independent]), false);

		expect(phase(world.database)).toBe('contracted@5');
	});

	describe('errors before any write', () => {
		it('stops on a contracted transition that this build does not define', async () => {
			const world = fixture();
			await rollBackFromLaterRelease(world, {
				state: 'complete',
				contractedAt: '2026-01-02T00:00:00.000Z'
			});

			await expect(
				prepareTransitions(world.walk([cacheIdentity, independent]), false)
			).rejects.toStrictEqual(
				new UnrecognisedTransitionContractedError('later-transition')
			);
			expect(world.writes).toStrictEqual([]);
		});

		it('stops on a stored transition state that this build does not define', async () => {
			const world = fixture();
			world.database.exec(
				`${transitionTable}; INSERT INTO deployment_transition (id, state, updated_at) VALUES ('cache-identity', 'later-state', '2026-01-01T00:00:00.000Z')`
			);

			await expect(
				prepareTransitions(world.walk([cacheIdentity, independent]), false)
			).rejects.toStrictEqual(
				new UnknownDeploymentTransitionError(
					'cache-identity',
					'later-state',
					true
				)
			);
			expect(world.writes).toStrictEqual([]);
		});

		it.each([
			{
				name: 'a transition that is not independent after it',
				transitions: [cacheIdentity, dependent],
				migrations,
				dependent: 'deployment-transitions'
			},
			{
				name: 'a transition that is not independent before an independent one',
				transitions: [cacheIdentity, sweep, sweepIndex],
				migrations: [...migrations, sweepIndexMigration],
				dependent: 'sweep'
			}
		])(
			'stops on $name while cache-identity is incomplete',
			async ({ transitions, migrations: artifact, dependent: blocked }) => {
				const world = fixture();
				await seedApplied(world.api, '0000_base.sql', world.writes);

				let caught: unknown;

				try {
					await prepareTransitions(
						world.walk(transitions, { migrations: artifact }),
						false
					);
				} catch (error) {
					caught = error;
				}

				expect(caught).toBeInstanceOf(TransitionIncompleteError);
				expect({
					transition:
						caught instanceof TransitionIncompleteError && caught.transition,
					dependent:
						caught instanceof TransitionIncompleteError && caught.dependent,
					completedBy:
						caught instanceof TransitionIncompleteError && caught.completedBy,
					writes: world.writes
				}).toStrictEqual({
					transition: 'cache-identity',
					dependent: blocked,
					completedBy: 'v0.0.34',
					writes: []
				});
			}
		);

		// A migration appended to a transition that the deployment has completed
		// would never be applied, because the walk skips complete transitions.
		it('stops on a complete transition that lists a migration that the deployment has not applied', async () => {
			const world = fixture();
			await seedApplied(world.api, '0000_base.sql', world.writes);
			await prepareTransitions(world.walk([cacheIdentity, independent]), false);
			await completeTransitions(world.walk([cacheIdentity, independent]));
			world.writes.length = 0;
			const appended: SchemaTransition = {
				...independent,
				expand: ['0004_independent.sql', '0005_sweep_index.sql']
			};

			let caught: unknown;

			try {
				await prepareTransitions(
					world.walk([cacheIdentity, appended], {
						migrations: [...migrations, sweepIndexMigration]
					}),
					false
				);
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(TransitionMigrationsMissingError);
			expect({
				transition:
					caught instanceof TransitionMigrationsMissingError &&
					caught.transition,
				migrations:
					caught instanceof TransitionMigrationsMissingError &&
					caught.migrations,
				writes: world.writes
			}).toStrictEqual({
				transition: 'deployment-transitions',
				migrations: ['0005_sweep_index.sql'],
				writes: []
			});
		});

		// The contracted phase implies that cache-identity is complete, so its
		// contract migrations must be recorded as applied too.
		it('stops on a transition reconciled from the contracted phase whose migrations are not all applied', async () => {
			const world = fixture();
			await seedApplied(world.api, '0002_expand.sql', world.writes);
			world.database.exec(
				"INSERT INTO deployment_phase VALUES ('current', 'contracted', 5, '2025-12-01T00:00:00.000Z')"
			);

			let caught: unknown;

			try {
				await prepareTransitions(
					world.walk([cacheIdentity, independent]),
					false
				);
			} catch (error) {
				caught = error;
			}

			expect({ caught, writes: world.writes }).toStrictEqual({
				caught: new TransitionMigrationsMissingError('cache-identity', [
					'0003_contract.sql'
				]),
				writes: []
			});
		});

		it('stops after the upload when a transition has not expanded', async () => {
			const world = fixture();
			await seedApplied(world.api, '0000_base.sql', world.writes);

			let caught: unknown;

			try {
				await completeTransitions(world.walk([cacheIdentity, independent]));
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(TransitionNotExpandedError);
			expect({
				transition:
					caught instanceof TransitionNotExpandedError && caught.transition,
				writes: world.writes,
				servingChecks: world.servingChecks
			}).toStrictEqual({
				transition: 'cache-identity',
				writes: [],
				servingChecks: 0
			});
		});

		it.each([
			{
				name: 'a transition that this build completed',
				seed: async (world: Fixture) => {
					await seedApplied(world.api, '0000_base.sql', world.writes);
					await prepareTransitions(
						world.walk([cacheIdentity, independent]),
						false
					);
					await completeTransitions(world.walk([cacheIdentity, independent]));
				}
			},
			{
				name: 'a transition reconciled from the contracted phase',
				seed: async (world: Fixture) => {
					await seedApplied(world.api, '0004_independent.sql', world.writes);
					world.database.exec(
						"INSERT INTO deployment_phase VALUES ('current', 'contracted', 5, '2025-12-01T00:00:00.000Z')"
					);
				}
			}
		])('stops on a changed migration of $name', async ({ seed }) => {
			const world = fixture();
			await seed(world);
			world.database.exec(
				`UPDATE d1_migrations SET sha256 = '${'f'.repeat(64)}' WHERE name = '0003_contract.sql'`
			);
			world.writes.length = 0;

			let caught: unknown;

			try {
				await prepareTransitions(
					world.walk([cacheIdentity, independent]),
					false
				);
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(D1MigrationDigestError);
			expect({
				migration:
					caught instanceof D1MigrationDigestError && caught.migrationName,
				recorded:
					caught instanceof D1MigrationDigestError && caught.recordedSha256,
				file: caught instanceof D1MigrationDigestError && caught.fileSha256,
				writes: world.writes
			}).toStrictEqual({
				migration: '0003_contract.sql',
				recorded: 'f'.repeat(64),
				file: '3'.repeat(64),
				writes: []
			});
		});
	});
});
