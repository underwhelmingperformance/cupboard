import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type ArtifactJobVersion,
	artifactTaskIdSchema,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import type { SharedListingDispatchClaimResult } from '../blob/shared-listing-dispatch.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { SharedListingDispatchStore } from './shared-listing-dispatch.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import { SharedListingTaskDeliveryStore } from './shared-listing-task-deliveries.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('3000-01-01T00:00:00.000Z'));
const later = isoTimestamp(new Date('3000-01-01T00:00:30.000Z'));
const deadline = isoTimestamp(new Date('3000-01-01T00:01:00.000Z'));
const future = isoTimestamp(new Date('3000-01-01T00:05:00.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const other = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);

function claimed(result: SharedListingDispatchClaimResult) {
	if (result.kind !== 'claimed') {
		throw new Error(`Expected a dispatch claim, received ${result.kind}`);
	}
	return result.claim;
}
async function fixture() {
	const { database } = await sharedNarDiscoveryFixture(0);
	const jobs = new SharedListingJobStore(database);
	async function start() {
		const row = await jobs.start(currentListingGeneratorRevision, now);
		return { id: row.id, generation: row.generation };
	}
	const job = await start();
	async function ticket(target: ArtifactJobVersion = job) {
		const row = await database
			.select()
			.from(schema.sharedListingJobDispatch)
			.where(eq(schema.sharedListingJobDispatch.jobId, target.id))
			.get();
		if (row === undefined) {
			throw new Error('The job has no dispatch ticket');
		}
		return row;
	}
	async function task(index: number, source = index) {
		const id = artifactTaskIdSchema.parse(
			`10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
		);
		await database.insert(schema.sharedListingTask).values({
			id,
			jobId: job.id,
			...sharedNarSource(source),
			discoveryPage: 'dispatch',
			createdAt: now,
			readyAt: now
		});
		return id;
	}
	return {
		database,
		jobs,
		job,
		start,
		ticket,
		task,
		store: new SharedListingDispatchStore(database),
		deliveries: new SharedListingTaskDeliveryStore(database)
	};
}

describe('global listing job dispatch', () => {
	it('reserves a delivery hint separately from pass ownership and actual execution', async () => {
		const { database, job, ticket, task, store } = await fixture();
		const id = await task(1);
		const hints = await store.reserve(now);
		const reserved = await ticket();
		const claim = claimed(await store.claim(job, owner, now));
		const tasks = await database
			.select({
				id: schema.sharedListingTask.id,
				state: schema.sharedListingTask.state,
				generation: schema.sharedListingTask.claimGeneration
			})
			.from(schema.sharedListingTask);
		expect({
			hints,
			pass: claim,
			owner: reserved.owner ?? undefined,
			tasks
		}).toStrictEqual({
			hints: [job],
			pass: {
				id: reserved.id,
				job,
				generation: 1,
				owner,
				leaseExpiresAt: deadline
			},
			owner: undefined,
			tasks: [{ id, state: 'pending', generation: 0 }]
		});
	});

	it('advances beyond the first unclaimed job page', async () => {
		const { database, job, start, store } = await fixture();
		const jobs = [job];
		for (let index = 0; index < 9; index++) {
			jobs.push(await start());
		}
		await database
			.update(schema.sharedListingJobDispatch)
			.set({ nextDeliveryAt: now });
		expect({
			first: await store.reserve(now),
			second: await store.reserve(now),
			spent: await store.reserve(now)
		}).toStrictEqual({
			first: jobs.slice(0, 8),
			second: jobs.slice(8),
			spent: []
		});
	});

	it('moves a completed pass behind another waiting job at the same clock value', async () => {
		const { database, job, start, ticket, store } = await fixture();
		const second = await start();
		await database
			.update(schema.sharedListingJobDispatch)
			.set({ nextDeliveryAt: now });
		await database
			.update(schema.sharedListingJobDispatch)
			.set({
				isSeeded: false,
				seedAfter: sharedNarSource(1).narHash,
				seedThrough: sharedNarSource(3).narHash
			})
			.where(eq(schema.sharedListingJobDispatch.jobId, job.id));
		const before = await ticket();
		const claim = claimed(await store.claim(job, owner, now));
		const isFinished = await store.finish(claim, now);
		const after = await ticket();
		expect({
			isFinished,
			reordered: after.id > before.id,
			seed: {
				isSeeded: after.isSeeded,
				after: after.seedAfter,
				through: after.seedThrough
			},
			jobs: await store.reserve(now),
			stale: await store.finish(claim, now)
		}).toStrictEqual({
			isFinished: true,
			reordered: true,
			seed: {
				isSeeded: false,
				after: sharedNarSource(1).narHash,
				through: sharedNarSource(3).narHash
			},
			jobs: [second, job],
			stale: false
		});
	});

	it('admits one pass per job while independent jobs can claim in parallel', async () => {
		const { job, start, store } = await fixture();
		const second = await start();
		const results = await Promise.all([
			store.claim(job, owner, now),
			store.claim(job, other, now)
		]);
		expect(
			results.map((result) => result.kind).toSorted(byCodeUnit)
		).toStrictEqual(['busy', 'claimed']);
		const first = claimed(
			results.find((result) => result.kind === 'claimed') ?? {
				kind: 'unavailable'
			}
		);
		const independent = claimed(await store.claim(second, other, now));
		expect({
			first: first.job,
			independent: independent.job,
			reserved: await store.reserve(now)
		}).toStrictEqual({ first: job, independent: second, reserved: [] });
	});

	it('reclaims an expired pass and fences its earlier owner', async () => {
		const { job, store } = await fixture();
		const first = claimed(await store.claim(job, owner, now));
		expect(await store.claim(job, other, later)).toStrictEqual({
			kind: 'busy',
			retryAt: deadline
		});
		const replacement = claimed(await store.claim(job, other, deadline));
		expect({
			generation: replacement.generation,
			stale: await store.finish(first, deadline),
			isFinished: await store.finish(replacement, deadline)
		}).toStrictEqual({ generation: 2, stale: false, isFinished: true });
	});

	it('revokes cancelled generations and resumes with a new ticket', async () => {
		const { job, jobs, store } = await fixture();
		const old = claimed(await store.claim(job, owner, now));
		await jobs.cancel(job, now);
		expect({
			old: await store.finish(old, now),
			hints: await store.reserve(now)
		}).toStrictEqual({ old: false, hints: [] });
		const resumed = await jobs.resume(job, later);
		if (resumed === undefined) {
			throw new Error('The job did not resume');
		}
		const current = { id: resumed.id, generation: resumed.generation };
		expect({
			old: await store.claim(job, owner, later),
			hints: await store.reserve(later)
		}).toStrictEqual({ old: { kind: 'unavailable' }, hints: [current] });
		const fresh = claimed(await store.claim(current, other, later));
		expect({
			version: fresh.job,
			newTicket: fresh.id !== old.id
		}).toStrictEqual({ version: current, newTicket: true });
	});

	it('recovers a lost delivery reservation reply after its stored deadline', async () => {
		const { job, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let calls = 0;
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (statements) => {
				const result = await original(statements);
				if (++calls === 2) {
					throw new Error('The delivery reply was lost');
				}
				return result;
			});
		try {
			await expect(store.reserve(now)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			batch.mockRestore();
		}
		expect({
			early: await store.reserve(later),
			retry: await store.reserve(deadline)
		}).toStrictEqual({ early: [], retry: [job] });
	});

	it('checkpoints task deadlines and sees work created after the claim', async () => {
		const { database, job, task, store, deliveries, ticket } = await fixture();
		await database
			.update(schema.sharedListingJob)
			.set({ phase: 'processing' })
			.where(eq(schema.sharedListingJob.id, job.id));
		await task(1);
		const claim = claimed(await store.claim(job, owner, now));
		await deliveries.reserve(job, now);
		await task(2);
		await store.finish(claim, now);
		const hints = await store.reserve(now);
		const row = await ticket();
		expect({ hints, next: row.nextDeliveryAt }).toStrictEqual({
			hints: [job],
			next: deadline
		});
	});

	it('seeds bounded legacy task pages through a fixed boundary without overwriting newer delivery state', async () => {
		const { database, job, ticket, task, store } = await fixture();
		const ids = [];
		for (let index = 0; index < 65; index++) {
			ids.push(await task(index, 2 * index + 2));
		}
		await database
			.update(schema.sharedListingTask)
			.set({
				state: 'skipped',
				claimGeneration: 1,
				claimJobGeneration: job.generation,
				claimOwner: owner
			})
			.where(inArray(schema.sharedListingTask.id, ids.slice(0, 32)));
		await database.delete(schema.sharedListingTaskDelivery);
		await database.delete(schema.sharedListingJobDispatch);
		expect(await store.enrol(job, now)).toBe(true);
		const claim = claimed(await store.claim(job, owner, now));
		await store.seed(claim, now);
		const first = await ticket();
		expect({
			cursor: first.seedAfter,
			through: first.seedThrough,
			complete: first.isSeeded,
			deliveries: await database.select().from(schema.sharedListingTaskDelivery)
		}).toStrictEqual({
			cursor: sharedNarSource(64).narHash,
			through: sharedNarSource(130).narHash,
			complete: false,
			deliveries: []
		});
		const behind = await task(1000, 1);
		const beyond = await task(1001, 200);
		const preservedId = ids[40];
		if (preservedId === undefined) {
			throw new Error('Missing preserved fixture task');
		}
		await database
			.update(schema.sharedListingTask)
			.set({ readyAt: future })
			.where(eq(schema.sharedListingTask.id, preservedId));
		const preserved = await database
			.select()
			.from(schema.sharedListingTaskDelivery)
			.where(eq(schema.sharedListingTaskDelivery.taskId, preservedId));
		await store.seed(claim, now);
		await store.seed(claim, now);
		const seeded = await ticket();
		const hints = await database
			.select({ id: schema.sharedListingTaskDelivery.taskId })
			.from(schema.sharedListingTaskDelivery)
			.orderBy(schema.sharedListingTaskDelivery.taskId);
		expect({
			cursor: seeded.seedAfter,
			through: seeded.seedThrough,
			complete: seeded.isSeeded,
			preserved: await database
				.select()
				.from(schema.sharedListingTaskDelivery)
				.where(eq(schema.sharedListingTaskDelivery.taskId, preservedId)),
			hints,
			replay: await store.seed(claim, now)
		}).toStrictEqual({
			cursor: sharedNarSource(130).narHash,
			through: sharedNarSource(130).narHash,
			complete: true,
			preserved,
			hints: [...ids.slice(32), behind, beyond].map((id) => ({ id })),
			replay: false
		});
	});

	it('preserves seeding progress after a lost checkpoint reply', async () => {
		const { database, job, task, ticket, store } = await fixture();
		const ids = [];
		for (let index = 0; index < 40; index++) {
			ids.push(await task(index));
		}
		await database.delete(schema.sharedListingTaskDelivery);
		await database.delete(schema.sharedListingJobDispatch);
		await store.enrol(job, now);
		const claim = claimed(await store.claim(job, owner, now));
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				await original(statements);
				throw new Error('The seeding checkpoint reply was lost');
			});
		try {
			await expect(store.seed(claim, now)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			batch.mockRestore();
		}
		await new SharedListingDispatchStore(database).seed(claim, now);
		const row = await ticket();
		expect({
			after: row.seedAfter,
			through: row.seedThrough,
			seeded: row.isSeeded,
			tasks: await database
				.select({ id: schema.sharedListingTaskDelivery.taskId })
				.from(schema.sharedListingTaskDelivery)
				.orderBy(schema.sharedListingTaskDelivery.taskId)
		}).toStrictEqual({
			after: sharedNarSource(39).narHash,
			through: sharedNarSource(39).narHash,
			seeded: true,
			tasks: ids.map((id) => ({ id }))
		});
	});

	it('rejects a delayed seeding checkpoint after another request advances the same claim', async () => {
		const { database, job, task, ticket, store } = await fixture();
		for (let index = 0; index < 97; index++) {
			await task(index);
		}
		await database.delete(schema.sharedListingTaskDelivery);
		await database.delete(schema.sharedListingJobDispatch);
		await store.enrol(job, now);
		const claim = claimed(await store.claim(job, owner, now));
		await store.seed(claim, now);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const started = Promise.withResolvers<boolean>();
		const release = Promise.withResolvers<boolean>();
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				started.resolve(true);
				await release.promise;
				return original(statements);
			});
		const delayed = store.seed(claim, now);
		try {
			await started.promise;
			await store.seed(claim, now);
			await store.seed(claim, now);
			release.resolve(true);
			const didAdvance = await delayed;
			const row = await ticket();
			expect({
				didAdvance,
				after: row.seedAfter,
				through: row.seedThrough,
				seeded: row.isSeeded
			}).toStrictEqual({
				didAdvance: false,
				after: sharedNarSource(95).narHash,
				through: sharedNarSource(96).narHash,
				seeded: false
			});
			await store.seed(claim, now);
			const completed = await ticket();
			expect(completed.isSeeded).toBe(true);
		} finally {
			release.resolve(true);
			try {
				await delayed;
			} finally {
				batch.mockRestore();
			}
		}
	});

	it('recovers an unacknowledged pass checkpoint without accepting its earlier ticket', async () => {
		const { job, store } = await fixture();
		const claim = claimed(await store.claim(job, owner, now));
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				await original(statements);
				throw new Error('The pass checkpoint reply was lost');
			});
		try {
			await expect(store.finish(claim, now)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			batch.mockRestore();
		}
		expect({
			stale: await store.finish(claim, now),
			hints: await store.reserve(now)
		}).toStrictEqual({ stale: false, hints: [job] });
	});

	it('dispatches ready siblings while discovery has a live independent lease', async () => {
		const { database, job, jobs, task, store } = await fixture();
		const discovery = await jobs.claim(job, other, now);
		if (discovery.kind !== 'claimed') {
			throw new Error('The fixture has no discovery lease');
		}
		expect(await store.claim(job, owner, now)).toStrictEqual({
			kind: 'unavailable'
		});
		await task(1);
		const pass = claimed(await store.claim(job, owner, now));
		const rows = await database
			.select({ owner: schema.sharedListingJob.owner })
			.from(schema.sharedListingJob);
		expect({ job: pass.job, discovery: rows }).toStrictEqual({
			job,
			discovery: [{ owner: other }]
		});
	});

	it('rejects a cancelled claim before seeding or replacing a newer ticket', async () => {
		const { database, job, jobs, task, store } = await fixture();
		await task(1);
		await database.delete(schema.sharedListingTaskDelivery);
		await database.delete(schema.sharedListingJobDispatch);
		await store.enrol(job, now);
		const claim = claimed(await store.claim(job, owner, now));
		await jobs.cancel(job, now);
		expect({
			seed: await store.seed(claim, now),
			finish: await store.finish(claim, now),
			deliveries: await database.select().from(schema.sharedListingTaskDelivery)
		}).toStrictEqual({ seed: false, finish: false, deliveries: [] });
	});

	it('expands without scanning existing jobs and enrols a preceding cancelled job on resume', async () => {
		const { database, job, jobs, task, ticket, store } = await fixture();
		const migration = env.TEST_MIGRATIONS.find(
			(item) => item.name === '0065_shared_listing_dispatch.sql'
		);
		if (migration === undefined) {
			throw new Error('The dispatch migration is missing');
		}
		await env.CUPBOARD_DB.batch(
			[
				'DROP TRIGGER shared_listing_dispatch_job_insert',
				'DROP TRIGGER shared_listing_dispatch_job_lifecycle',
				'DROP TRIGGER shared_listing_dispatch_job_delete',
				'DROP TRIGGER shared_listing_dispatch_discovery',
				'DROP TRIGGER shared_listing_dispatch_delivery_insert',
				'DROP TRIGGER shared_listing_dispatch_delivery_update',
				'DROP TRIGGER shared_listing_dispatch_delivery_delete',
				'DROP TABLE shared_listing_job_dispatch'
			].map((query) => env.CUPBOARD_DB.prepare(query))
		);
		try {
			await task(1);
			await jobs.cancel(job, now);
		} finally {
			await env.CUPBOARD_DB.batch(
				migration.queries.map((query) => env.CUPBOARD_DB.prepare(query))
			);
		}
		expect(
			await database.select().from(schema.sharedListingJobDispatch)
		).toStrictEqual([]);
		const resumed = await jobs.resume(job, later);
		if (resumed === undefined) {
			throw new Error('The preceding job did not resume');
		}
		const current = { id: resumed.id, generation: resumed.generation };
		const before = await database
			.select()
			.from(schema.sharedListingTaskDelivery);
		const beforeSeeding = await ticket(current);
		expect(beforeSeeding.isSeeded).toBe(false);
		const pass = claimed(await store.claim(current, owner, later));
		await store.seed(pass, later);
		const afterSeeding = await ticket(current);
		expect({
			seeded: afterSeeding.isSeeded,
			deliveries: await database.select().from(schema.sharedListingTaskDelivery)
		}).toStrictEqual({ seeded: true, deliveries: before });
	});

	it('uses bounded indexes with thousands of deferred tasks and disables an idle job', async () => {
		const { database, job, store, ticket } = await fixture();
		await database
			.update(schema.sharedListingJob)
			.set({ phase: 'processing' })
			.where(eq(schema.sharedListingJob.id, job.id));
		await database.run(sql`WITH RECURSIVE items(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM items WHERE i<2048)
   INSERT INTO shared_listing_task(id,job_id,nar_hash,source_incarnation,nar_size,file_size,discovery_page,created_at,ready_at)
   SELECT printf('20000000-0000-4000-8000-%012d',i),${job.id},printf('sha256:%052d',i),1,100,100,'future',${now},${future} FROM items`);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const reads: number[] = [];
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (statements) => {
				const results = await original(statements);
				reads.push(...results.map((row) => row.meta.rows_read));
				return results;
			});
		try {
			expect({
				hints: await store.reserve(now),
				bounded: reads.every((count) => count <= 128)
			}).toStrictEqual({ hints: [], bounded: true });
		} finally {
			batch.mockRestore();
		}
		const deferred = await ticket();
		expect(deferred.nextDeliveryAt).toBe(future);
		await database.delete(schema.sharedListingTask);
		const hints = await store.reserve(now);
		const row = await ticket();
		expect({ hints, idle: row.nextDeliveryAt ?? undefined }).toStrictEqual({
			hints: [],
			idle: undefined
		});
	});
});
