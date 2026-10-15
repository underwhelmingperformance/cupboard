import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	artifactTaskIdSchema,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import { SharedListingTaskDeliveryStore } from './shared-listing-task-deliveries.ts';
import { SharedListingTaskStore } from './shared-listing-tasks.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const later = isoTimestamp(new Date('2026-01-01T00:00:30.000Z'));
const deadline = isoTimestamp(new Date('2026-01-01T00:01:00.000Z'));
const renewedDeadline = isoTimestamp(new Date('2026-01-01T00:01:30.000Z'));
const retryAt = isoTimestamp(new Date('2026-01-01T00:05:00.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);

async function fixture(count = 1) {
	const { database } = await sharedNarDiscoveryFixture(count);
	const jobs = new SharedListingJobStore(database);
	const started = await jobs.start(currentListingGeneratorRevision, now);
	const job = { id: started.id, generation: started.generation };
	const rows = Array.from({ length: count }, (_, index) => ({
		id: artifactTaskIdSchema.parse(
			`10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
		),
		jobId: job.id,
		...sharedNarSource(index),
		discoveryPage: 'delivery-page',
		createdAt: now,
		readyAt: now
	}));
	for (const row of rows) {
		await database.insert(schema.sharedListingTask).values(row);
	}
	const tasks = await database
		.select()
		.from(schema.sharedListingTask)
		.orderBy(schema.sharedListingTask.id);
	const first = tasks[0];
	if (first === undefined) {
		throw new Error('The delivery fixture needs a task');
	}
	return {
		database,
		jobs,
		job,
		tasks,
		first,
		store: new SharedListingTaskDeliveryStore(database),
		execution: new SharedListingTaskStore(database)
	};
}

describe('shared listing task delivery reservations', () => {
	it('advances through unclaimed pages without acquiring execution ownership', async () => {
		const { database, job, tasks, store } = await fixture(20);
		const ids = tasks.map((task) => task.id).toSorted(byCodeUnit);
		const first = await store.reserve(job, now);
		const reopened = new SharedListingTaskDeliveryStore(database);
		const second = await reopened.reserve(job, now);
		const third = await reopened.reserve(job, now);
		expect({
			first,
			second,
			third,
			exhausted: await reopened.reserve(job, now),
			next: await reopened.next(job, now),
			execution: await database
				.select()
				.from(schema.sharedListingTask)
				.orderBy(schema.sharedListingTask.id)
		}).toStrictEqual({
			first: ids
				.slice(0, 8)
				.map((id) => ({ job: { id: job.id, generation: job.generation }, id })),
			second: ids
				.slice(8, 16)
				.map((id) => ({ job: { id: job.id, generation: job.generation }, id })),
			third: ids
				.slice(16)
				.map((id) => ({ job: { id: job.id, generation: job.generation }, id })),
			exhausted: [],
			next: deadline,
			execution: tasks
		});
	});

	it('reserves a task once when dispatchers select concurrently', async () => {
		const { job, first, store } = await fixture();
		const results = await Promise.all([
			store.reserve(job, now),
			store.reserve(job, now)
		]);
		expect(results.flat()).toStrictEqual([
			{ job: { id: job.id, generation: job.generation }, id: first.id }
		]);
	});

	it('recovers a lost reservation reply only after the persisted deadline', async () => {
		const { database, job, first, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let calls = 0;
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (statements) => {
				const result = await original(statements);
				calls++;
				if (calls === 2) {
					throw new Error('The reservation reply was lost');
				}
				return result;
			});
		try {
			await expect(store.reserve(job, now)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			batch.mockRestore();
		}
		const reopened = new SharedListingTaskDeliveryStore(database);
		expect({
			early: await reopened.reserve(job, later),
			recovered: await reopened.reserve(job, deadline)
		}).toStrictEqual({
			early: [],
			recovered: [
				{ job: { id: job.id, generation: job.generation }, id: first.id }
			]
		});
	});

	it('follows actual execution leases, renewal and delayed retries', async () => {
		const { job, first, store, execution } = await fixture();
		await store.reserve(job, now);
		const result = await execution.claim({ job, id: first.id, owner }, now);
		if (result.kind !== 'claimed') {
			throw new Error(`Expected execution ownership, received ${result.kind}`);
		}
		const renewed = await execution.renew(result.claim, later);
		expect({
			renewed,
			oldDeadline: await store.reserve(job, deadline),
			next: await store.next(job, deadline)
		}).toStrictEqual({
			renewed: renewedDeadline,
			oldDeadline: [],
			next: renewedDeadline
		});
		await execution.defer(result.claim, retryAt, later);
		expect({
			early: await store.reserve(job, renewedDeadline),
			next: await store.next(job, renewedDeadline),
			due: await store.reserve(job, retryAt)
		}).toStrictEqual({
			early: [],
			next: retryAt,
			due: [{ job: { id: job.id, generation: job.generation }, id: first.id }]
		});
	});

	it.each(['completed', 'skipped', 'failed', 'deleted'] as const)(
		'removes delivery metadata when a task is %s',
		async (state) => {
			const { database, job, first, store, execution } = await fixture();
			await execution.claim({ job, id: first.id, owner }, now);
			if (state === 'deleted') {
				await database
					.delete(schema.sharedListingTask)
					.where(eq(schema.sharedListingTask.id, first.id));
			} else {
				await database
					.update(schema.sharedListingTask)
					.set({ state, leaseExpiresAt: sql`null` })
					.where(eq(schema.sharedListingTask.id, first.id));
			}
			expect({
				deliveries: await database
					.select()
					.from(schema.sharedListingTaskDelivery),
				reserved: await store.reserve(job, deadline),
				next: await store.next(job, deadline)
			}).toStrictEqual({ deliveries: [], reserved: [], next: undefined });
		}
	);

	it('revokes cancelled jobs and immediately redelivers superseded execution after resume', async () => {
		const { database, jobs, job, first, store, execution } = await fixture(2);
		const second = await database
			.select()
			.from(schema.sharedListingTask)
			.where(sql`${schema.sharedListingTask.id} <> ${first.id}`)
			.get();
		if (second === undefined) {
			throw new Error('Expected a second fixture task');
		}
		await execution.claim({ job, id: first.id, owner }, now);
		await database
			.update(schema.sharedListingTask)
			.set({ readyAt: retryAt })
			.where(eq(schema.sharedListingTask.id, second.id));
		await jobs.cancel(job, now);
		expect({
			cancelled: await store.reserve(job, deadline),
			next: await store.next(job, deadline)
		}).toStrictEqual({ cancelled: [], next: undefined });
		const resumedJob = await jobs.resume(job, later);
		if (resumedJob === undefined) {
			throw new Error('The job did not resume');
		}
		const resumed = { id: resumedJob.id, generation: resumedJob.generation };
		expect({
			stale: await store.reserve(job, later),
			replacement: await store.reserve(resumed, later),
			deferred: await store.next(resumed, later)
		}).toStrictEqual({
			stale: [],
			replacement: [
				{
					job: { id: resumed.id, generation: resumed.generation },
					id: first.id
				}
			],
			deferred: renewedDeadline
		});
	});

	it.each([false, true])(
		'refuses a changed scheduling epoch with restored ready time: %s',
		async (restored) => {
			const { job, first, store } = await fixture();
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const batch = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (statements) => {
					const result = await original(statements);
					await env.CUPBOARD_DB.prepare(
						'UPDATE shared_listing_task SET ready_at = ? WHERE id = ?'
					)
						.bind(retryAt, first.id)
						.run();
					if (restored) {
						await env.CUPBOARD_DB.prepare(
							'UPDATE shared_listing_task SET ready_at = ? WHERE id = ?'
						)
							.bind(now, first.id)
							.run();
					}
					return result;
				});
			try {
				expect(await store.reserve(job, now)).toStrictEqual([]);
			} finally {
				batch.mockRestore();
			}
			expect(await store.next(job, now)).toBe(restored ? now : retryAt);
		}
	);

	it.each(['cancelled', 'complete'] as const)(
		'refuses reservations if the job becomes %s after selection',
		async (state) => {
			const { job, store } = await fixture();
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const batch = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (statements) => {
					const result = await original(statements);
					await env.CUPBOARD_DB.prepare(
						'UPDATE shared_listing_job SET state = ? WHERE id = ?'
					)
						.bind(state, job.id)
						.run();
					return result;
				});
			try {
				expect(await store.reserve(job, now)).toStrictEqual([]);
			} finally {
				batch.mockRestore();
			}
		}
	);

	it('expands over existing tasks without a catalogue-wide backfill and captures later writes', async () => {
		const migration = env.TEST_MIGRATIONS.find(
			(item) => item.name === '0064_shared_listing_task_delivery.sql'
		);
		if (migration === undefined) {
			throw new Error('The task delivery migration is missing');
		}
		await env.CUPBOARD_DB.batch(
			[
				'DROP TRIGGER shared_listing_task_delivery_insert',
				'DROP TRIGGER shared_listing_task_delivery_update',
				'DROP TRIGGER shared_listing_task_delivery_delete',
				'DROP TABLE shared_listing_task_delivery'
			].map((query) => env.CUPBOARD_DB.prepare(query))
		);
		let first: Awaited<ReturnType<typeof fixture>>;
		try {
			first = await fixture(20);
		} finally {
			await env.CUPBOARD_DB.batch(
				migration.queries.map((query) => env.CUPBOARD_DB.prepare(query))
			);
		}
		const { database, job, first: task } = first;
		expect(
			await database.select().from(schema.sharedListingTaskDelivery)
		).toStrictEqual([]);
		await database
			.update(schema.sharedListingTask)
			.set({ readyAt: later })
			.where(eq(schema.sharedListingTask.id, task.id));
		const deliveries = await database
			.select({
				taskId: schema.sharedListingTaskDelivery.taskId,
				jobId: schema.sharedListingTaskDelivery.jobId,
				jobGeneration: schema.sharedListingTaskDelivery.jobGeneration,
				state: schema.sharedListingTaskDelivery.state,
				nextAt: schema.sharedListingTaskDelivery.nextAt
			})
			.from(schema.sharedListingTaskDelivery);
		expect(deliveries).toStrictEqual([
			{
				taskId: task.id,
				jobId: job.id,
				jobGeneration: job.generation,
				state: 'pending',
				nextAt: later
			}
		]);
	});

	it('bounds candidate reads and reservations with thousands of deferred tasks', async () => {
		const { database, job, first, store } = await fixture();
		await database.run(sql`WITH RECURSIVE items(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM items WHERE i < 2048)
   INSERT INTO shared_listing_task (id, job_id, nar_hash, source_incarnation, nar_size, file_size, discovery_page, created_at, ready_at)
   SELECT printf('20000000-0000-4000-8000-%012d', i), ${job.id}, printf('sha256:%052d', i + 1000), 1, 200, 100, 'deferred', ${now}, ${retryAt} FROM items`);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const reads: number[] = [];
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (statements) => {
				const result = await original(statements);
				reads.push(...result.map((row) => row.meta.rows_read));
				return result;
			});
		try {
			const reserved = await store.reserve(job, now);
			expect({
				reserved,
				statements: reads.length,
				bounded: reads.every((read) => read <= 64)
			}).toStrictEqual({
				reserved: [
					{ job: { id: job.id, generation: job.generation }, id: first.id }
				],
				statements: 5,
				bounded: true
			});
		} finally {
			batch.mockRestore();
		}
	});
});
