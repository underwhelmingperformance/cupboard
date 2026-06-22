import { describe, expect, it, vi } from 'vitest';

import { fetchClaimFailureLogs, logLines } from './claim-logs.ts';
import type { WorkerLogEvent, WorkerLogQuery } from './cloudflare-api.ts';

function event(parts: Partial<WorkerLogEvent>): WorkerLogEvent {
	return { message: undefined, error: undefined, source: '', ...parts };
}

function fakeApi(responses: readonly WorkerLogEvent[][]): {
	readonly queries: WorkerLogQuery[];
	readonly api: {
		queryWorkerLogs: (query: WorkerLogQuery) => Promise<WorkerLogEvent[]>;
	};
} {
	const queries: WorkerLogQuery[] = [];
	let call = 0;

	return {
		queries,
		api: {
			queryWorkerLogs: (query: WorkerLogQuery) => {
				queries.push(query);
				const response = responses[call] ?? [];
				call += 1;

				return Promise.resolve(response);
			}
		}
	};
}

describe('logLines', () => {
	it('prefers error then message then source, de-dupes, and drops blanks', () => {
		const lines = logLines([
			event({ error: 'D1_ERROR: boom', message: 'm', source: 's' }),
			event({ message: '  trimmed  ', source: 's' }),
			event({ source: 'raw source' }),
			event({ source: ' ' }),
			event({ error: 'D1_ERROR: boom' })
		]);

		expect(lines).toStrictEqual(['D1_ERROR: boom', 'trimmed', 'raw source']);
	});
});

describe('fetchClaimFailureLogs', () => {
	it('queries by ray within the window and returns the logged lines', async () => {
		const { api, queries } = fakeApi([[event({ error: 'D1_ERROR: boom' })]]);
		const sleep = vi.fn(() => Promise.resolve());

		const lines = await fetchClaimFailureLogs({
			api,
			ray: 'ray-abc',
			now: () => 1_000_000,
			sleep
		});

		expect({ lines, queries, slept: sleep.mock.calls.length }).toStrictEqual({
			lines: ['D1_ERROR: boom'],
			queries: [
				{ needle: 'ray-abc', fromMs: 880_000, toMs: 1_005_000, limit: 20 }
			],
			slept: 0
		});
	});

	it('retries through ingestion lag until an event appears', async () => {
		const { api, queries } = fakeApi([
			[],
			[],
			[event({ message: 'late log' })]
		]);
		const sleep = vi.fn(() => Promise.resolve());

		const lines = await fetchClaimFailureLogs({
			api,
			ray: 'ray-1',
			now: () => 0,
			sleep,
			attempts: 4
		});

		expect({
			lines,
			queryCount: queries.length,
			slept: sleep.mock.calls.length
		}).toStrictEqual({ lines: ['late log'], queryCount: 3, slept: 2 });
	});

	it('gives up empty after exhausting attempts', async () => {
		const { api, queries } = fakeApi([]);
		const sleep = vi.fn(() => Promise.resolve());

		const lines = await fetchClaimFailureLogs({
			api,
			ray: 'ray-2',
			now: () => 0,
			sleep,
			attempts: 3
		});

		expect({
			lines,
			queryCount: queries.length,
			slept: sleep.mock.calls.length
		}).toStrictEqual({ lines: [], queryCount: 3, slept: 2 });
	});
});
