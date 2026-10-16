import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { SubrequestSliceExceededError } from '../errors.ts';

import { boundedD1 } from './bounded-io.ts';
import {
	holdSubrequests,
	subrequestsAvailable,
	withSubrequestSlice
} from './subrequest-slice.ts';

const insert =
	"INSERT INTO deployment_transition (id,state,updated_at) VALUES (?,'expanded','2026-01-01T00:00:00.000Z')";

async function rows() {
	const result = await env.CUPBOARD_DB.prepare(
		"SELECT id,state FROM deployment_transition WHERE id LIKE 'optional-%' ORDER BY id"
	).all();
	return result.results;
}

describe('optional D1 binding admission', () => {
	it.each(['run', 'all', 'first', 'raw', 'exec', 'batch'] as const)(
		'refuses %s before mutation or charging when native calls are reserved',
		async (method) => {
			const result = await withSubrequestSlice(
				async () => {
					const native = holdSubrequests(1);
					const database = boundedD1(env.CUPBOARD_DB, { priority: 'optional' });
					const statement = database.prepare(insert).bind('optional-refused');
					const operations: Record<typeof method, () => Promise<unknown>> = {
						run: () => statement.run(),
						all: () => statement.all(),
						first: () => statement.first(),
						raw: () => statement.raw(),
						exec: () =>
							database.exec(insert.replace('?', "'optional-refused'")),
						batch: () => database.batch([statement])
					};
					await expect(async () => operations[method]()).rejects.toBeInstanceOf(
						SubrequestSliceExceededError
					);
					native.release();
					const row = await boundedD1(env.CUPBOARD_DB)
						.prepare('SELECT 1 AS value')
						.first();
					return { row, remaining: subrequestsAvailable() };
				},
				{ subrequests: 1, reserve: 0 }
			);
			expect({ ...result, rows: await rows() }).toStrictEqual({
				row: { value: 1 },
				remaining: 0,
				rows: []
			});
		}
	);

	it.each([false, true])(
		'keeps bound batch statements atomic and charges one call (session=%s)',
		async (isSession) => {
			const result = await withSubrequestSlice(
				async () => {
					const native = holdSubrequests(2);
					const client = boundedD1(env.CUPBOARD_DB, { priority: 'optional' });
					const database = isSession
						? client.withSession('first-primary')
						: client;
					const statement = database.prepare(insert);
					await database.batch([
						statement.bind('optional-first'),
						statement.bind('optional-second')
					]);
					const afterOptional = subrequestsAvailable();
					native.release();
					const primary = boundedD1(env.CUPBOARD_DB);
					const first = await primary
						.prepare('SELECT id FROM deployment_transition WHERE id=?')
						.bind('optional-first')
						.first('id');
					const second = await primary
						.prepare('SELECT id FROM deployment_transition WHERE id=?')
						.bind('optional-second')
						.first('id');
					return {
						afterOptional,
						first,
						second,
						remaining: subrequestsAvailable()
					};
				},
				{ subrequests: 3, reserve: 0 }
			);
			expect({ ...result, rows: await rows() }).toStrictEqual({
				afterOptional: 0,
				first: 'optional-first',
				second: 'optional-second',
				remaining: 0,
				rows: [
					{ id: 'optional-first', state: 'expanded' },
					{ id: 'optional-second', state: 'expanded' }
				]
			});
		}
	);

	it.each(['statement', 'session', 'batch', 'exec'] as const)(
		'does not issue an aborted %s request or consume its budget',
		async (kind) => {
			const result = await withSubrequestSlice(
				async () => {
					const controller = new AbortController();
					const reason = new Error('capture cancelled');
					const database = boundedD1(env.CUPBOARD_DB, {
						priority: 'optional',
						signal: controller.signal
					});
					const statement = database.prepare(insert).bind('optional-cancelled');
					const session = database.withSession('first-primary');
					const operations: Record<typeof kind, () => Promise<unknown>> = {
						statement: () => statement.run(),
						session: () =>
							session.prepare(insert).bind('optional-cancelled').run(),
						batch: () => database.batch([statement]),
						exec: () =>
							database.exec(insert.replace('?', "'optional-cancelled'"))
					};
					controller.abort(reason);
					await expect(async () => operations[kind]()).rejects.toBe(reason);
					return subrequestsAvailable();
				},
				{ subrequests: 2, reserve: 0 }
			);
			expect({ remaining: result, rows: await rows() }).toStrictEqual({
				remaining: 2,
				rows: []
			});
		}
	);

	it('checks admission when a prepared request executes and can retry after native reservations are released', async () => {
		const result = await withSubrequestSlice(
			async () => {
				const database = boundedD1(env.CUPBOARD_DB, { priority: 'optional' });
				const statement = database.prepare(insert).bind('optional-retried');
				const native = holdSubrequests(1);
				await expect(async () => statement.run()).rejects.toBeInstanceOf(
					SubrequestSliceExceededError
				);
				native.release();
				await statement.run();
				return subrequestsAvailable();
			},
			{ subrequests: 1, reserve: 0 }
		);
		expect({ remaining: result, rows: await rows() }).toStrictEqual({
			remaining: 0,
			rows: [{ id: 'optional-retried', state: 'expanded' }]
		});
	});
});
