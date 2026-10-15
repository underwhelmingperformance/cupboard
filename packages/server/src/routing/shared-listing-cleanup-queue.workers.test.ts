import { nixSha256HashSchema } from '@cupboard/nix-store/scalars';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env as tenantEnv } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { artifactStageIdSchema } from '../blob/artifact-staging.ts';
import { sharedListingStageKey } from '../blob/shared-listing-staging.ts';
import * as schema from '../db/d1-schema.ts';
import { SharedListingStageStore } from '../db/shared-listing-staging.ts';
import { withSubrequestSlice } from '../do/subrequest-slice.ts';
import {
	initialise,
	resetTestServer,
	scheduledController,
	testControlEnv
} from '../test-support.ts';
import worker from '../worker.ts';

import { QueueBatchSendError } from './scheduled.ts';
import { type SharedListingCleanupMessage } from './shared-listing-cleanup-message.ts';
import { SharedListingCleanupQueue } from './shared-listing-cleanup-queue.ts';

const env = Object.assign({}, tenantEnv, testControlEnv);
const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const later = isoTimestamp(new Date('2026-01-01T00:01:00.000Z'));
const retryAt = isoTimestamp(new Date('2026-01-01T00:00:30.000Z'));
const sweep = { kind: 'shared-listing-stage-sweep', through: now } as const;
interface QueueAction {
	readonly id: string;
	readonly action: 'ack' | 'retry';
	readonly delaySeconds?: number;
}
function transport(
	body: unknown,
	actions: QueueAction[],
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
async function fixture(count = 1) {
	const database = drizzle(env.CUPBOARD_DB, { schema });
	await database
		.insert(schema.deploymentTransition)
		.values({ id: 'shared-listing-staging', state: 'complete', updatedAt: now })
		.onConflictDoUpdate({
			target: schema.deploymentTransition.id,
			set: { state: 'complete' }
		});
	const sent: SharedListingCleanupMessage[] = [];
	const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
	const queue: Queue<SharedListingCleanupMessage> = {
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
	const consumer = () =>
		new SharedListingCleanupQueue({
			database: env.CUPBOARD_DB,
			blobs: env.BLOBS,
			queue
		});
	const stages = Array.from({ length: count }, (_, index) => {
		const suffix = String(index + 1).padStart(12, '0');
		const id = artifactStageIdSchema.parse(`00000000-0000-4000-8000-${suffix}`);
		return { id, key: sharedListingStageKey(id) };
	});
	for (const [index, stage] of stages.entries()) {
		await database.insert(schema.sharedListingStage).values({
			id: stage.id,
			narHash: nixSha256HashSchema.parse(
				`sha256:${String(index + 1).padStart(52, '0')}`
			),
			generatorRevision: currentListingGeneratorRevision,
			sourceIncarnation: 1,
			computationGeneration: 1,
			r2Key: stage.key,
			maximumBytes: maxArtifactBytes.listing,
			state: 'retired',
			createdAt: now,
			expiresAt: now,
			writeUntil: now,
			cleanupAfter: now,
			nextCleanupAt: now
		});
	}
	const stage = stages[0];
	if (stage === undefined) {
		throw new Error('The cleanup stage is missing');
	}
	return {
		database,
		store: new SharedListingStageStore(database),
		queue,
		sent,
		consumer,
		stages,
		stage
	};
}

describe('durable shared staging cleanup dispatch', () => {
	beforeEach(resetTestServer);

	it('enumerates a finite wave without repeatedly sending unclaimed first-page stages', async () => {
		const { sent, consumer, stages } = await fixture(19);
		await consumer().start();
		const first = [...sent];
		let next = sent.find(
			(message) => message.kind === 'shared-listing-stage-sweep'
		);
		if (next?.kind !== 'shared-listing-stage-sweep') {
			throw new Error('The cleanup continuation is missing');
		}
		sent.length = 0;
		vi.setSystemTime(new Date(later));
		const actions: QueueAction[] = [];
		await consumer().handleMessage(transport(next, actions, 'second'));
		const second = [...sent];
		next = sent.find(
			(message) => message.kind === 'shared-listing-stage-sweep'
		);
		if (next?.kind !== 'shared-listing-stage-sweep') {
			throw new Error('The second continuation is missing');
		}
		sent.length = 0;
		await consumer().handleMessage(transport(next, actions, 'third'));
		expect({ first, second, third: sent, actions }).toStrictEqual({
			first: [
				...stages
					.slice(0, 8)
					.map(({ id }) => ({ kind: 'shared-listing-stage-cleanup', id })),
				{ ...sweep, after: { at: now, id: stages[7]?.id } }
			],
			second: [
				...stages
					.slice(8, 16)
					.map(({ id }) => ({ kind: 'shared-listing-stage-cleanup', id })),
				{ ...sweep, after: { at: now, id: stages[15]?.id } }
			],
			third: stages
				.slice(16)
				.map(({ id }) => ({ kind: 'shared-listing-stage-cleanup', id })),
			actions: [
				{ id: 'second', action: 'ack' },
				{ id: 'third', action: 'ack' }
			]
		});
	});

	it('starts a new wave for deadlines beyond an earlier cutoff', async () => {
		const { database, stage, sent, consumer } = await fixture();
		await database
			.update(schema.sharedListingStage)
			.set({ cleanupAfter: later, nextCleanupAt: later })
			.where(eq(schema.sharedListingStage.id, stage.id));
		await consumer().start();
		const first = [...sent];
		vi.setSystemTime(new Date(later));
		await consumer().start();
		expect({ first, later: sent }).toStrictEqual({
			first: [],
			later: [{ kind: 'shared-listing-stage-cleanup', id: stage.id }]
		});
	});

	it.each(['sendBatch', 'send'] as const)(
		'recovers a failed %s without changing durable cleanup state',
		async (method) => {
			const { database, stages, queue, sent, consumer } = await fixture(10);
			const failed = vi
				.spyOn(queue, method)
				.mockRejectedValueOnce(new Error('queue send failed'));
			try {
				await expect(consumer().start()).rejects.toThrow('queue send failed');
				sent.length = 0;
				await consumer().start();
				const retained = await database
					.select({ id: schema.sharedListingStage.id })
					.from(schema.sharedListingStage)
					.orderBy(schema.sharedListingStage.id);
				expect({ sent, retained }).toStrictEqual({
					sent: [
						...stages
							.slice(0, 8)
							.map(({ id }) => ({ kind: 'shared-listing-stage-cleanup', id })),
						{ ...sweep, after: { at: now, id: stages[7]?.id } }
					],
					retained: stages.map(({ id }) => ({ id }))
				});
			} finally {
				failed.mockRestore();
			}
		}
	);

	it('routes a per-stage hint through the Worker and removes orphaned R2 bytes', async () => {
		const { database, stage, queue } = await fixture();
		await env.BLOBS.put(stage.key, 'staged bytes');
		const actions: QueueAction[] = [];
		await worker.queue(
			batch([
				transport(
					{ kind: 'shared-listing-stage-cleanup', id: stage.id },
					actions
				)
			]),
			{ ...env, ARTIFACT_QUEUE: queue }
		);
		const remaining = await database.select().from(schema.sharedListingStage);
		expect({
			actions,
			remaining,
			object: (await env.BLOBS.head(stage.key)) ?? undefined
		}).toStrictEqual({
			actions: [{ id: 'wake', action: 'ack' }],
			remaining: [],
			object: undefined
		});
	});

	it('acknowledges duplicate hints without repeating physical deletion', async () => {
		const { stage, consumer } = await fixture();
		const actions: QueueAction[] = [];
		const deletion = vi.spyOn(env.BLOBS, 'delete');
		try {
			await consumer().handleMessage(
				transport(
					{ kind: 'shared-listing-stage-cleanup', id: stage.id },
					actions,
					'first'
				)
			);
			await consumer().handleMessage(
				transport(
					{ kind: 'shared-listing-stage-cleanup', id: stage.id },
					actions,
					'duplicate'
				)
			);
			expect({
				actions,
				deleted: deletion.mock.calls.map(([key]) => key)
			}).toStrictEqual({
				actions: [
					{ id: 'first', action: 'ack' },
					{ id: 'duplicate', action: 'ack' }
				],
				deleted: [stage.key]
			});
		} finally {
			deletion.mockRestore();
		}
	});

	it('persists a failed deletion deadline and recovers with a fresh cron wave', async () => {
		const { stage, consumer, sent, store } = await fixture();
		const actions: QueueAction[] = [];
		const deletion = vi
			.spyOn(env.BLOBS, 'delete')
			.mockRejectedValueOnce(new Error('R2 unavailable'));
		try {
			await consumer().handleMessage(
				transport(
					{ kind: 'shared-listing-stage-cleanup', id: stage.id },
					actions,
					'failed'
				)
			);
			await consumer().start();
			const before = [...sent];
			vi.setSystemTime(new Date(retryAt));
			await consumer().start();
			const recovery = [...sent];
			await consumer().handleMessage(
				transport(recovery[0], actions, 'recovered')
			);
			expect({
				before,
				recovery,
				actions,
				due: await store.due(retryAt)
			}).toStrictEqual({
				before: [],
				recovery: [{ kind: 'shared-listing-stage-cleanup', id: stage.id }],
				actions: [
					{ id: 'failed', action: 'retry', delaySeconds: 30 },
					{ id: 'recovered', action: 'ack' }
				],
				due: { stages: [], hasMore: false }
			});
		} finally {
			deletion.mockRestore();
		}
	});

	it('recovers an expired cleanup claim without deleting during the earlier lease', async () => {
		const { stage, consumer, sent, store } = await fixture();
		const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
		await store.claimCleanup(stage.id, owner, now);
		const actions: QueueAction[] = [];
		const deletion = vi.spyOn(env.BLOBS, 'delete');
		try {
			await consumer().handleMessage(
				transport(
					{ kind: 'shared-listing-stage-cleanup', id: stage.id },
					actions,
					'busy'
				)
			);
			await consumer().start();
			const before = [...sent];
			vi.setSystemTime(new Date(retryAt));
			await consumer().start();
			await consumer().handleMessage(transport(sent[0], actions, 'recovered'));
			expect({
				before,
				sent,
				actions,
				deleted: deletion.mock.calls.map(([key]) => key),
				due: await store.due(retryAt)
			}).toStrictEqual({
				before: [],
				sent: [{ kind: 'shared-listing-stage-cleanup', id: stage.id }],
				actions: [
					{ id: 'busy', action: 'ack' },
					{ id: 'recovered', action: 'ack' }
				],
				deleted: [stage.key],
				due: { stages: [], hasMore: false }
			});
		} finally {
			deletion.mockRestore();
		}
	});

	it('delays unsealed cleanup until the late-write horizon', async () => {
		const { database, stage, consumer, store } = await fixture();
		await database
			.update(schema.sharedListingStage)
			.set({ state: 'pending', cleanupAfter: later })
			.where(eq(schema.sharedListingStage.id, stage.id));
		const actions: QueueAction[] = [];
		await consumer().handleMessage(
			transport({ kind: 'shared-listing-stage-cleanup', id: stage.id }, actions)
		);
		expect({
			actions,
			now: await store.due(now),
			later: await store.due(later)
		}).toStrictEqual({
			actions: [{ id: 'wake', action: 'ack' }],
			now: { stages: [], hasMore: false },
			later: { stages: [stage.id], hasMore: false }
		});
	});

	it('retries a continuation send failure using the original finite wave', async () => {
		const { consumer, queue } = await fixture(10);
		const failed = vi
			.spyOn(queue, 'send')
			.mockRejectedValueOnce(new Error('continuation send failed'));
		const actions: QueueAction[] = [];
		try {
			await consumer().handleMessage(transport(sweep, actions));
			expect(actions).toStrictEqual([
				{ id: 'wake', action: 'retry', delaySeconds: 60 }
			]);
		} finally {
			failed.mockRestore();
		}
	});

	it('processes independent cleanup messages while invocation capacity remains', async () => {
		const { database, stages, consumer } = await fixture(2);
		const handler = consumer();
		const actions: QueueAction[] = [];
		for (const stage of stages) {
			await handler.handleMessage(
				transport(
					{ kind: 'shared-listing-stage-cleanup', id: stage.id },
					actions,
					stage.id
				)
			);
		}
		expect({
			actions,
			remaining: await database.select().from(schema.sharedListingStage)
		}).toStrictEqual({
			actions: stages.map(({ id }) => ({ id, action: 'ack' })),
			remaining: []
		});
	});

	it.each(['time', 'subrequests'] as const)(
		'preserves later work when the invocation exhausts %s',
		async (limit) => {
			const { database, stages, consumer } = await fixture(2);
			const handler = consumer();
			const actions: QueueAction[] = [];
			await withSubrequestSlice(
				async () => {
					for (const [index, stage] of stages.entries()) {
						if (index === 1 && limit === 'time') {
							vi.setSystemTime(new Date(later));
						}
						await handler.handleMessage(
							transport(
								{ kind: 'shared-listing-stage-cleanup', id: stage.id },
								actions,
								stage.id
							)
						);
					}
				},
				{ subrequests: limit === 'time' ? 100 : 8, reserve: 0 }
			);
			const remaining = await database
				.select({ id: schema.sharedListingStage.id })
				.from(schema.sharedListingStage);
			expect({ actions, remaining }).toStrictEqual({
				actions: [
					{ id: stages[0]?.id, action: 'ack' },
					{ id: stages[1]?.id, action: 'retry', delaySeconds: 60 }
				],
				remaining: [{ id: stages[1]?.id }]
			});
		}
	);

	it('ignores absent storage before expansion without querying a missing table', async () => {
		const { database, queue, sent, consumer, stage } = await fixture();
		await database
			.delete(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'shared-listing-staging'));
		const migration = env.TEST_MIGRATIONS.find(
			(entry) => entry.name === '0060_shared_listing_staging.sql'
		);
		if (migration === undefined) {
			throw new Error('The staging migration is missing');
		}
		await env.CUPBOARD_DB.prepare('DROP TABLE shared_listing_stage').run();
		const actions: QueueAction[] = [];
		try {
			await consumer().start();
			await worker.queue(
				batch([
					transport(
						{ kind: 'shared-listing-stage-cleanup', id: stage.id },
						actions
					)
				]),
				{ ...env, ARTIFACT_QUEUE: queue }
			);
			expect({ sent, actions }).toStrictEqual({
				sent: [],
				actions: [{ id: 'wake', action: 'ack' }]
			});
		} finally {
			await env.CUPBOARD_DB.batch(
				migration.queries.map((query) => env.CUPBOARD_DB.prepare(query))
			);
		}
	});

	it.each(['absent', 'expanded', 'future-state'] as const)(
		'uses recorded %s readiness for both dispatch and cleanup',
		async (state) => {
			const { database, stage, consumer, sent } = await fixture();
			const transition = eq(
				schema.deploymentTransition.id,
				'shared-listing-staging'
			);
			if (state === 'absent') {
				await database.delete(schema.deploymentTransition).where(transition);
			}
			if (state !== 'absent') {
				await database
					.update(schema.deploymentTransition)
					.set({ state })
					.where(transition);
			}
			await consumer().start();
			const actions: QueueAction[] = [];
			await consumer().handleMessage(
				transport(
					{ kind: 'shared-listing-stage-cleanup', id: stage.id },
					actions
				)
			);
			const remaining = await database
				.select({ id: schema.sharedListingStage.id })
				.from(schema.sharedListingStage);
			const canCollect = state !== 'absent';
			expect({ sent, actions, remaining }).toStrictEqual({
				sent: canCollect
					? [{ kind: 'shared-listing-stage-cleanup', id: stage.id }]
					: [],
				actions: [{ id: 'wake', action: 'ack' }],
				remaining: canCollect ? [] : [{ id: stage.id }]
			});
		}
	);

	it('retries a failed readiness read before accessing R2', async () => {
		const { stage, consumer } = await fixture();
		const actions: QueueAction[] = [];
		const failed = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementationOnce(() => {
				throw new Error('D1 unavailable');
			});
		const deletion = vi.spyOn(env.BLOBS, 'delete');
		try {
			await consumer().handleMessage(
				transport(
					{ kind: 'shared-listing-stage-cleanup', id: stage.id },
					actions
				)
			);
			expect({ actions, deleted: deletion.mock.calls }).toStrictEqual({
				actions: [{ id: 'wake', action: 'retry', delaySeconds: 60 }],
				deleted: []
			});
		} finally {
			deletion.mockRestore();
			failed.mockRestore();
		}
	});

	it('rejects a malformed cleanup payload without reading D1', async () => {
		const { consumer } = await fixture();
		const queries = vi.spyOn(env.CUPBOARD_DB, 'prepare');
		const actions: QueueAction[] = [];
		try {
			await consumer().handleMessage(
				transport({ kind: 'shared-listing-stage-cleanup', id: 'bad' }, actions)
			);
			expect(actions).toStrictEqual([{ id: 'wake', action: 'ack' }]);
			expect(queries).not.toHaveBeenCalled();
		} finally {
			queries.mockRestore();
		}
	});

	it.each(['maintenance', 'cleanup', 'both'] as const)(
		'keeps cron passes independent when %s dispatch fails',
		async (phase) => {
			await initialise();
			const { queue, sent, stage } = await fixture();
			const failure = new Error('dispatch failed');
			const maintenance = vi.spyOn(env.MAINTENANCE_QUEUE, 'sendBatch');
			const cleanup = vi.spyOn(queue, 'sendBatch');
			if (phase !== 'cleanup') {
				maintenance.mockRejectedValueOnce(failure);
			}
			if (phase !== 'maintenance') {
				cleanup.mockRejectedValueOnce(failure);
			}
			try {
				let observed: unknown;
				try {
					await worker.scheduled(scheduledController(), {
						...env,
						ARTIFACT_QUEUE: queue
					});
				} catch (error) {
					observed = error;
				}
				if (!(observed instanceof AggregateError)) {
					throw new Error('Cron did not report its dispatch failures', {
						cause: observed
					});
				}
				const errors: readonly unknown[] = observed.errors;
				const expectedErrors: unknown[] = [];
				if (phase !== 'cleanup') {
					expectedErrors.push(new QueueBatchSendError([failure]));
				}
				if (phase !== 'maintenance') {
					expectedErrors.push(failure);
				}
				expect({
					maintenanceAttempted: maintenance.mock.calls.length > 0,
					cleanupAttempted: cleanup.mock.calls.length > 0,
					sent,
					failure: { message: observed.message, errors }
				}).toStrictEqual({
					failure: {
						message: 'cron queue dispatch failed',
						errors: expectedErrors
					},
					maintenanceAttempted: true,
					cleanupAttempted: true,
					sent:
						phase === 'maintenance'
							? [{ kind: 'shared-listing-stage-cleanup', id: stage.id }]
							: []
				});
			} finally {
				cleanup.mockRestore();
				maintenance.mockRestore();
			}
		}
	);
});
