import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { DatabaseSync } from 'node:sqlite';

import {
	localStep,
	schemaTransitions,
	type TransitionStates
} from '@cupboard/protocol/deployment';
import Cloudflare from 'cloudflare';
import { describe, expect, it } from 'vitest';

import { createCloudflareApi } from './cloudflare-api.ts';
import type { D1QueryApi } from './d1-query.ts';
import {
	ensurePhaseTableStatement,
	ensureTransitionTable,
	ensureTransitionTableStatement,
	InvalidTenantReadinessCountError,
	InvalidTransitionRowError,
	isFreshDeployment,
	readCompatibilityPhase,
	readLocalStepReadiness,
	readStoredTransition,
	readTransitionsForDeploy,
	reconcileTransitionStates,
	recordCompatibilityPhase,
	recordTransition,
	refusalError,
	UnknownDeploymentTransitionError,
	UnrecognisedTransitionContractedError
} from './deployment-state.ts';
import {
	cloudflareAccountIdSchema,
	type DatabaseId,
	databaseIdSchema
} from './identifiers.ts';

const databaseId = databaseIdSchema.parse('database');
const requiredStep = localStep(1);
const ids = schemaTransitions.map((transition) => transition.id);

/**
 * A `D1QueryApi` whose `queryRows` returns each of `answers` in turn, one per
 * call, and records the SQL so a test can assert which queries ran.
 */
function stubApi(...answers: readonly (readonly string[])[]): D1QueryApi & {
	readonly queries: string[];
} {
	const queries: string[] = [];
	let call = 0;

	return {
		queries,
		queryBatch: () => Promise.resolve(),
		queryRows: (_database: DatabaseId, sql: string) => {
			queries.push(sql);
			const answer = answers[call] ?? [];

			call += 1;

			return Promise.resolve(answer);
		}
	};
}

/**
 * The real `d1QueryRows` over an in-memory SQLite `tenant` table. The
 * Cloudflare client's `fetch` runs each posted query on the database and
 * answers with the D1 response envelope, so the wrapper receives the same
 * column types as from D1.
 */
function sqliteBackedApi(
	rows: readonly {
		id: string;
		status: string;
		localStep: number | undefined;
	}[]
): D1QueryApi {
	const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
	const database: DatabaseSync = new DatabaseSync(':memory:');

	database
		.prepare(
			'CREATE TABLE tenant (id TEXT PRIMARY KEY, status TEXT NOT NULL, local_step INTEGER)'
		)
		.run();

	const insertStepped = database.prepare(
		'INSERT INTO tenant (id, status, local_step) VALUES (?, ?, ?)'
	);
	const insertUnstepped = database.prepare(
		'INSERT INTO tenant (id, status) VALUES (?, ?)'
	);

	for (const row of rows) {
		if (row.localStep === undefined) {
			insertUnstepped.run(row.id, row.status);
			continue;
		}

		insertStepped.run(row.id, row.status, row.localStep);
	}

	const fetcher: typeof fetch = (_input, init) => {
		const body: unknown =
			typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
		const sql =
			typeof body === 'object' && body !== null && 'sql' in body
				? String(body.sql)
				: '';
		const results = database.prepare(sql).all();

		return Promise.resolve(
			Response.json({
				success: true,
				errors: [],
				messages: [],
				result: [{ results }]
			})
		);
	};

	const api = createCloudflareApi(
		new Cloudflare({ apiToken: 'token', fetch: fetcher }),
		cloudflareAccountIdSchema.parse('acc-1')
	);

	return {
		queryBatch: (id, statements) => api.d1QueryBatch(id, statements),
		queryRows: (id, sql) => api.d1QueryRows(id, sql)
	};
}

/**
 * A `D1QueryApi` over an empty in-memory SQLite database, so the statements
 * that the deploy sends run as D1 would run them.
 */
function sqliteApi(): D1QueryApi & { readonly database: DatabaseSync } {
	const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
	const database = new DatabaseSync(':memory:');

	return {
		database,
		queryBatch: (_id, statements) => {
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
}

describe('local step readiness', () => {
	it.each([[], ['invalid'], ['-1'], ['1.5'], ['9007199254740992']])(
		'rejects an invalid readiness count %j',
		async (...answer: string[]) => {
			await expect(
				readLocalStepReadiness(stubApi(answer), databaseId, requiredStep)
			).rejects.toBeInstanceOf(InvalidTenantReadinessCountError);
		}
	);

	it('reports no pending tenants and runs no straggler query', async () => {
		const api = stubApi(['0']);

		expect(
			await readLocalStepReadiness(api, databaseId, requiredStep)
		).toStrictEqual({ pending: 0, stragglers: [] });
		expect(api.queries).toHaveLength(1);
	});

	it('counts the active and suspended tenants below the step', async () => {
		const api = sqliteBackedApi([
			{ id: 'alpha', status: 'active', localStep: undefined },
			{ id: 'beta', status: 'active', localStep: 0 },
			{ id: 'gamma', status: 'active', localStep: 1 },
			{ id: 'delta', status: 'suspended', localStep: undefined }
		]);

		expect(
			await readLocalStepReadiness(api, databaseId, requiredStep)
		).toStrictEqual({ pending: 3, stragglers: ['alpha', 'beta', 'delta'] });
	});
});

describe('isFreshDeployment', () => {
	it.each([
		{
			name: 'no tenant table',
			setup: '',
			scriptsExist: true,
			expected: { isFresh: true, scriptChecks: 0 }
		},
		{
			name: 'a tenant',
			setup:
				"CREATE TABLE tenant (id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO tenant VALUES ('acme', 'deleted')",
			scriptsExist: false,
			expected: { isFresh: false, scriptChecks: 0 }
		},
		{
			name: 'no tenants and no Worker scripts',
			setup: 'CREATE TABLE tenant (id TEXT PRIMARY KEY, status TEXT NOT NULL)',
			scriptsExist: false,
			expected: { isFresh: true, scriptChecks: 1 }
		},
		{
			name: 'no tenants and a Worker script',
			setup: 'CREATE TABLE tenant (id TEXT PRIMARY KEY, status TEXT NOT NULL)',
			scriptsExist: true,
			expected: { isFresh: false, scriptChecks: 1 }
		}
	])(
		'decides freshness with $name',
		async ({ setup, scriptsExist, expected }) => {
			const api = sqliteApi();

			try {
				if (setup !== '') {
					api.database.exec(setup);
				}

				let scriptChecks = 0;
				const isFresh = await isFreshDeployment(api, databaseId, () => {
					scriptChecks += 1;
					return Promise.resolve(scriptsExist);
				});

				expect({ isFresh, scriptChecks }).toStrictEqual(expected);
			} finally {
				api.database.close();
			}
		}
	);
});

describe('transition records', () => {
	it('reads no transitions before a deploy has created the table', async () => {
		const api = sqliteApi();

		try {
			await expect(
				readTransitionsForDeploy(api, databaseId, ids)
			).resolves.toStrictEqual({ defined: [], unrecognised: [] });
		} finally {
			api.database.close();
		}
	});

	it('preserves a completed transition and its timestamp across reruns', async () => {
		const api = sqliteApi();

		try {
			const initial = new Date('2026-01-01T00:00:00.000Z');
			const later = new Date('2026-01-02T00:00:00.000Z');
			await ensureTransitionTable(api, databaseId);
			await ensureTransitionTable(api, databaseId);
			await recordTransition(
				api,
				databaseId,
				'cache-identity',
				'expanded',
				initial
			);
			const { defined: expanded } = await readTransitionsForDeploy(
				api,
				databaseId,
				ids
			);
			await recordTransition(
				api,
				databaseId,
				'cache-identity',
				'complete',
				later
			);
			await recordTransition(
				api,
				databaseId,
				'cache-identity',
				'complete',
				new Date('2026-01-03T00:00:00.000Z')
			);
			const { defined: repeated } = await readTransitionsForDeploy(
				api,
				databaseId,
				ids
			);
			await recordTransition(
				api,
				databaseId,
				'cache-identity',
				'expanded',
				new Date('2026-01-04T00:00:00.000Z')
			);
			const { defined: lowered } = await readTransitionsForDeploy(
				api,
				databaseId,
				ids
			);

			expect({ expanded, repeated, lowered }).toStrictEqual({
				expanded: [
					{
						id: 'cache-identity',
						state: 'expanded',
						updatedAt: initial.toISOString()
					}
				],
				repeated: [
					{
						id: 'cache-identity',
						state: 'complete',
						updatedAt: later.toISOString()
					}
				],
				lowered: [
					{
						id: 'cache-identity',
						state: 'complete',
						updatedAt: later.toISOString()
					}
				]
			});
		} finally {
			api.database.close();
		}
	});

	it('records each transition in its own row', async () => {
		const api = sqliteApi();

		try {
			const now = new Date('2026-01-01T00:00:00.000Z');
			await ensureTransitionTable(api, databaseId);
			await recordTransition(
				api,
				databaseId,
				'deployment-transitions',
				'complete',
				now
			);
			await recordTransition(
				api,
				databaseId,
				'cache-identity',
				'expanded',
				now
			);

			const { defined: rows } = await readTransitionsForDeploy(
				api,
				databaseId,
				ids
			);

			expect(rows).toStrictEqual([
				{
					id: 'cache-identity',
					state: 'expanded',
					updatedAt: now.toISOString()
				},
				{
					id: 'deployment-transitions',
					state: 'complete',
					updatedAt: now.toISOString()
				}
			]);
		} finally {
			api.database.close();
		}
	});

	// The deploy's statements must leave the same `sqlite_master` text as the
	// migrations, whichever of the two creates each table.
	it.each([
		{
			name: '0031',
			file: '0031_deployment_transitions.sql',
			statement: ensureTransitionTableStatement,
			addsIfNotExists: false
		},
		{
			name: '0021',
			file: '0021_deployment_phase.sql',
			statement: ensurePhaseTableStatement,
			addsIfNotExists: true
		}
	])(
		'creates a table with the statement that migration $name runs',
		({ file, statement, addsIfNotExists }) => {
			const migration = readFileSync(
				path.resolve(import.meta.dirname, '../../../server/drizzle-d1', file),
				'utf8'
			)
				.split('\n')
				.filter((line) => !line.startsWith('--'))
				.join('\n')
				.trim();

			expect(statement).toBe(
				addsIfNotExists
					? migration.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')
					: migration
			);
		}
	);

	it('records when a transition contracted, and keeps the first time', async () => {
		const api = sqliteApi();

		try {
			const initial = new Date('2026-01-01T00:00:00.000Z');
			const later = new Date('2026-01-02T00:00:00.000Z');
			await ensureTransitionTable(api, databaseId);
			await recordTransition(
				api,
				databaseId,
				'cache-identity',
				'complete',
				initial,
				{
					contractStarted: true
				}
			);
			await recordTransition(
				api,
				databaseId,
				'cache-identity',
				'complete',
				later,
				{
					contractStarted: true
				}
			);
			await recordTransition(
				api,
				databaseId,
				'deployment-transitions',
				'complete',
				initial
			);

			expect(
				api.database
					.prepare(
						"SELECT id, state, updated_at, COALESCE(contracted_at, 'not contracted') AS contracted_at FROM deployment_transition ORDER BY id"
					)
					.all()
					.map((row) => ({ ...row }))
			).toStrictEqual([
				{
					id: 'cache-identity',
					state: 'complete',
					updated_at: initial.toISOString(),
					contracted_at: initial.toISOString()
				},
				{
					id: 'deployment-transitions',
					state: 'complete',
					updated_at: initial.toISOString(),
					contracted_at: 'not contracted'
				}
			]);
		} finally {
			api.database.close();
		}
	});

	it('returns the rows of transitions that this build does not define and that have not contracted', async () => {
		const api = sqliteApi();

		try {
			await ensureTransitionTable(api, databaseId);
			const insert = api.database.prepare(
				'INSERT INTO deployment_transition (id, state, updated_at) VALUES (?, ?, ?)'
			);
			insert.run('later-expanded', 'expanded', '2026-01-02T00:00:00.000Z');
			insert.run('later-complete', 'complete', '2026-01-03T00:00:00.000Z');
			await recordTransition(
				api,
				databaseId,
				'cache-identity',
				'complete',
				new Date('2026-01-01T00:00:00.000Z')
			);

			expect(
				await readTransitionsForDeploy(api, databaseId, ids)
			).toStrictEqual({
				defined: [
					{
						id: 'cache-identity',
						state: 'complete',
						updatedAt: '2026-01-01T00:00:00.000Z'
					}
				],
				unrecognised: [
					{
						id: 'later-complete',
						state: 'complete',
						updatedAt: '2026-01-03T00:00:00.000Z'
					},
					{
						id: 'later-expanded',
						state: 'expanded',
						updatedAt: '2026-01-02T00:00:00.000Z'
					}
				]
			});
		} finally {
			api.database.close();
		}
	});

	it('throws for a row with a field that contains the separator', async () => {
		const api = sqliteApi();

		try {
			await ensureTransitionTable(api, databaseId);
			api.database
				.prepare(
					'INSERT INTO deployment_transition (id, state, updated_at) VALUES (?, ?, ?)'
				)
				.run('later|transition', 'expanded', '2026-01-01T00:00:00.000Z');

			await expect(
				readTransitionsForDeploy(api, databaseId, ids)
			).rejects.toStrictEqual(
				new InvalidTransitionRowError(
					'later|transition|expanded|2026-01-01T00:00:00.000Z|'
				)
			);
		} finally {
			api.database.close();
		}
	});

	it('throws for a stored row that the deploy refuses', async () => {
		const api = sqliteApi();

		try {
			await ensureTransitionTable(api, databaseId);
			api.database
				.prepare('INSERT INTO deployment_transition VALUES (?, ?, ?, ?)')
				.run(
					'later-transition',
					'complete',
					'2026-01-01T00:00:00.000Z',
					'2026-01-01T00:00:00.000Z'
				);

			await expect(
				readTransitionsForDeploy(api, databaseId, ids)
			).rejects.toStrictEqual(
				new UnrecognisedTransitionContractedError('later-transition')
			);
		} finally {
			api.database.close();
		}
	});
});

describe('readStoredTransition', () => {
	const updatedAt = '2026-01-01T00:00:00.000Z';

	it.each([
		{
			name: 'a defined transition and state',
			row: {
				id: 'cache-identity',
				state: 'expanded',
				updatedAt
			},
			expected: {
				kind: 'defined',
				transition: { id: 'cache-identity', state: 'expanded', updatedAt }
			}
		},
		{
			name: 'an expanded transition that this build does not define',
			row: {
				id: 'later-transition',
				state: 'expanded',
				updatedAt
			},
			expected: {
				kind: 'unrecognised',
				row: {
					id: 'later-transition',
					state: 'expanded',
					updatedAt
				}
			}
		},
		{
			name: 'a complete transition without contract migrations that this build does not define',
			row: {
				id: 'later-transition',
				state: 'complete',
				updatedAt
			},
			expected: {
				kind: 'unrecognised',
				row: {
					id: 'later-transition',
					state: 'complete',
					updatedAt
				}
			}
		},
		{
			name: 'an expanded transition that this build does not define and whose contract migrations have started',
			row: {
				id: 'later-transition',
				state: 'expanded',
				updatedAt,
				contractedAt: updatedAt
			},
			expected: {
				kind: 'refused',
				reason: 'contracted',
				row: {
					id: 'later-transition',
					state: 'expanded',
					updatedAt,
					contractedAt: updatedAt
				}
			}
		},
		{
			name: 'a contracted transition that this build does not define',
			row: {
				id: 'later-transition',
				state: 'complete',
				updatedAt,
				contractedAt: updatedAt
			},
			expected: {
				kind: 'refused',
				reason: 'contracted',
				row: {
					id: 'later-transition',
					state: 'complete',
					updatedAt,
					contractedAt: updatedAt
				}
			}
		},
		{
			name: 'a transition and a state that this build does not define',
			row: {
				id: 'later-transition',
				state: 'later-state',
				updatedAt
			},
			expected: {
				kind: 'refused',
				reason: 'unknown-transition-and-state',
				row: {
					id: 'later-transition',
					state: 'later-state',
					updatedAt
				}
			}
		},
		{
			name: 'a defined transition in a state that this build does not define',
			row: {
				id: 'cache-identity',
				state: 'later-state',
				updatedAt
			},
			expected: {
				kind: 'refused',
				reason: 'unknown-state',
				row: {
					id: 'cache-identity',
					state: 'later-state',
					updatedAt
				}
			}
		}
	])('reads $name', ({ row, expected }) => {
		expect(readStoredTransition(ids, row)).toStrictEqual(expected);
	});

	it.each([
		{
			reason: 'contracted' as const,
			error: new UnrecognisedTransitionContractedError('later-transition')
		},
		{
			reason: 'unknown-state' as const,
			error: new UnknownDeploymentTransitionError(
				'later-transition',
				'later-state',
				'unknown-state'
			)
		},
		{
			reason: 'unknown-transition-and-state' as const,
			error: new UnknownDeploymentTransitionError(
				'later-transition',
				'later-state',
				'unknown-transition-and-state'
			)
		}
	])('throws the error for a $reason row', ({ reason, error }) => {
		expect(
			refusalError(reason, {
				id: 'later-transition',
				state: 'later-state',
				updatedAt
			})
		).toStrictEqual(error);
	});
});

describe('reconcileTransitionStates', () => {
	const none: TransitionStates = new Map();
	const expanded: TransitionStates = new Map([['cache-identity', 'expanded']]);
	const complete: TransitionStates = new Map([['cache-identity', 'complete']]);

	it.each([
		{ name: 'no phase', stored: none, phase: undefined, expected: none },
		{ name: 'current', stored: none, phase: 'current', expected: none },
		{ name: 'expanded', stored: none, phase: 'expanded', expected: none },
		{
			name: 'native-reads',
			stored: none,
			phase: 'native-reads',
			expected: expanded
		},
		{
			name: 'contracted',
			stored: none,
			phase: 'contracted',
			expected: complete
		},
		{
			name: 'contracted over expanded',
			stored: expanded,
			phase: 'contracted',
			expected: complete
		},
		{
			name: 'native-reads over complete',
			stored: complete,
			phase: 'native-reads',
			expected: complete
		},
		{
			name: 'a phase that this build does not list',
			stored: none,
			phase: 'later-phase',
			expected: none
		}
	])('reconciles the states with $name', ({ stored, phase, expected }) => {
		expect(
			reconcileTransitionStates(stored, phase, schemaTransitions)
		).toStrictEqual(expected);
	});

	it('raises every transition that sets compatibilityPhase', () => {
		const [cacheIdentity] = schemaTransitions;

		if (cacheIdentity === undefined) {
			throw new Error('schemaTransitions has no first transition');
		}

		const second = { ...cacheIdentity, id: 'deployment-transitions' as const };

		expect(
			reconcileTransitionStates(none, 'contracted', [cacheIdentity, second])
		).toStrictEqual(
			new Map([
				['cache-identity', 'complete'],
				['deployment-transitions', 'complete']
			])
		);
	});

	it('leaves the states alone when no transition sets compatibilityPhase', () => {
		expect(
			reconcileTransitionStates(
				none,
				'contracted',
				schemaTransitions.filter(
					(transition) => transition.compatibilityPhase !== true
				)
			)
		).toStrictEqual(none);
	});
});

describe('compatibility phase records', () => {
	it('preserves a completed phase and its timestamp across reruns', async () => {
		const api = sqliteApi();
		api.database.exec(
			'CREATE TABLE deployment_phase (id TEXT PRIMARY KEY, phase TEXT NOT NULL, required_local_step INTEGER NOT NULL, updated_at TEXT NOT NULL)'
		);
		try {
			const initial = new Date('2026-01-01T00:00:00.000Z');
			const later = new Date('2026-01-02T00:00:00.000Z');
			await recordCompatibilityPhase(
				api,
				databaseId,
				'contracted',
				localStep(5),
				initial
			);
			await recordCompatibilityPhase(
				api,
				databaseId,
				'contracted',
				localStep(5),
				later
			);
			// SQLite rows have no prototype; copy them into plain objects to compare.
			const repeated = {
				...api.database
					.prepare('SELECT phase, updated_at FROM deployment_phase')
					.get()
			};
			await recordCompatibilityPhase(
				api,
				databaseId,
				'native-reads',
				localStep(4),
				later
			);
			const lowered = {
				...api.database
					.prepare('SELECT phase, updated_at FROM deployment_phase')
					.get()
			};
			expect({
				repeated,
				lowered,
				read: await readCompatibilityPhase(api, databaseId)
			}).toStrictEqual({
				repeated: { phase: 'contracted', updated_at: initial.toISOString() },
				lowered: { phase: 'contracted', updated_at: initial.toISOString() },
				read: { phase: 'contracted', requiredLocalStep: '5' }
			});
		} finally {
			api.database.close();
		}
	});

	it('replaces a phase name that this build does not list', async () => {
		const api = sqliteApi();
		api.database.exec(
			"CREATE TABLE deployment_phase (id TEXT PRIMARY KEY, phase TEXT NOT NULL, required_local_step INTEGER NOT NULL, updated_at TEXT NOT NULL); INSERT INTO deployment_phase VALUES ('current', 'later-phase', 5, '2026-01-01T00:00:00.000Z')"
		);
		try {
			const later = new Date('2026-01-02T00:00:00.000Z');
			await recordCompatibilityPhase(
				api,
				databaseId,
				'contracted',
				localStep(5),
				later
			);

			expect({
				...api.database
					.prepare(
						'SELECT phase, required_local_step, updated_at FROM deployment_phase'
					)
					.get()
			}).toStrictEqual({
				phase: 'contracted',
				required_local_step: 5,
				updated_at: later.toISOString()
			});
		} finally {
			api.database.close();
		}
	});

	it('reads no phase before the table exists', async () => {
		const api = sqliteApi();

		try {
			await expect(
				readCompatibilityPhase(api, databaseId)
			).resolves.toBeUndefined();
		} finally {
			api.database.close();
		}
	});
});
