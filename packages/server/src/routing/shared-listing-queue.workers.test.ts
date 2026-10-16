import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type ArtifactJobVersion,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as schema from '../db/d1-schema.ts';
import { SharedListingDispatchSeedStore } from '../db/shared-listing-dispatch-seed.ts';
import { SharedListingJobStore } from '../db/shared-listing-jobs.ts';
import { sharedNarDiscoveryFixture } from '../db/shared-nar-discovery.test-support.ts';
import { withSubrequestSlice } from '../do/subrequest-slice.ts';
import { casObjectKey } from '../http/http.ts';
import {
	initialise,
	resetTestServer,
	scheduledController,
	testControlEnv
} from '../test-support.ts';
import worker from '../worker.ts';

import { QueueBatchSendError } from './scheduled.ts';
import { SharedListingQueue } from './shared-listing-queue.ts';
import { type SharedListingQueueMessage } from './shared-listing-queue-message.ts';
import {
	archive,
	registerNar
} from './shared-listing-task-worker.test-support.ts';

const now = isoTimestamp(new Date('3000-01-01T00:00:00.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
interface Action {
	readonly id: string;
	readonly action: 'ack' | 'retry';
	readonly delaySeconds?: number;
}
function transport(
	body: unknown,
	actions: Action[] = [],
	id = 'wake'
): Message {
	return {
		id,
		body,
		timestamp: new Date(now),
		attempts: 1,
		ack: () => {
			actions.push({ id, action: 'ack' });
		},
		retry: (options) => {
			actions.push({
				id,
				action: 'retry',
				delaySeconds: options?.delaySeconds
			});
		}
	};
}

function batch(messages: Message[]): MessageBatch {
	return {
		messages,
		queue: 'cupboard-artifacts',
		metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		ackAll: () => {
			throw new Error('Unexpected batch acknowledgement');
		},
		retryAll: () => {
			throw new Error('Unexpected batch retry');
		}
	};
}
async function fixture(count = 0) {
	const { database, sources } = await sharedNarDiscoveryFixture(count);
	await database.insert(schema.deploymentTransition).values([
		{ id: 'shared-listing-dispatch-seed', state: 'expanded', updatedAt: now },
		{ id: 'shared-listing-completion', state: 'expanded', updatedAt: now }
	]);
	const sent: SharedListingQueueMessage[] = [];
	const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
	const queue: Queue<SharedListingQueueMessage> = {
		metrics: () => Promise.resolve(metadata.metrics),
		send: (body) => {
			sent.push(body);
			return Promise.resolve({ metadata });
		},
		sendBatch: (entries) => {
			sent.push(...Array.from(entries, (entry) => entry.body));
			return Promise.resolve({ metadata });
		}
	};
	const dependencies = {
		database: env.CUPBOARD_DB,
		blobs: env.BLOBS,
		buffers: new NarReadBufferPool(),
		queue
	};
	const consumer = () => new SharedListingQueue(dependencies);
	const jobs = new SharedListingJobStore(database);
	async function start(): Promise<ArtifactJobVersion> {
		const job = await jobs.start(currentListingGeneratorRevision, now);
		return { id: job.id, generation: job.generation };
	}
	return {
		database,
		sources,
		sent,
		queue,
		dependencies,
		consumer,
		jobs,
		start
	};
}

describe('global listing work queue', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('dispatches past the first unclaimed page without granting job ownership', async () => {
		const { database, consumer, sent, start } = await fixture();
		const jobs: ArtifactJobVersion[] = [];
		for (let index = 0; index < 19; index++) {
			jobs.push(await start());
		}
		await consumer().start();
		const pages: ArtifactJobVersion[][] = [];
		for (let turn = 0; turn < 4; turn++) {
			const current = sent.splice(0);
			pages.push(
				current
					.filter((message) => message.kind === 'shared-listing-job')
					.map((message) => message.job)
			);
			const continuation = current.find(
				(message) => message.kind === 'shared-listing-dispatch'
			);
			if (continuation === undefined) {
				break;
			}
			await consumer().handleMessage(transport(continuation));
		}
		const owners = await database
			.select({ owner: schema.sharedListingJob.owner })
			.from(schema.sharedListingJob);
		expect({
			pages,
			owners: owners.map((row) => ({ owner: row.owner ?? undefined }))
		}).toStrictEqual({
			pages: [jobs.slice(0, 8), jobs.slice(8, 16), jobs.slice(16)],
			owners: Array.from({ length: 19 }, () => ({ owner: undefined }))
		});
	});

	it('continues catalogue recovery after a stale concurrent checkpoint', async () => {
		const { consumer, sent } = await fixture();
		const seed = vi
			.spyOn(SharedListingDispatchSeedStore.prototype, 'advance')
			.mockResolvedValueOnce({ kind: 'stale' });
		try {
			await consumer().start();
		} finally {
			seed.mockRestore();
		}
		const first = sent.splice(0);
		const actions: Action[] = [];
		await consumer().handleMessage(transport(first[0], actions));
		expect({ first, sent, actions }).toStrictEqual({
			first: [{ kind: 'shared-listing-dispatch' }],
			sent: [],
			actions: [{ id: 'wake', action: 'ack' }]
		});
	});

	it('dispatches independent tasks from one job beyond an unclaimed first page', async () => {
		const { database, consumer, sent, start, jobs } = await fixture(19);
		const job = await start();
		const claim = await jobs.claim(job, owner, now);
		if (claim.kind !== 'claimed') {
			throw new Error('Missing discovery claim');
		}
		await jobs.discover(claim.claim);
		const expected = await database
			.select({ id: schema.sharedListingTask.id })
			.from(schema.sharedListingTask)
			.orderBy(asc(schema.sharedListingTask.id));
		await consumer().handleMessage(
			transport({ kind: 'shared-listing-job', job })
		);
		const emitted: string[] = [];
		for (let turn = 0; turn < 64; turn++) {
			const next = sent.shift();
			if (next === undefined) {
				break;
			}
			if (next.kind === 'shared-listing-task') {
				emitted.push(next.id);
				continue;
			}
			await consumer().handleMessage(transport(next));
		}
		const tasks = await database
			.select({
				id: schema.sharedListingTask.id,
				owner: schema.sharedListingTask.claimOwner,
				state: schema.sharedListingTask.state
			})
			.from(schema.sharedListingTask);
		expect({
			emitted: emitted.toSorted(byCodeUnit),
			tasks: tasks
				.toSorted((a, b) => byCodeUnit(a.id, b.id))
				.map((row) => ({ ...row, owner: row.owner ?? undefined }))
		}).toStrictEqual({
			emitted: expected.map((row) => row.id),
			tasks: expected.map((row) => ({
				id: row.id,
				owner: undefined,
				state: 'pending'
			}))
		});
	});

	it('dispatches ready sibling tasks while another consumer owns discovery', async () => {
		const { consumer, sent, jobs, start } = await fixture(1);
		const job = await start();
		const first = await jobs.claim(job, owner, now);
		if (first.kind !== 'claimed') {
			throw new Error('Missing initial discovery claim');
		}
		await jobs.discover(first.claim);
		const busy = await jobs.claim(job, owner, now);
		if (busy.kind !== 'claimed') {
			throw new Error('Missing busy discovery claim');
		}
		await consumer().handleMessage(
			transport({ kind: 'shared-listing-job', job })
		);
		expect(
			sent
				.filter((message) => message.kind === 'shared-listing-task')
				.map((message) => message.job)
		).toStrictEqual([job]);
	});

	it('recovers failed job sends through persisted delivery deadlines', async () => {
		const { consumer, sent, queue, start } = await fixture();
		const job = await start();
		const send = vi
			.spyOn(queue, 'sendBatch')
			.mockRejectedValueOnce(new Error('The queue refused delivery'));
		await expect(consumer().start()).rejects.toThrow(
			'The queue refused delivery'
		);
		send.mockRestore();
		await consumer().start();
		expect(sent).toStrictEqual([]);
		vi.setSystemTime(new Date(Date.parse(now) + 60_001));
		await consumer().start();
		expect(sent).toStrictEqual([{ kind: 'shared-listing-job', job }]);
	});

	it('recovers failed task sends after the persisted metadata pass expires', async () => {
		const { database, consumer, sent, queue, start, jobs } = await fixture(1);
		const job = await start();
		const discovery = await jobs.claim(job, owner, now);
		if (discovery.kind !== 'claimed') {
			throw new Error('Missing discovery claim');
		}
		await jobs.discover(discovery.claim);
		const tasks = await database
			.select({ id: schema.sharedListingTask.id })
			.from(schema.sharedListingTask);
		const actions: Action[] = [];
		const send = vi
			.spyOn(queue, 'sendBatch')
			.mockRejectedValueOnce(new Error('Task delivery failed'));
		await consumer().handleMessage(
			transport({ kind: 'shared-listing-job', job }, actions, 'failed')
		);
		send.mockRestore();
		await consumer().handleMessage(
			transport({ kind: 'shared-listing-job', job }, actions, 'busy')
		);
		vi.setSystemTime(new Date(Date.parse(now) + 60_001));
		await consumer().handleMessage(
			transport({ kind: 'shared-listing-job', job }, actions, 'recovered')
		);
		expect({
			actions,
			tasks: sent.filter((message) => message.kind === 'shared-listing-task')
		}).toStrictEqual({
			actions: [
				{ id: 'failed', action: 'retry', delaySeconds: 60 },
				{ id: 'busy', action: 'ack' },
				{ id: 'recovered', action: 'ack' }
			],
			tasks: tasks.map((task) => ({
				kind: 'shared-listing-task',
				job,
				id: task.id
			}))
		});
	});

	it('refuses old job generations after cancellation and resume', async () => {
		const { database, consumer, sent, start, jobs } = await fixture();
		const job = await start();
		await jobs.cancel(job, now);
		const resumed = await jobs.resume(job, now);
		if (resumed === undefined) {
			throw new Error('The job did not resume');
		}
		const actions: Action[] = [];
		await consumer().handleMessage(
			transport({ kind: 'shared-listing-job', job }, actions)
		);
		const row = await database
			.select({ owner: schema.sharedListingJobDispatch.owner })
			.from(schema.sharedListingJobDispatch)
			.where(eq(schema.sharedListingJobDispatch.jobId, job.id));
		expect({
			sent,
			actions,
			row: row.map((item) => ({ owner: item.owner ?? undefined }))
		}).toStrictEqual({
			sent: [],
			actions: [{ id: 'wake', action: 'ack' }],
			row: [{ owner: undefined }]
		});
	});
	it('finalises a completed legacy processing job under its current pass', async () => {
		const { database, consumer, jobs, start } = await fixture();
		const job = await start();
		await database
			.update(schema.sharedListingJob)
			.set({ phase: 'processing' })
			.where(eq(schema.sharedListingJob.id, job.id));
		await database
			.update(schema.sharedListingJobDispatch)
			.set({ isSeeded: false })
			.where(eq(schema.sharedListingJobDispatch.jobId, job.id));
		await consumer().handleMessage(
			transport({ kind: 'shared-listing-job', job })
		);
		const summary = await jobs.find(job.id);
		expect({
			state: summary?.state,
			phase: summary?.phase,
			progress: summary?.progress
		}).toStrictEqual({
			state: 'complete',
			phase: 'processing',
			progress: { discovered: 0, completed: 0, skipped: 0, failed: 0 }
		});
	});

	it.each(['time', 'subrequests'] as const)(
		'leaves a message retryable when its %s allowance is exhausted',
		async (condition) => {
			const { consumer, start, sent } = await fixture();
			const job = await start();
			const queue = consumer();
			const actions: Action[] = [];
			if (condition === 'time') {
				vi.setSystemTime(new Date(Date.parse(now) + 14 * 60 * 1000));
			}
			await withSubrequestSlice(
				() =>
					queue.handleMessage(
						transport({ kind: 'shared-listing-job', job }, actions)
					),
				{ subrequests: condition === 'subrequests' ? 17 : 100, reserve: 0 }
			);
			expect({ actions, sent }).toStrictEqual({
				actions: [{ id: 'wake', action: 'retry', delaySeconds: 60 }],
				sent: []
			});
		}
	);

	it('accepts old-schema operation before dispatch expansion without accessing missing tables', async () => {
		const { database, consumer, start, sent } = await fixture();
		const job = await start();
		await database
			.delete(schema.deploymentTransition)
			.where(
				eq(schema.deploymentTransition.id, 'shared-listing-dispatch-seed')
			);
		const migration = env.TEST_MIGRATIONS.find(
			(item) => item.name === '0066_shared_listing_dispatch_seed.sql'
		);
		if (migration === undefined) {
			throw new Error('Missing dispatch seed migration');
		}
		await env.CUPBOARD_DB.prepare(
			'DROP TABLE shared_listing_dispatch_seed'
		).run();
		const actions: Action[] = [];
		try {
			await consumer().start();
			await consumer().handleMessage(
				transport({ kind: 'shared-listing-job', job }, actions)
			);
		} finally {
			await env.CUPBOARD_DB.batch(
				migration.queries.map((query) => env.CUPBOARD_DB.prepare(query))
			);
		}
		expect({ sent, actions }).toStrictEqual({
			sent: [],
			actions: [{ id: 'wake', action: 'ack' }]
		});
	});

	it('acknowledges malformed ownership capabilities before storage or execution', async () => {
		const { consumer, start, sent } = await fixture();
		const job = await start();
		const queue = consumer();
		const actions: Action[] = [];
		const access = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation(() => {
				throw new Error('Unexpected storage access');
			});
		try {
			await queue.handleMessage(
				transport({ kind: 'shared-listing-job', job, owner }, actions)
			);
		} finally {
			access.mockRestore();
		}
		expect({ actions, sent }).toStrictEqual({
			actions: [{ id: 'wake', action: 'ack' }],
			sent: []
		});
	});
	it('routes actual Worker hints through NAR verification and retained canonical CAS bytes', async () => {
		const { database, consumer, start, sent, queue, jobs } = await fixture();
		const { narHash } = await registerNar(database, archive('hello'));
		const job = await start();
		const actions: Action[] = [];
		await consumer().start();
		for (let turn = 0; turn < 32; turn++) {
			const next = sent.shift();
			if (next === undefined) {
				break;
			}
			const messageId = `message-${String(turn)}`;
			await worker.queue(
				batch([transport(next, actions, messageId)]),
				{
					...env,
					...testControlEnv,
					ARTIFACT_QUEUE: queue
				},
				createExecutionContext()
			);
		}
		const expected =
			'{"version":1,"root":{"type":"regular","size":5,"narOffset":96}}';
		const expectedBytes = new TextEncoder().encode(expected);
		const digest = sha256HexDigestSchema.parse(
			await sha256HexBytes(expectedBytes)
		);
		const cas = await database.select().from(schema.casObject).get();
		const object =
			cas === undefined
				? undefined
				: await env.BLOBS.get(casObjectKey(cas.digest, cas.incarnation));
		const summary = await jobs.find(job.id);
		expect({
			bytes:
				object === undefined || object === null
					? undefined
					: await object.text(),
			facts: await database.select().from(schema.listingFact),
			state: summary?.state,
			progress: summary?.progress,
			tenantReferences: await database.select().from(schema.artifactReference),
			tenantPresence: await database.select().from(schema.tenantCasBlob)
		}).toStrictEqual({
			bytes: expected,
			facts: [
				{
					narHash,
					generatorRevision: currentListingGeneratorRevision,
					format: 1,
					digest,
					size: expectedBytes.byteLength,
					createdAt: now
				}
			],
			state: 'complete',
			progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
			tenantReferences: [],
			tenantPresence: []
		});
		expect(actions.filter((action) => action.action === 'retry')).toStrictEqual(
			[]
		);
	});

	it('runs independent queued NAR tasks from the same job concurrently with fresh owners', async () => {
		const { database, queue, jobs, start } = await fixture();
		const first = await registerNar(database, archive('first'));
		const second = await registerNar(database, archive('second'), 1);
		const job = await start();
		for (let page = 0; page < 2; page++) {
			const claim = await jobs.claim(job, owner, now);
			if (claim.kind !== 'claimed') {
				throw new Error('Missing discovery claim');
			}
			await jobs.discover(claim.claim);
		}
		const tasks = await database
			.select({ id: schema.sharedListingTask.id })
			.from(schema.sharedListingTask)
			.orderBy(asc(schema.sharedListingTask.id));
		const started = Promise.withResolvers<boolean>();
		const sources = new Set<string>();
		let hasDistinctOwners = false;
		const get = env.BLOBS.get.bind(env.BLOBS);
		const barrier = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation(async (key, options) => {
				if (key.startsWith('nar/')) {
					sources.add(key);
					if (sources.size === 2) {
						const claims = await database
							.select({ owner: schema.sharedListingTask.claimOwner })
							.from(schema.sharedListingTask)
							.where(eq(schema.sharedListingTask.jobId, job.id));
						hasDistinctOwners =
							claims.every((row) => row.owner !== null) &&
							new Set(claims.map((row) => row.owner)).size === 2;
						started.resolve(true);
					}
					await started.promise;
				}
				return options === undefined ? get(key) : get(key, options);
			});
		const actions: Action[] = [];
		try {
			await Promise.all(
				tasks.map((task) =>
					worker.queue(
						batch([
							transport(
								{ kind: 'shared-listing-task', job, id: task.id },
								actions,
								task.id
							)
						]),
						{ ...env, ...testControlEnv, ARTIFACT_QUEUE: queue },
						createExecutionContext()
					)
				)
			);
			const summary = await jobs.find(job.id);
			expect({
				sources: [...sources].toSorted(byCodeUnit),
				hasDistinctOwners,
				actions: actions.toSorted((a, b) => byCodeUnit(a.id, b.id)),
				state: summary?.state,
				progress: summary?.progress
			}).toStrictEqual({
				sources: [first.source, second.source].toSorted(byCodeUnit),
				hasDistinctOwners: true,
				actions: tasks.map((task) => ({ id: task.id, action: 'ack' })),
				state: 'complete',
				progress: { discovered: 2, completed: 2, skipped: 0, failed: 0 }
			});
		} finally {
			started.resolve(true);
			barrier.mockRestore();
		}
	});

	it.each(['maintenance', 'listing'] as const)(
		'keeps global dispatch independent when %s cron work fails',
		async (phase) => {
			await resetTestServer();
			await initialise();
			const { sent, queue, start } = await fixture();
			const job = await start();
			const failure = new Error(`${phase} dispatch failed`);
			const maintenance = vi.spyOn(env.MAINTENANCE_QUEUE, 'sendBatch');
			const listing = vi.spyOn(queue, 'sendBatch');
			const failingDispatch = phase === 'maintenance' ? maintenance : listing;
			failingDispatch.mockRejectedValueOnce(failure);
			try {
				let observed: unknown;
				try {
					await worker.scheduled(scheduledController(), {
						...env,
						...testControlEnv,
						ARTIFACT_QUEUE: queue
					});
				} catch (error) {
					observed = error;
				}
				if (!(observed instanceof AggregateError)) {
					throw new Error('Cron did not report its failed dispatch');
				}
				expect({
					errors: observed.errors,
					maintenanceAttempted: maintenance.mock.calls.length > 0,
					listingAttempted: listing.mock.calls.length > 0,
					sent
				}).toStrictEqual({
					errors: [
						phase === 'maintenance'
							? new QueueBatchSendError([failure])
							: failure
					],
					maintenanceAttempted: true,
					listingAttempted: true,
					sent:
						phase === 'maintenance' ? [{ kind: 'shared-listing-job', job }] : []
				});
			} finally {
				maintenance.mockRestore();
				listing.mockRestore();
			}
		}
	);
});
