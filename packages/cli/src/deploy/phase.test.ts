import process from 'node:process';
import type { DatabaseSync } from 'node:sqlite';

import { localStep } from '@cupboard/protocol/deployment';
import Cloudflare from 'cloudflare';
import { describe, expect, it } from 'vitest';

import { createCloudflareApi } from './cloudflare-api.ts';
import {
	cloudflareAccountIdSchema,
	type DatabaseId,
	databaseIdSchema
} from './identifiers.ts';
import {
	ensureTransitionTable,
	type PhaseApi,
	readCompatibilityPhase,
	readLocalStepReadiness,
	readRecordedTransitions,
	reconcileTransitionStates,
	recordCompatibilityPhase,
	recordTransition,
	type TransitionStates,
	UnknownDeploymentTransitionError
} from './phase.ts';

const databaseId = databaseIdSchema.parse('database');
const requiredStep = localStep(1);

/**
 * A `PhaseApi` whose `queryRows` returns each of `answers` in turn, one per
 * call, and records the SQL so a test can assert which queries ran.
 */
function stubApi(...answers: readonly (readonly string[])[]): PhaseApi & {
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
 * answers with the D1 response envelope, so the wrapper sees the column types
 * D1 returns.
 */
function sqliteBackedApi(
	rows: readonly {
		id: string;
		status: string;
		localStep: number | undefined;
	}[]
): PhaseApi {
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
 * A `PhaseApi` over an empty in-memory SQLite database, so the statements the
 * deploy sends run as D1 would run them.
 */
function sqliteApi(): PhaseApi & { readonly database: DatabaseSync } {
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
			).rejects.toThrow('Invalid tenant readiness count');
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

describe('transition records', () => {
	it('reads no transitions before a deploy has created the table', async () => {
		const api = sqliteApi();

		try {
			await expect(
				readRecordedTransitions(api, databaseId)
			).resolves.toStrictEqual([]);
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
			const expanded = await readRecordedTransitions(api, databaseId);
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
			const repeated = await readRecordedTransitions(api, databaseId);
			await recordTransition(
				api,
				databaseId,
				'cache-identity',
				'expanded',
				new Date('2026-01-04T00:00:00.000Z')
			);
			const lowered = await readRecordedTransitions(api, databaseId);

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

			const rows = await readRecordedTransitions(api, databaseId);

			expect(rows.map(({ id, state }) => `${id}:${state}`)).toStrictEqual([
				'cache-identity:expanded',
				'deployment-transitions:complete'
			]);
		} finally {
			api.database.close();
		}
	});

	it.each([
		{ name: 'id', id: 'later-transition', state: 'complete' },
		{ name: 'state', id: 'cache-identity', state: 'later-state' }
	])(
		'refuses a stored transition $name this build does not define',
		async ({ id, state }) => {
			const api = sqliteApi();

			try {
				await ensureTransitionTable(api, databaseId);
				api.database
					.prepare('INSERT INTO deployment_transition VALUES (?, ?, ?)')
					.run(id, state, '2026-01-01T00:00:00.000Z');

				let caught: unknown;

				try {
					await readRecordedTransitions(api, databaseId);
				} catch (error) {
					caught = error;
				}

				expect(caught).toBeInstanceOf(UnknownDeploymentTransitionError);
				expect(caught).toMatchObject({ transition: id, state });
			} finally {
				api.database.close();
			}
		}
	);
});

describe('reconcileTransitionStates', () => {
	const none: TransitionStates = new Map();
	const expanded: TransitionStates = new Map([['cache-identity', 'expanded']]);
	const complete: TransitionStates = new Map([['cache-identity', 'complete']]);

	it.each([
		{ name: 'no phase', stored: none, phase: undefined, expected: none },
		{ name: 'current', stored: none, phase: 'current', expected: expanded },
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
			name: 'a phase this build does not list',
			stored: none,
			phase: 'later-phase',
			expected: expanded
		}
	])('implies $name', ({ stored, phase, expected }) => {
		expect(reconcileTransitionStates(stored, phase)).toStrictEqual(expected);
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
				read: 'contracted'
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
