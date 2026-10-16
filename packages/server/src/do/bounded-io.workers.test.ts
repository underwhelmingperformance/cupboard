import { startCapture } from '@cupboard/logger/testing';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SubrequestTimeoutError, UnboundableIoError } from '../errors.ts';
import { OidcDiscoveryStore } from '../oidc/oidc.ts';
import { currentServer, initialise, resetTestServer } from '../test-support.ts';

import { boundedBlobs, boundedD1, boundedWorkerEnv } from './bounded-io.ts';
import { withDeadlineBudget } from './deadline.ts';
import { noCost } from './operation-cost.test-support.ts';
import {
	type OperationCostRecord,
	withOperationCost
} from './operation-cost.ts';
import { hasSubrequestsFor, withSubrequestSlice } from './subrequest-slice.ts';

async function costOf(
	body: () => Promise<unknown>,
	label = 'test'
): Promise<OperationCostRecord> {
	let cost: OperationCostRecord | undefined;

	await withOperationCost(label, body, (settled) => {
		cost = settled;
	});

	return cost ?? noCost;
}

describe('bounded gated subrequest', () => {
	beforeEach(resetTestServer);

	it('times out a hung gated R2 call and keeps the object alive', async () => {
		await initialise();
		const server = currentServer();

		// An in-memory marker whose survival proves the instance was not reset: the
		// runtime replaces a broken object, and a fresh instance builds a fresh
		// discovery store.
		const marker = new OidcDiscoveryStore();
		await runInDurableObject(server, (instance) => {
			instance.context.discovery = marker;
			instance.context.gateBudgetMs = 100;
		});

		const hang = vi
			.spyOn(env.BLOBS, 'delete')
			.mockImplementation(() => Promise.race([]));

		let rejection: unknown;
		try {
			await runInDurableObject(server, (instance) =>
				instance.context.criticalSection(() =>
					instance.context.env.BLOBS.delete('gated-key')
				)
			);
		} catch (error) {
			rejection = error;
		} finally {
			hang.mockRestore();
		}

		const afterTimeout = await runInDurableObject(server, (instance) =>
			instance.context.criticalSection(() => Promise.resolve('ok'))
		);
		const isSameInstance = await runInDurableObject(
			server,
			(instance) => instance.context.discovery === marker
		);

		expect({
			timedOut: rejection instanceof SubrequestTimeoutError,
			isSameInstance,
			afterTimeout
		}).toStrictEqual({
			timedOut: true,
			isSameInstance: true,
			afterTimeout: 'ok'
		});
	});
});

describe('unboundable members', () => {
	it('refuses an R2 multipart handle through the bounded bucket', () => {
		const blobs = boundedBlobs(env.BLOBS);

		expect(() => blobs.createMultipartUpload('unbounded-key')).toThrow(
			UnboundableIoError
		);
		expect(() =>
			blobs.resumeMultipartUpload('unbounded-key', 'upload-id')
		).toThrow(UnboundableIoError);
	});

	it('bounds and counts a primary D1 session', async () => {
		const session = boundedD1(env.CUPBOARD_DB).withSession('first-primary');
		const result = await withSubrequestSlice(
			async () => {
				const row = await session.prepare('SELECT 1 AS value').first();
				return { row, remaining: hasSubrequestsFor(1) };
			},
			{ subrequests: 1, reserve: 0 }
		);

		expect(result).toStrictEqual({ row: { value: 1 }, remaining: false });
	});
});

describe('bounded Worker environment', () => {
	it('counts Worker D1 and R2 calls in the same slice', async () => {
		const worker = boundedWorkerEnv(env);
		const isRemaining = await withSubrequestSlice(
			async () => {
				await worker.CUPBOARD_DB.prepare('SELECT 1').first();
				await worker.BLOBS.head('missing-key');

				return hasSubrequestsFor(1);
			},
			{ subrequests: 2, reserve: 0 }
		);

		expect(isRemaining).toBe(false);
	});

	// The deadline is the test's own. The 15-second figure a Worker applies is
	// not exercised here.
	it('times out a hung R2 head and serves the other bindings as they are', async () => {
		const hang = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation(() => Promise.race([]));
		const worker = boundedWorkerEnv(env);

		let rejection: unknown;
		try {
			await withDeadlineBudget(100, () => worker.BLOBS.head('hung-key'));
		} catch (error) {
			rejection = error;
		} finally {
			hang.mockRestore();
		}

		expect({
			timedOut: rejection instanceof SubrequestTimeoutError,
			isSameCronState: worker.CRON_STATE === env.CRON_STATE
		}).toStrictEqual({ timedOut: true, isSameCronState: true });
	});
});

describe('binding cost', () => {
	it('records each R2 and D1 call against the open scope', async () => {
		const worker = boundedWorkerEnv(env);
		await worker.CUPBOARD_DB.exec(
			'CREATE TABLE IF NOT EXISTS cost_probe (id INTEGER PRIMARY KEY)'
		);
		const select = worker.CUPBOARD_DB.prepare(
			"SELECT value FROM json_each('[1,2,3]')"
		);

		const cost = await costOf(async () => {
			await worker.BLOBS.put('cost-probe', 'bytes');
			await worker.BLOBS.head('cost-probe');
			await worker.BLOBS.get('cost-probe');
			await worker.BLOBS.list({ prefix: 'cost-probe' });
			await worker.BLOBS.delete('cost-probe');
			await worker.CUPBOARD_DB.prepare(
				'INSERT INTO cost_probe DEFAULT VALUES'
			).run();
			await select.all();
			await select.raw();
			await select.first();
			await worker.CUPBOARD_DB.batch([select, select]);
			await worker.CUPBOARD_DB.exec('SELECT 1');
		});

		expect(cost).toStrictEqual({
			...noCost,
			d1Calls: 6,
			d1RowsRead: 9,
			d1RowsWritten: 1,
			d1CallsWithoutRows: 3,
			r2Head: 1,
			r2Get: 1,
			r2Put: 1,
			r2Delete: 1,
			r2List: 1
		});
	});

	it('does not count a call that an expired deadline refuses', async () => {
		const blobs = boundedBlobs(env.BLOBS);
		let rejection: unknown;

		const cost = await costOf(async () => {
			try {
				await withDeadlineBudget(0, () => blobs.head('refused-key'));
			} catch (error) {
				rejection = error;
			}
		});

		expect({
			timedOut: rejection instanceof SubrequestTimeoutError,
			cost
		}).toStrictEqual({ timedOut: true, cost: noCost });
	});

	it('records the rows of a D1 call that completes after its deadline', async () => {
		const statement = env.CUPBOARD_DB.prepare('SELECT 1');
		const completion = Promise.withResolvers<D1Result>();
		const run = vi.spyOn(statement, 'run').mockReturnValue(completion.promise);
		const prepare = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockReturnValue(statement);
		let rejection: unknown;

		try {
			const cost = await costOf(async () => {
				try {
					await withDeadlineBudget(10, () =>
						boundedD1(env.CUPBOARD_DB).prepare('SELECT 1').run()
					);
				} catch (error) {
					rejection = error;
				}

				completion.resolve({
					success: true,
					results: [],
					meta: {
						duration: 0,
						size_after: 0,
						rows_read: 3,
						rows_written: 1,
						last_row_id: 0,
						changed_db: true,
						changes: 1
					}
				});
				await completion.promise;
			});

			expect({
				timedOut: rejection instanceof SubrequestTimeoutError,
				cost
			}).toStrictEqual({
				timedOut: true,
				cost: { ...noCost, d1Calls: 1, d1RowsRead: 3, d1RowsWritten: 1 }
			});
		} finally {
			prepare.mockRestore();
			run.mockRestore();
		}
	});

	it('attributes each call to the innermost scope that made it', async () => {
		const blobs = boundedBlobs(env.BLOBS);
		let inner = noCost;

		const [outer, concurrent] = await Promise.all([
			costOf(async () => {
				await blobs.head('outer-key');
				inner = await costOf(async () => {
					await blobs.head('inner-key');
					await blobs.head('inner-key');
				}, 'inner');
				await blobs.head('outer-key');
			}, 'outer'),
			costOf(async () => {
				await blobs.head('concurrent-key');
			}, 'concurrent')
		]);

		expect({ outer, inner, concurrent }).toStrictEqual({
			outer: { ...noCost, r2Head: 2 },
			inner: { ...noCost, r2Head: 2 },
			concurrent: { ...noCost, r2Head: 1 }
		});
	});

	it('joins an enclosing scope with the same label', async () => {
		const blobs = boundedBlobs(env.BLOBS);
		const reports: OperationCostRecord[] = [];
		const report = (cost: OperationCostRecord): void => {
			reports.push(cost);
		};

		await withOperationCost(
			'pass',
			async () => {
				await blobs.head('outer-key');
				await withOperationCost(
					'pass',
					async () => {
						await blobs.head('inner-key');
					},
					report
				);
			},
			report
		);

		expect(reports).toStrictEqual([{ ...noCost, r2Head: 2 }]);
	});

	it('logs the cost of each call that reaches a scope after it finished', async () => {
		const blobs = boundedBlobs(env.BLOBS);
		const release = Promise.withResolvers<undefined>();
		let detached: Promise<unknown> = Promise.resolve();
		const capture = startCapture();

		try {
			await costOf(() => {
				detached = (async () => {
					await release.promise;
					await blobs.head('late-key');
					await blobs.head('late-key');
				})();

				return Promise.resolve();
			}, 'finished');
			release.resolve(undefined);
			await detached;
		} finally {
			capture.stop();
		}

		expect(
			capture.logs.filter(
				(entry) => entry.message === 'cost recorded after scope finished'
			)
		).toStrictEqual(
			Array.from({ length: 2 }, () => ({
				level: 'warning',
				category: ['cupboard'],
				message: 'cost recorded after scope finished',
				properties: { method: 'finished', ...noCost, r2Head: 1 }
			}))
		);
	});
});

describe('subrequest accounting', () => {
	// One D1 batch is one call to the platform, however many statements it
	// carries, and the slice refuses nothing: the batch runs although it spends
	// the slice's only call.
	it('spends one subrequest for a D1 batch', async () => {
		const database = boundedD1(env.CUPBOARD_DB);
		const select = database.prepare('SELECT 1');

		const answers = await withSubrequestSlice(
			async () => {
				const isBefore = hasSubrequestsFor(1);
				const results = await database.batch([select, select]);

				return {
					before: isBefore,
					after: hasSubrequestsFor(1),
					statementsRun: results.length
				};
			},
			{ subrequests: 1, reserve: 0 }
		);

		expect(answers).toStrictEqual({
			before: true,
			after: false,
			statementsRun: 2
		});
	});
});
