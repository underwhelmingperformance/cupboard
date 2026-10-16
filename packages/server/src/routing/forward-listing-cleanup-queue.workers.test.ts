import {
	nixSha256HashSchema,
	sha256HexDigestSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { createExecutionContext } from 'cloudflare:test';
import { env as tenantEnv } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { artifactStageIdSchema } from '../blob/artifact-staging.ts';
import { sharedListingStageKey } from '../blob/shared-listing-staging.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as schema from '../db/d1-schema.ts';
import { ForwardListingStageStore } from '../db/forward-listing-staging.ts';
import { SharedListingGenerationStore } from '../db/shared-listing-generation.ts';
import { SharedListingTaskStore } from '../db/shared-listing-tasks.ts';
import { withSubrequestSlice } from '../do/subrequest-slice.ts';
import {
	clearBlobStorage,
	resetTestServer,
	testControlEnv
} from '../test-support.ts';
import worker from '../worker.ts';

import { type SharedListingCleanupMessage } from './shared-listing-cleanup-message.ts';
import { SharedListingCleanupQueue } from './shared-listing-cleanup-queue.ts';
import { sharedListingTaskFixture } from './shared-listing-task-worker.test-support.ts';

const env = Object.assign({}, tenantEnv, testControlEnv);
const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const retryAt = isoTimestamp(new Date(Date.parse(now) + 30_000));
const sweep = { kind: 'forward-listing-stage-sweep', through: now } as const;
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);

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
	await database.insert(schema.deploymentTransition).values({
		id: 'forward-listing-staging',
		state: 'complete',
		updatedAt: now
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
	const createdAt = isoTimestamp(new Date(Date.parse(now) - 2 * 60 * 60_000));
	const writeUntil = isoTimestamp(
		new Date(Date.parse(createdAt) + 15 * 60_000)
	);
	const stages = Array.from({ length: count }, (_, index) => {
		const suffix = String(index + 1).padStart(12, '0');
		const id = artifactStageIdSchema.parse(`00000000-0000-4000-8000-${suffix}`);
		return { id, key: sharedListingStageKey(id) };
	});
	for (const [index, stage] of stages.entries()) {
		await database.insert(schema.forwardListingStage).values({
			id: stage.id,
			tenant: tenantIdSchema.parse('cleanup-tenant'),
			uploadId: uploadIdSchema.parse(`upload-${String(index)}`),
			owner,
			narHash: nixSha256HashSchema.parse(
				`sha256:${String(index + 1).padStart(52, '0')}`
			),
			generatorRevision: currentListingGeneratorRevision,
			r2Key: stage.key,
			maximumBytes: maxArtifactBytes.listing,
			state: 'retired',
			createdAt,
			writeUntil,
			cleanupAfter: now,
			nextCleanupAt: now
		});
	}
	const stage = stages[0];
	if (stage === undefined) {
		throw new Error('The forward cleanup stage is missing');
	}
	return {
		database,
		store: new ForwardListingStageStore(database),
		queue,
		sent,
		consumer,
		stages,
		stage
	};
}

describe('durable forward staging cleanup', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it('enumerates fixed eight-stage pages through a finite sweep', async () => {
		const { consumer, sent, stages } = await fixture(19);
		await consumer().start();
		const first = [...sent];
		const next = sent.find(
			(message) => message.kind === 'forward-listing-stage-sweep'
		);
		if (next?.kind !== 'forward-listing-stage-sweep') {
			throw new Error('The forward sweep continuation is missing');
		}
		sent.length = 0;
		const actions: QueueAction[] = [];
		vi.setSystemTime(new Date(retryAt));
		await consumer().handleMessage(transport(next, actions, 'second'));
		const second = [...sent];
		const last = sent.find(
			(message) => message.kind === 'forward-listing-stage-sweep'
		);
		if (last?.kind !== 'forward-listing-stage-sweep') {
			throw new Error('The final forward sweep continuation is missing');
		}
		sent.length = 0;
		await consumer().handleMessage(transport(last, actions, 'third'));
		expect({ first, second, third: sent, actions }).toStrictEqual({
			first: [
				...stages
					.slice(0, 8)
					.map(({ id }) => ({ kind: 'forward-listing-stage-cleanup', id })),
				{ ...sweep, after: { at: now, id: stages[7]?.id } }
			],
			second: [
				...stages
					.slice(8, 16)
					.map(({ id }) => ({ kind: 'forward-listing-stage-cleanup', id })),
				{ ...sweep, after: { at: now, id: stages[15]?.id } }
			],
			third: stages
				.slice(16)
				.map(({ id }) => ({ kind: 'forward-listing-stage-cleanup', id })),
			actions: [
				{ id: 'second', action: 'ack' },
				{ id: 'third', action: 'ack' }
			]
		});
	});

	it.each(['send', 'sendBatch'] as const)(
		'recovers failed %s from durable deadlines',
		async (method) => {
			const { consumer, queue, sent, stages } = await fixture(10);
			const failure = vi
				.spyOn(queue, method)
				.mockRejectedValueOnce(new Error('queue unavailable'));
			try {
				await expect(consumer().start()).rejects.toThrow('queue unavailable');
				sent.length = 0;
				await consumer().start();
				expect(sent).toStrictEqual([
					...stages
						.slice(0, 8)
						.map(({ id }) => ({ kind: 'forward-listing-stage-cleanup', id })),
					{ ...sweep, after: { at: now, id: stages[7]?.id } }
				]);
			} finally {
				failure.mockRestore();
			}
		}
	);

	it.each([false, true])(
		'routes real multipart cleanup through the Worker (sealed=%s)',
		async (isSealed) => {
			const { database, stage, queue } = await fixture();
			const upload = await env.BLOBS.createMultipartUpload(stage.key);
			const bytes = new TextEncoder().encode('staged listing bytes');
			const part = await upload.uploadPart(1, bytes);
			await database
				.update(schema.forwardListingStage)
				.set({ multipartId: upload.uploadId });
			if (isSealed) {
				await upload.complete([part]);
				const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
				await database
					.update(schema.forwardListingStage)
					.set({ writesSealed: true, digest, size: bytes.byteLength });
			}
			const actions: QueueAction[] = [];
			const deletion = vi.spyOn(env.BLOBS, 'delete');
			try {
				for (const id of ['first', 'duplicate']) {
					await worker.queue(
						batch([
							transport(
								{ kind: 'forward-listing-stage-cleanup', id: stage.id },
								actions,
								id
							)
						]),
						{ ...env, ARTIFACT_QUEUE: queue },
						createExecutionContext()
					);
				}
				expect({
					actions,
					rows: await database.select().from(schema.forwardListingStage),
					object: (await env.BLOBS.head(stage.key)) ?? undefined,
					deleted: deletion.mock.calls.map(([key]) => key)
				}).toStrictEqual({
					actions: [
						{ id: 'first', action: 'ack' },
						{ id: 'duplicate', action: 'ack' }
					],
					rows: [],
					object: undefined,
					deleted: [stage.key]
				});
				await expect(upload.uploadPart(2, bytes)).rejects.toThrow();
			} finally {
				deletion.mockRestore();
			}
		}
	);

	it('persists failed deletion and recovers after the recorded retry deadline', async () => {
		const { database, consumer, stage, sent } = await fixture();
		await env.BLOBS.put(stage.key, 'orphaned listing');
		const actions: QueueAction[] = [];
		const failure = vi
			.spyOn(env.BLOBS, 'delete')
			.mockRejectedValueOnce(new Error('R2 unavailable'));
		try {
			const hint = { kind: 'forward-listing-stage-cleanup', id: stage.id };
			await consumer().handleMessage(transport(hint, actions, 'failed'));
			const retained = await database
				.select({
					id: schema.forwardListingStage.id,
					state: schema.forwardListingStage.state,
					generation: schema.forwardListingStage.cleanupGeneration,
					next: schema.forwardListingStage.nextCleanupAt,
					lease: schema.forwardListingStage.cleanupLeaseExpiresAt
				})
				.from(schema.forwardListingStage);
			await consumer().handleMessage(transport(hint, actions, 'early'));
			await consumer().start();
			const before = [...sent];
			vi.setSystemTime(new Date(retryAt));
			await consumer().start();
			await consumer().handleMessage(transport(sent[0], actions, 'recovered'));
			expect({
				retained: retained.map(({ lease, ...row }) => ({
					...row,
					isLeased: lease !== null
				})),
				before,
				sent,
				actions,
				rows: await database.select().from(schema.forwardListingStage)
			}).toStrictEqual({
				retained: [
					{
						id: stage.id,
						state: 'retired',
						generation: 1,
						next: retryAt,
						isLeased: false
					}
				],
				before: [],
				sent: [hint],
				actions: [
					{ id: 'failed', action: 'retry', delaySeconds: 30 },
					{ id: 'early', action: 'ack' },
					{ id: 'recovered', action: 'ack' }
				],
				rows: []
			});
		} finally {
			failure.mockRestore();
		}
	});

	it('preserves unsealed late writes until the cleanup horizon', async () => {
		const value = await fixture();
		await value.database.delete(schema.forwardListingStage);
		const reserved = await value.store.reserve(
			{
				tenant: tenantIdSchema.parse('cleanup-tenant'),
				uploadId: uploadIdSchema.parse('late-upload'),
				owner,
				narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
				generatorRevision: currentListingGeneratorRevision
			},
			now
		);
		if (reserved.kind !== 'writing') {
			throw new Error('The native reservation is missing');
		}
		const { lease } = reserved;
		const upload = await env.BLOBS.createMultipartUpload(lease.key);
		vi.setSystemTime(new Date(lease.writeUntil));
		const actions: QueueAction[] = [];
		const hint = { kind: 'forward-listing-stage-cleanup', id: lease.id };
		await value.consumer().handleMessage(transport(hint, actions, 'expired'));
		const isRegistered = await value.store.registerMultipart(
			lease,
			upload.uploadId,
			lease.writeUntil
		);
		const bytes = new TextEncoder().encode('late listing bytes');
		const part = await upload.uploadPart(1, bytes);
		await upload.complete([part]);
		await value.consumer().start();
		const before = [...value.sent];
		const retained = await env.BLOBS.head(lease.key);
		vi.setSystemTime(new Date(lease.cleanupAfter));
		await value.consumer().start();
		await value
			.consumer()
			.handleMessage(transport(value.sent[0], actions, 'cleaned'));
		expect({
			registered: isRegistered,
			before,
			retainedBytes: retained?.size,
			sent: value.sent,
			actions,
			rows: await value.database.select().from(schema.forwardListingStage),
			object: (await env.BLOBS.head(lease.key)) ?? undefined
		}).toStrictEqual({
			registered: false,
			before: [],
			retainedBytes: bytes.byteLength,
			sent: [hint],
			actions: [
				{ id: 'expired', action: 'ack' },
				{ id: 'cleaned', action: 'ack' }
			],
			rows: [],
			object: undefined
		});
	});

	it('acknowledges a stale forward hint after real handoff without deleting shared bytes', async () => {
		const value = await fixture();
		const current = await sharedListingTaskFixture();
		const reserved = await value.store.reserve(
			{
				tenant: tenantIdSchema.parse('discovery-first'),
				uploadId: uploadIdSchema.parse('native-upload'),
				owner,
				narHash: current.narHash,
				generatorRevision: currentListingGeneratorRevision
			},
			now
		);
		if (reserved.kind !== 'writing') {
			throw new Error('The native reservation is missing');
		}
		const { lease } = reserved;
		const upload = await env.BLOBS.createMultipartUpload(lease.key);
		await value.store.registerMultipart(lease, upload.uploadId, now);
		const bytes = new TextEncoder().encode('sealed listing bytes');
		const part = await upload.uploadPart(1, bytes);
		await upload.complete([part]);
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
		await value.store.recordSeal(
			lease,
			upload.uploadId,
			{ digest, size: bytes.byteLength },
			now
		);
		const task = await new SharedListingTaskStore(value.database).claim(
			current.first.request,
			now
		);
		if (task.kind !== 'claimed') {
			throw new Error('Task ownership was not granted');
		}
		const computation = await new SharedListingGenerationStore(
			value.database
		).claim(task.claim, now);
		if (computation.kind !== 'claimed') {
			throw new Error('Computation ownership was not granted');
		}
		const adopted = await value.store.adopt(computation.claim, now);
		if (adopted.kind !== 'ready') {
			throw new Error('The sealed listing was not transferred');
		}
		const actions: QueueAction[] = [];
		const deletion = vi.spyOn(env.BLOBS, 'delete');
		try {
			await worker.queue(
				batch([
					transport(
						{ kind: 'forward-listing-stage-cleanup', id: lease.id },
						actions
					)
				]),
				{ ...env, ARTIFACT_QUEUE: value.queue },
				createExecutionContext()
			);
			const object = await env.BLOBS.head(lease.key);
			expect({
				actions,
				deleted: deletion.mock.calls,
				shared: await value.database
					.select({
						id: schema.sharedListingStage.id,
						state: schema.sharedListingStage.state
					})
					.from(schema.sharedListingStage),
				objectSize: object?.size
			}).toStrictEqual({
				actions: [{ id: 'wake', action: 'ack' }],
				deleted: [],
				shared: [{ id: lease.id, state: 'ready' }],
				objectSize: bytes.byteLength
			});
		} finally {
			deletion.mockRestore();
		}
	});

	it.each(['absent', 'expanded', 'future-state'] as const)(
		'uses recorded %s readiness for dispatch and cleanup',
		async (state) => {
			const { database, consumer, sent, stage } = await fixture();
			const transition = eq(
				schema.deploymentTransition.id,
				'forward-listing-staging'
			);
			switch (state) {
				case 'absent': {
					await database.delete(schema.deploymentTransition).where(transition);
					break;
				}
				default: {
					await database
						.update(schema.deploymentTransition)
						.set({ state })
						.where(transition);
					break;
				}
			}
			await consumer().start();
			const actions: QueueAction[] = [];
			await consumer().handleMessage(
				transport(
					{ kind: 'forward-listing-stage-cleanup', id: stage.id },
					actions
				)
			);
			const canCollect = state !== 'absent';
			expect({
				sent,
				actions,
				remaining: await database
					.select({ id: schema.forwardListingStage.id })
					.from(schema.forwardListingStage)
			}).toStrictEqual({
				sent: canCollect
					? [{ kind: 'forward-listing-stage-cleanup', id: stage.id }]
					: [],
				actions: [{ id: 'wake', action: 'ack' }],
				remaining: canCollect ? [] : [{ id: stage.id }]
			});
		}
	);

	it.each(['shared', 'forward'] as const)(
		'preserves independent cleanup dispatch when %s staging sends fail',
		async (scope) => {
			const { database, consumer, queue, sent, stage } = await fixture();
			await database.insert(schema.deploymentTransition).values({
				id: 'shared-listing-staging',
				state: 'complete',
				updatedAt: now
			});
			const id = artifactStageIdSchema.parse(
				'00000000-0000-4000-8000-000000000100'
			);
			await database.insert(schema.sharedListingStage).values({
				id,
				narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
				generatorRevision: currentListingGeneratorRevision,
				sourceIncarnation: 1,
				computationGeneration: 1,
				r2Key: sharedListingStageKey(id),
				maximumBytes: maxArtifactBytes.listing,
				state: 'retired',
				createdAt: now,
				expiresAt: now,
				writeUntil: now,
				cleanupAfter: now,
				nextCleanupAt: now
			});
			const send = queue.sendBatch.bind(queue);
			const failure = new Error('staging send failed');
			const failedKind =
				scope === 'forward'
					? 'forward-listing-stage-cleanup'
					: 'shared-listing-stage-cleanup';
			const observed = vi
				.spyOn(queue, 'sendBatch')
				.mockImplementation((messages, options) => {
					const entries = [...messages];
					if (entries.some((entry) => entry.body.kind === failedKind)) {
						return Promise.reject(failure);
					}
					return send(entries, options);
				});
			try {
				await expect(consumer().start()).rejects.toThrow(failure);
				expect(sent).toStrictEqual([
					scope === 'forward'
						? { kind: 'shared-listing-stage-cleanup', id }
						: { kind: 'forward-listing-stage-cleanup', id: stage.id }
				]);
			} finally {
				observed.mockRestore();
			}
		}
	);

	it('does not query forward storage before expansion', async () => {
		const { database, consumer, queue, sent, stage } = await fixture();
		await database
			.delete(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'forward-listing-staging'));
		const migration = env.TEST_MIGRATIONS.find(
			(entry) => entry.name === '0077_forward_listing_staging.sql'
		);
		if (migration === undefined) {
			throw new Error('The forward staging migration is missing');
		}
		await env.CUPBOARD_DB.prepare('DROP TABLE forward_listing_stage').run();
		const actions: QueueAction[] = [];
		try {
			await consumer().start();
			await worker.queue(
				batch([
					transport(
						{ kind: 'forward-listing-stage-cleanup', id: stage.id },
						actions
					)
				]),
				{ ...env, ARTIFACT_QUEUE: queue },
				createExecutionContext()
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

	it.each(['time', 'subrequests'] as const)(
		'defers later hints after exhausting %s',
		async (limit) => {
			const { consumer, stages, database } = await fixture(2);
			const handler = consumer();
			const actions: QueueAction[] = [];
			await withSubrequestSlice(
				async () => {
					for (const [index, stage] of stages.entries()) {
						if (index === 1 && limit === 'time') {
							vi.setSystemTime(new Date(retryAt));
						}
						await handler.handleMessage(
							transport(
								{ kind: 'forward-listing-stage-cleanup', id: stage.id },
								actions,
								stage.id
							)
						);
					}
				},
				{ subrequests: limit === 'time' ? 100 : 8, reserve: 0 }
			);
			expect({
				actions,
				rows: await database
					.select({ id: schema.forwardListingStage.id })
					.from(schema.forwardListingStage)
			}).toStrictEqual({
				actions: [
					{ id: stages[0]?.id, action: 'ack' },
					{ id: stages[1]?.id, action: 'retry', delaySeconds: 60 }
				],
				rows: [{ id: stages[1]?.id }]
			});
		}
	);
});
