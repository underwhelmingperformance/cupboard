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
import { type PhaseApi, readLocalStepReadiness } from './phase.ts';

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

	it('counts the active tenants below the step and names them', async () => {
		const api = sqliteBackedApi([
			{ id: 'alpha', status: 'active', localStep: undefined },
			{ id: 'beta', status: 'active', localStep: 0 },
			{ id: 'gamma', status: 'active', localStep: 1 },
			{ id: 'delta', status: 'suspended', localStep: undefined }
		]);

		expect(
			await readLocalStepReadiness(api, databaseId, requiredStep)
		).toStrictEqual({ pending: 2, stragglers: ['alpha', 'beta'] });
	});
});
