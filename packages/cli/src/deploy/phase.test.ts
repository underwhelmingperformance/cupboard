import { localStep } from '@cupboard/protocol/deployment';
import { describe, expect, it } from 'vitest';

import type { DatabaseId } from './identifiers.ts';
import { type PhaseApi, readLocalStepReadiness } from './phase.ts';

const databaseId = 'database' as DatabaseId;
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

describe('local step readiness', () => {
	it('reports no pending tenants and runs no straggler query', async () => {
		const api = stubApi(['0']);

		expect(
			await readLocalStepReadiness(api, databaseId, requiredStep)
		).toStrictEqual({ pending: 0, stragglers: [] });
		expect(api.queries).toHaveLength(1);
	});

	it('names the tenants that are behind', async () => {
		const api = stubApi(['3'], ['alpha', 'beta', 'gamma']);

		expect(
			await readLocalStepReadiness(api, databaseId, requiredStep)
		).toStrictEqual({
			pending: 3,
			stragglers: ['alpha', 'beta', 'gamma']
		});
	});

	it('counts a tenant that has never reported', async () => {
		const api = stubApi(['1'], ['alpha']);

		await readLocalStepReadiness(api, databaseId, requiredStep);

		const [counting] = api.queries;

		expect(counting).toContain('local_step IS NULL');
		expect(counting).toContain(`local_step < ${String(requiredStep)}`);
	});
});
