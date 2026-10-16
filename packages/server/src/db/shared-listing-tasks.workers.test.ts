import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type ArtifactJobVersion,
	artifactTaskGenerationSchema,
	type ArtifactTaskId,
	type ArtifactTaskOwner,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import type { SharedListingDiscoveryClaimResult } from '../blob/shared-listing-jobs.ts';
import type {
	SharedListingTaskClaim,
	SharedListingTaskClaimResult,
	SharedListingTaskRequest
} from '../blob/shared-listing-tasks.ts';

import * as schema from './d1-schema.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import { SharedListingTaskStore } from './shared-listing-tasks.ts';
import { sharedNarDiscoveryFixture } from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const later = isoTimestamp(new Date('2026-01-01T00:00:30.000Z'));
const deadline = isoTimestamp(new Date('2026-01-01T00:01:00.000Z'));
const retryAt = isoTimestamp(new Date('2026-01-01T00:05:00.000Z'));
const laterRetry = isoTimestamp(new Date('2026-01-01T00:10:00.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);

type Task = typeof schema.sharedListingTask.$inferSelect;
function taskClaim(result: SharedListingTaskClaimResult) {
	if (result.kind !== 'claimed') {
		throw new Error(`Expected a task claim, received ${result.kind}`);
	}
	return result.claim;
}
function discoveryClaim(result: SharedListingDiscoveryClaimResult) {
	if (result.kind !== 'claimed') {
		throw new Error(`Expected a discovery claim, received ${result.kind}`);
	}
	return result.claim;
}
function request(
	job: ArtifactJobVersion,
	id: ArtifactTaskId,
	claimOwner = owner
): SharedListingTaskRequest {
	return {
		job: { id: job.id, generation: job.generation },
		id,
		owner: claimOwner
	};
}
function expectedClaim(
	job: ArtifactJobVersion,
	task: Task,
	claimOwner: ArtifactTaskOwner = owner
): SharedListingTaskClaim {
	return {
		...request(job, task.id, claimOwner),
		generation: artifactTaskGenerationSchema.parse(1),
		generatorRevision: currentListingGeneratorRevision,
		narHash: task.narHash,
		sourceIncarnation: task.sourceIncarnation,
		narSize: task.narSize,
		fileSize: task.fileSize,
		leaseExpiresAt: deadline
	};
}
async function fixture(count = 2) {
	const { database } = await sharedNarDiscoveryFixture(count);
	const discovery = new SharedListingJobStore(database);
	const job = await discovery.start(currentListingGeneratorRevision, now);
	const claim = discoveryClaim(await discovery.claim(job, owner, now));
	await discovery.discover(claim);
	const tasks = await database
		.select()
		.from(schema.sharedListingTask)
		.orderBy(schema.sharedListingTask.narHash);
	return {
		database,
		discovery,
		job,
		tasks,
		store: new SharedListingTaskStore(database)
	};
}
function taskAt(tasks: readonly Task[], index: number) {
	const task = tasks[index];
	if (task === undefined) {
		throw new Error(`The fixture has no task at index ${String(index)}`);
	}
	return task;
}

describe('shared listing task ownership', () => {
	it('persists a claim and replays its request without extending the lease', async () => {
		const { database, job, tasks, store } = await fixture(1);
		const task = taskAt(tasks, 0);
		const first = await store.claim(request(job, task.id), now);
		const reopened = new SharedListingTaskStore(database);
		expect({
			first,
			replay: await reopened.claim(request(job, task.id), later),
			competing: await reopened.claim(request(job, task.id, otherOwner), later),
			persisted: await database.select().from(schema.sharedListingTask)
		}).toStrictEqual({
			first: { kind: 'claimed', claim: expectedClaim(job, task) },
			replay: first,
			competing: { kind: 'busy', retryAt: deadline },
			persisted: [
				{
					...task,
					state: 'running',
					claimGeneration: 1,
					claimJobGeneration: job.generation,
					claimOwner: owner,
					leaseExpiresAt: deadline,
					updatedAt: now
				}
			]
		});
	});

	it('admits one owner when two consumers claim the same task concurrently', async () => {
		const { job, tasks, store } = await fixture(1);
		const task = taskAt(tasks, 0);
		const results = await Promise.all([
			store.claim(request(job, task.id), now),
			store.claim(request(job, task.id, otherOwner), now)
		]);
		const isFirstWon = results[0].kind === 'claimed';
		const winner = {
			kind: 'claimed',
			claim: expectedClaim(job, task, isFirstWon ? owner : otherOwner)
		};
		const busy = { kind: 'busy', retryAt: deadline };
		expect(results).toStrictEqual(isFirstWon ? [winner, busy] : [busy, winner]);
	});

	it.each(['historical', 'catchup', 'processing'] as const)(
		'claims independent tasks in parallel during %s',
		async (phase) => {
			const { database, discovery, job, tasks, store } = await fixture(34);
			async function advanceDiscovery() {
				const claim = discoveryClaim(await discovery.claim(job, owner, now));
				await discovery.discover(claim);
			}
			switch (phase) {
				case 'processing': {
					await advanceDiscovery();
					await advanceDiscovery();
					break;
				}
				case 'catchup': {
					await advanceDiscovery();
					break;
				}
				case 'historical': {
					await discovery.claim(job, otherOwner, now);
					break;
				}
			}

			const first = taskAt(tasks, 0);
			const second = taskAt(tasks, 1);
			const claims = await Promise.all([
				store.claim(request(job, first.id), now),
				store.claim(request(job, second.id, otherOwner), now)
			]);
			const persistedRows = await database
				.select({
					phase: schema.sharedListingJob.phase,
					owner: schema.sharedListingJob.owner
				})
				.from(schema.sharedListingJob);
			const persisted = persistedRows.map((row) => ({
				phase: row.phase,
				owner: row.owner ?? undefined
			}));
			expect({ claims, persisted }).toStrictEqual({
				claims: [
					{ kind: 'claimed', claim: expectedClaim(job, first) },
					{ kind: 'claimed', claim: expectedClaim(job, second, otherOwner) }
				],
				persisted: [
					{ phase, owner: phase === 'historical' ? otherOwner : undefined }
				]
			});
		}
	);

	it('renews monotonically and refuses the expired owner after takeover', async () => {
		const { job, tasks, store } = await fixture(1);
		const task = taskAt(tasks, 0);
		const first = taskClaim(await store.claim(request(job, task.id), now));
		const extended = isoTimestamp(new Date('2026-01-01T00:01:30.000Z'));
		const renewed = [
			await store.renew(first, later),
			await store.renew(first, now)
		];
		vi.setSystemTime(extended);
		const replacement = await store.claim(
			request(job, task.id, otherOwner),
			extended
		);
		expect({
			renewed,
			replacement,
			oldRenewal: await store.renew(first, extended),
			oldDeferral: await store.defer(first, retryAt, extended)
		}).toStrictEqual({
			renewed: [extended, extended],
			replacement: {
				kind: 'claimed',
				claim: {
					...expectedClaim(job, task, otherOwner),
					generation: artifactTaskGenerationSchema.parse(2),
					leaseExpiresAt: isoTimestamp(new Date('2026-01-01T00:02:30.000Z'))
				}
			},
			oldRenewal: undefined,
			oldDeferral: undefined
		});
	});

	it('defers durably without extending a replayed retry deadline or reserving ownership', async () => {
		const { job, tasks, store } = await fixture(1);
		const task = taskAt(tasks, 0);
		const first = taskClaim(await store.claim(request(job, task.id), now));
		const firstDeferral = await store.defer(first, retryAt, now);
		const replay = await store.defer(first, laterRetry, later);
		const before = {
			ready: await store.ready(job, later),
			claim: await store.claim(request(job, task.id, otherOwner), later)
		};
		vi.setSystemTime(retryAt);
		const replacement = await store.claim(
			request(job, task.id, otherOwner),
			retryAt
		);
		expect({
			firstDeferral,
			replay,
			before,
			replacement,
			staleDeferral: await store.defer(first, laterRetry, retryAt)
		}).toStrictEqual({
			firstDeferral: retryAt,
			replay: retryAt,
			before: {
				ready: { tasks: [], hasMore: false },
				claim: { kind: 'busy', retryAt }
			},
			replacement: {
				kind: 'claimed',
				claim: {
					...expectedClaim(job, task, otherOwner),
					generation: artifactTaskGenerationSchema.parse(2),
					leaseExpiresAt: isoTimestamp(new Date('2026-01-01T00:06:00.000Z'))
				}
			},
			staleDeferral: undefined
		});
	});

	it('revokes cancelled work and makes its old running tasks ready immediately after resume', async () => {
		const { discovery, job, tasks, store } = await fixture(1);
		const task = taskAt(tasks, 0);
		const first = taskClaim(await store.claim(request(job, task.id), now));
		await discovery.cancel(job, now);
		const cancelled = {
			ready: await store.ready(job, now),
			claim: await store.claim(request(job, task.id, otherOwner), now),
			renewal: await store.renew(first, now),
			deferral: await store.defer(first, retryAt, now)
		};
		const resumed = await discovery.resume(job, now);
		if (resumed === undefined) {
			throw new Error('The cancelled job did not resume');
		}
		const ready = await store.ready(resumed, now);
		const replacement = await store.claim(
			request(resumed, task.id, otherOwner),
			now
		);
		expect({
			cancelled,
			ready,
			replacement,
			staleRenewal: await store.renew(first, now)
		}).toStrictEqual({
			cancelled: {
				ready: { tasks: [], hasMore: false },
				claim: { kind: 'unavailable' },
				renewal: undefined,
				deferral: undefined
			},
			ready: { tasks: [task.id], hasMore: false },
			replacement: {
				kind: 'claimed',
				claim: {
					...expectedClaim(resumed, task, otherOwner),
					generation: artifactTaskGenerationSchema.parse(2)
				}
			},
			staleRenewal: undefined
		});
	});

	it('releases superseded source ownership when catch-up refreshes a repaired incarnation', async () => {
		const { database, discovery, job, tasks, store } = await fixture(34);
		const task = taskAt(tasks, 0);
		const first = taskClaim(await store.claim(request(job, task.id), now));
		const identity = and(
			eq(schema.objectIncarnation.kind, 'nar'),
			eq(schema.objectIncarnation.objectId, task.narHash)
		);
		await database
			.update(schema.objectIncarnation)
			.set({ state: 'pending', incarnation: 3 })
			.where(identity);
		await database
			.update(schema.blobState)
			.set({ incarnation: 3 })
			.where(eq(schema.blobState.narHash, task.narHash));
		await database
			.update(schema.objectIncarnation)
			.set({ state: 'live' })
			.where(identity);
		await discovery.discover(
			discoveryClaim(await discovery.claim(job, owner, now))
		);
		await discovery.discover(
			discoveryClaim(await discovery.claim(job, owner, now))
		);
		const replacement = await store.claim(
			request(job, task.id, otherOwner),
			now
		);
		expect({
			replacement,
			staleRenewal: await store.renew(first, now),
			staleDeferral: await store.defer(first, retryAt, now)
		}).toStrictEqual({
			replacement: {
				kind: 'claimed',
				claim: {
					...expectedClaim(job, task, otherOwner),
					generation: artifactTaskGenerationSchema.parse(2),
					sourceIncarnation: 3
				}
			},
			staleRenewal: undefined,
			staleDeferral: undefined
		});
	});

	it.each([
		{ label: 'future pending tasks', state: 'pending', isCancelled: false },
		{ label: 'unexpired running tasks', state: 'running', isCancelled: false },
		{ label: 'cancelled job tasks', state: 'pending', isCancelled: true }
	] as const)(
		'bounds candidate reads with 3,000 $label',
		async ({ state, isCancelled }) => {
			const { database, discovery, job, tasks, store } = await fixture(2);
			const first = taskAt(tasks, 0);
			const second = taskAt(tasks, 1);
			await store.claim(request(job, first.id), now);
			const secondReady = isoTimestamp(new Date('2026-01-01T00:02:00.000Z'));
			await database
				.update(schema.sharedListingTask)
				.set({ readyAt: secondReady })
				.where(eq(schema.sharedListingTask.id, second.id));
			const eligibleAt = isCancelled ? now : laterRetry;
			const generation = state === 'running' ? 1 : 0;
			const claimOwner = state === 'running' ? sql`${owner}` : sql`null`;
			const expires = state === 'running' ? sql`${laterRetry}` : sql`null`;
			await database.run(sql`WITH RECURSIVE items(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM items WHERE i < 3000)
			INSERT INTO shared_listing_task (id, job_id, nar_hash, source_incarnation, nar_size, file_size, discovery_page, created_at, state, ready_at, claim_generation, claim_job_generation, claim_owner, lease_expires_at)
			SELECT printf('10000000-0000-4000-8000-%012d', i), ${job.id}, printf('sha256:%052d', 100000 + i), 2, 200, 100, 'future', ${now}, ${state}, ${eligibleAt}, ${generation}, ${generation}, ${claimOwner}, ${expires} FROM items`);
			await database
				.update(schema.sharedListingJob)
				.set({ discovered: 3002 })
				.where(eq(schema.sharedListingJob.id, job.id));
			if (isCancelled) {
				await discovery.cancel(job, now);
			}
			const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const reads: number[] = [];
			const measured = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementation(async (statements) => {
					const results = await batch(statements);
					reads.push(...results.map((result) => result.meta.rows_read));
					return results;
				});
			try {
				const ready = await store.ready(
					job,
					isoTimestamp(new Date('2026-01-01T00:03:00.000Z'))
				);
				expect({
					ready,
					statements: reads.length,
					hasBoundedReads: reads.every((read) => read <= 64)
				}).toStrictEqual({
					ready: {
						tasks: isCancelled ? [] : [first.id, second.id],
						hasMore: false
					},
					statements: 4,
					hasBoundedReads: true
				});
			} finally {
				measured.mockRestore();
			}
		}
	);

	it('reports more ready tasks while claiming independent pages', async () => {
		const { job, tasks, store } = await fixture(20);
		const ids = tasks.map((task) => task.id).toSorted(byCodeUnit);
		const first = await store.ready(job, now);
		await Promise.all(
			ids.slice(0, 8).map((id) => store.claim(request(job, id), now))
		);
		expect({ first, next: await store.ready(job, now) }).toStrictEqual({
			first: { tasks: ids.slice(0, 8), hasMore: true },
			next: { tasks: ids.slice(8, 16), hasMore: true }
		});
	});

	it('refuses a task from a different job without changing its ownership', async () => {
		const { database, discovery, tasks, store } = await fixture(1);
		const task = taskAt(tasks, 0);
		const other = await discovery.start(currentListingGeneratorRevision, now);
		expect({
			result: await store.claim(request(other, task.id), now),
			tasks: await database.select().from(schema.sharedListingTask)
		}).toStrictEqual({ result: { kind: 'unavailable' }, tasks });
	});

	it('refuses exhausted claim generations without mutating the task', async () => {
		const { database, job, tasks, store } = await fixture(1);
		const task = taskAt(tasks, 0);
		await database
			.update(schema.sharedListingTask)
			.set({
				claimGeneration: Number.MAX_SAFE_INTEGER,
				claimJobGeneration: job.generation,
				claimOwner: owner
			})
			.where(eq(schema.sharedListingTask.id, task.id));
		const before = await database.select().from(schema.sharedListingTask);
		expect({
			result: await store.claim(request(job, task.id), now),
			tasks: await database.select().from(schema.sharedListingTask)
		}).toStrictEqual({ result: { kind: 'unavailable' }, tasks: before });
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects a claim generation outside the wire integer domain: %s',
		async (generation) => {
			const { database, job, tasks } = await fixture(1);
			const task = taskAt(tasks, 0);
			await database
				.update(schema.sharedListingTask)
				.set({
					claimGeneration: 1,
					claimJobGeneration: job.generation,
					claimOwner: owner
				})
				.where(eq(schema.sharedListingTask.id, task.id));
			const before = await database.select().from(schema.sharedListingTask);
			await expect(
				database.run(
					sql`UPDATE shared_listing_task SET claim_generation = ${generation} WHERE id = ${task.id}`
				)
			).rejects.toThrow();
			expect(
				await database.select().from(schema.sharedListingTask)
			).toStrictEqual(before);
		}
	);
});
