import { DatabaseSync } from 'node:sqlite';

import {
	expansionLocalStep,
	type LocalStep,
	type SchemaTransition,
	type TransitionId
} from '@cupboard/protocol/deployment';
import { describe, expect, it } from 'vitest';

import {
	LocalStepUnreachedError,
	MisclassifiedD1MigrationsError,
	TransitionIncompleteError
} from '../errors.ts';

import { databaseIdSchema } from './identifiers.ts';
import { applyD1Migrations, type D1Migration } from './migrations.ts';
import { type PhaseApi, UnknownDeploymentTransitionError } from './phase.ts';
import {
	completeTransitions,
	planTransitions,
	prepareTransitions,
	type TransitionEvent,
	type TransitionWalk
} from './transitions.ts';

const databaseId = databaseIdSchema.parse('database');
const initial = new Date('2026-01-01T00:00:00.000Z');

// The migrations of a release with two transitions: the first has a contract
// that waits for the tenants to settle; the second is independent of it.
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
	settleStep: expansionLocalStep,
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

interface Fixture {
	readonly database: DatabaseSync;
	readonly api: PhaseApi;
	readonly writes: string[];
	readonly events: string[];
	readonly servingChecks: number;
	readonly settled: LocalStep[];
	walk(
		transitions: readonly SchemaTransition[],
		options?: {
			readonly requiresCompleteBefore?: TransitionId;
			readonly now?: Date;
			readonly settleTenants?: boolean;
		}
	): TransitionWalk;
}

function eventText(event: TransitionEvent): string {
	switch (event.kind) {
		case 'reconciled': {
			return `${event.transition}:reconciled:${event.state}`;
		}

		case 'deferred': {
			return `${event.transition}:deferred`;
		}

		case 'expanded': {
			return `${event.transition}:expanded:${event.applied.join('+')}`;
		}

		case 'settled': {
			return `${event.transition}:settled:${String(event.step)}`;
		}

		case 'complete': {
			return `${event.transition}:complete:${event.applied.join('+')}`;
		}
	}
}

/**
 * A walk over an in-memory SQLite database, so the deploy's statements run
 * as D1 runs them. Every write batch is recorded, the hooks count and record
 * what they are asked, and settling sets every tenant's step.
 */
function fixture(): Fixture {
	const database = new DatabaseSync(':memory:');
	const writes: string[] = [];
	const events: string[] = [];
	const settled: LocalStep[] = [];
	const counters = { servingChecks: 0 };
	const api: PhaseApi = {
		queryBatch: (_id, statements) => {
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
		settled,
		get servingChecks() {
			return counters.servingChecks;
		},
		walk: (transitions, options = {}) => ({
			api,
			databaseId,
			transitions: planTransitions(migrations, transitions),
			requiresCompleteBefore: options.requiresCompleteBefore,
			hooks: {
				now: () => options.now ?? initial,
				awaitServing: () => {
					counters.servingChecks += 1;
					return Promise.resolve();
				},
				...(options.settleTenants !== false && {
					settleTenants: (step: LocalStep) => {
						settled.push(step);
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

function recorded(database: DatabaseSync): Record<string, string> {
	const rows = database
		.prepare(
			'SELECT id, state, updated_at FROM deployment_transition ORDER BY id'
		)
		.all();

	return Object.fromEntries(
		rows.map((row) => [
			String(row.id),
			`${String(row.state)}@${String(row.updated_at)}`
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
	api: PhaseApi,
	through: string,
	writes: string[]
): Promise<void> {
	const index = migrations.findIndex((migration) => migration.name === through);
	await applyD1Migrations(api, databaseId, migrations.slice(0, index + 1));
	writes.length = 0;
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
			name: 'a migration no transition lists',
			artifact: [
				...migrations,
				{ name: '0005_new.sql', sha256: '5'.repeat(64), statements: [] }
			],
			transitions: [cacheIdentity, independent]
		},
		{
			name: 'a listed migration the artifact lacks',
			artifact: migrations.slice(0, -1),
			transitions: [cacheIdentity, independent]
		},
		{
			name: 'transitions out of name order',
			artifact: migrations,
			transitions: [independent, cacheIdentity]
		}
	])('refuses $name', ({ artifact, transitions }) => {
		expect(() => planTransitions(artifact, transitions)).toThrow(
			MisclassifiedD1MigrationsError
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
			settled: world.settled
		}).toStrictEqual({
			states: [
				['cache-identity', 'complete'],
				['deployment-transitions', 'complete']
			],
			applied: migrations.map((migration) => migration.name),
			recorded: {
				'cache-identity': 'complete@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: 'contracted@5',
			events: [
				'cache-identity:expanded:0000_base.sql+0001_phase.sql+0002_expand.sql',
				'cache-identity:complete:0003_contract.sql',
				'deployment-transitions:expanded:0004_independent.sql',
				'deployment-transitions:complete:'
			],
			servingChecks: 0,
			settled: []
		});
	});

	// A deployment on the release before phases existed has the base schema
	// and no state table of either kind.
	it('expands both transitions before the upload and contracts the first after it on a deployment from before phases', async () => {
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
			settled: world.settled
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
				'cache-identity': 'complete@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: 'contracted@5',
			events: [
				'cache-identity:expanded:',
				'cache-identity:settled:4',
				'cache-identity:complete:0003_contract.sql'
			],
			servingChecks: 1,
			settled: [expansionLocalStep]
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
				'cache-identity': 'complete@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: 'contracted@5',
			events: [
				'cache-identity:reconciled:complete',
				'deployment-transitions:expanded:0004_independent.sql',
				'deployment-transitions:complete:'
			],
			servingChecks: 0
		});
	});

	// The preceding release's deploy can complete the contraction after this
	// build recorded `expanded`, when an operator rolls back and forward.
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
				'cache-identity': 'complete@2026-01-03T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			events: ['cache-identity:reconciled:complete'],
			servingChecks: 0
		});
	});

	it('defers a dependent transition until the contract before it has run', async () => {
		const world = fixture();
		await seedApplied(world.api, '0000_base.sql', world.writes);

		await prepareTransitions(world.walk([cacheIdentity, dependent]), false);
		const prepared = {
			applied: applied(world.database),
			recorded: recorded(world.database),
			events: [...world.events]
		};
		world.events.length = 0;

		await completeTransitions(world.walk([cacheIdentity, dependent]));

		expect({
			prepared,
			applied: applied(world.database),
			recorded: recorded(world.database),
			events: world.events,
			servingChecks: world.servingChecks
		}).toStrictEqual({
			prepared: {
				applied: ['0000_base.sql', '0001_phase.sql', '0002_expand.sql'],
				recorded: { 'cache-identity': 'expanded@2026-01-01T00:00:00.000Z' },
				events: [
					'cache-identity:expanded:0001_phase.sql+0002_expand.sql',
					'deployment-transitions:deferred'
				]
			},
			applied: migrations.map((migration) => migration.name),
			recorded: {
				'cache-identity': 'complete@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			events: [
				'cache-identity:expanded:',
				'cache-identity:settled:4',
				'cache-identity:complete:0003_contract.sql',
				'deployment-transitions:expanded:0004_independent.sql',
				'deployment-transitions:complete:'
			],
			servingChecks: 1
		});
	});

	it('names the tenants behind the settle step and leaves the contract unapplied', async () => {
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
				world.walk([cacheIdentity, independent], { settleTenants: false })
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

	it('records the compatibility phase for the preceding release as its tenants settle', async () => {
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
					statement.includes("VALUES ('current', 'native-reads'")
						? 'native-reads'
						: 'contracted'
				)
		).toStrictEqual(['native-reads', 'contracted']);
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
				'cache-identity': 'complete@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			rerun: {
				'cache-identity': 'complete@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: 'contracted@5',
			rerunEvents: [],
			rerunMigrationWrites: [],
			servingChecks: 1
		});
	});

	describe('refusals before any write', () => {
		it('refuses a stored transition state this build does not define', async () => {
			const world = fixture();
			world.database.exec(
				"CREATE TABLE deployment_transition (id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO deployment_transition VALUES ('cache-identity', 'later-state', '2026-01-01T00:00:00.000Z')"
			);

			await expect(
				prepareTransitions(world.walk([cacheIdentity, independent]), false)
			).rejects.toBeInstanceOf(UnknownDeploymentTransitionError);
			expect(world.writes).toStrictEqual([]);
		});

		it('refuses a build that needs a transition the deployment has not completed', async () => {
			const world = fixture();
			await seedApplied(world.api, '0002_expand.sql', world.writes);

			let caught: unknown;

			try {
				await prepareTransitions(
					world.walk([cacheIdentity, independent], {
						requiresCompleteBefore: 'deployment-transitions'
					}),
					false
				);
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(TransitionIncompleteError);
			expect(caught).toMatchObject({
				transition: 'cache-identity',
				completedBy: 'v0.0.34'
			});
			expect(world.writes).toStrictEqual([]);
		});

		it('deploys a build whose required transition is complete', async () => {
			const world = fixture();
			await seedApplied(world.api, '0003_contract.sql', world.writes);
			world.database.exec(
				"INSERT INTO deployment_phase VALUES ('current', 'contracted', 5, '2025-12-01T00:00:00.000Z')"
			);

			const states = await prepareTransitions(
				world.walk([cacheIdentity, independent], {
					requiresCompleteBefore: 'deployment-transitions'
				}),
				false
			);

			expect([...states]).toStrictEqual([
				['cache-identity', 'complete'],
				['deployment-transitions', 'complete']
			]);
		});
	});
});
