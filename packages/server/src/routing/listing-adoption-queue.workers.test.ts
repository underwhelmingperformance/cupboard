import {
	cacheGenerationSchema,
	cacheNameSchema,
	sha256HexDigestSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { listingGeneratorRevisionSchema } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { asc, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listingAdoptionCaptureSequenceSchema } from '../blob/listing-adoption-capture.ts';
import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import * as schema from '../db/d1-schema.ts';
import { ListingAdoptionFactSeedStore } from '../db/listing-adoption-fact-seed.ts';
import { ListingAdoptionParentSeedStore } from '../db/listing-adoption-parent-seed.ts';
import { ListingFactStore } from '../db/listing-facts.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from '../db/shared-nar-discovery.test-support.ts';
import { withSubrequestSlice } from '../do/subrequest-slice.ts';
import {
	initialise,
	resetTestServer,
	scheduledController,
	testControlEnv
} from '../test-support.ts';
import worker from '../worker.ts';

import { ListingAdoptionQueue } from './listing-adoption-queue.ts';
import { type ListingAdoptionQueueMessage } from './listing-adoption-queue-message.ts';
import { handleWorkerQueue } from './queue.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const scopes = ['default-parents', 'facts', 'named-parents'] as const;
const tenant = tenantIdSchema.parse('discovery-first');
interface Action {
	readonly action: 'ack' | 'retry';
	readonly delaySeconds?: number;
}
function transport(body: unknown, actions: Action[]): Message {
	return {
		id: 'wake',
		body,
		timestamp: new Date(now),
		attempts: 1,
		ack: () => {
			actions.push({ action: 'ack' });
		},
		retry: (options) => {
			actions.push({ action: 'retry', delaySeconds: options?.delaySeconds });
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
	const { database } = await sharedNarDiscoveryFixture(0);
	await database.insert(schema.deploymentTransition).values([
		{ id: 'listing-adoption-capture', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-fact-seed', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-parents', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-parent-seed', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-seed-dispatch', state: 'complete', updatedAt: now }
	]);
	const facts = new ListingFactStore(database);
	for (let index = 1; index <= count; index++) {
		await facts.record({
			narHash: sharedNarSource(index).narHash,
			generatorRevision: listingGeneratorRevisionSchema.parse('history'),
			format: 1,
			digest: sha256HexDigestSchema.parse('a'.repeat(64)),
			size: 10
		});
	}
	for (const kind of ['default', 'named'] as const) {
		await database.insert(schema.cacheLifecycle).values({
			tenant,
			cacheKind: kind,
			...(kind === 'named' && {
				cacheName: cacheNameSchema.parse('private')
			}),
			generation: cacheGenerationSchema.parse(1),
			access: 'private',
			updatedAt: now
		});
		if (count === 0) {
			continue;
		}
		await env.CUPBOARD_DB.prepare(
			"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<?) INSERT INTO blob_ref_storage (tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation,nar_hash) SELECT ?,?,CASE WHEN ?='named' THEN 'private' ELSE NULL END,1,printf('%032d',value),3,'sha256:' || printf('%052d',value) FROM numbered"
		)
			.bind(count, tenant, kind, kind)
			.run();
	}
	await database.delete(schema.listingAdoptionCaptureEvent);
	await database
		.update(schema.listingAdoptionCaptureState)
		.set({ latest: listingAdoptionCaptureSequenceSchema.parse(0) });
	const sent: ListingAdoptionQueueMessage[] = [];
	const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
	const queue: Queue<ListingAdoptionQueueMessage> = {
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
	const dependencies = { database: env.CUPBOARD_DB, queue };
	const consumer = () => new ListingAdoptionQueue(dependencies);
	return { database, sent, queue, consumer };
}
async function progress(
	database: Awaited<ReturnType<typeof fixture>>['database']
) {
	const facts = await database
		.select({
			scanned: schema.listingAdoptionFactSeed.scanned,
			captured: schema.listingAdoptionFactSeed.captured,
			isComplete: schema.listingAdoptionFactSeed.isComplete
		})
		.from(schema.listingAdoptionFactSeed);
	const parents = await database
		.select({
			kind: schema.listingAdoptionParentSeed.cacheKind,
			scanned: schema.listingAdoptionParentSeed.scanned,
			captured: schema.listingAdoptionParentSeed.captured,
			isComplete: schema.listingAdoptionParentSeed.isComplete
		})
		.from(schema.listingAdoptionParentSeed)
		.orderBy(asc(schema.listingAdoptionParentSeed.cacheKind));
	const dispatch = await database
		.select({
			scope: schema.listingAdoptionSeedDispatch.scope,
			generation: schema.listingAdoptionSeedDispatch.generation,
			owner: schema.listingAdoptionSeedDispatch.owner
		})
		.from(schema.listingAdoptionSeedDispatch)
		.orderBy(asc(schema.listingAdoptionSeedDispatch.scope));
	return {
		facts,
		parents,
		dispatch: dispatch.map(({ owner, ...row }) => ({
			...row,
			owner: owner ?? undefined
		}))
	};
}

describe('listing adoption queue', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	it('reserves all scopes without granting execution ownership or depending on global job storage', async () => {
		const { database, sent, consumer } = await fixture();
		await consumer().start();
		await consumer().start();
		expect({ sent, progress: await progress(database) }).toStrictEqual({
			sent: scopes.map((scope) => ({ kind: 'listing-adoption-seed', scope })),
			progress: {
				facts: [],
				parents: [],
				dispatch: scopes.map((scope) => ({
					scope,
					generation: 0,
					owner: undefined
				}))
			}
		});
	});
	it('routes independent Worker hints with fresh scope claims and no payload reads', async () => {
		const { database, sent, queue, consumer } = await fixture();
		await consumer().start();
		const hints = sent.splice(0);
		const facts = vi.spyOn(ListingAdoptionFactSeedStore.prototype, 'advance');
		const parents = vi.spyOn(
			ListingAdoptionParentSeedStore.prototype,
			'advance'
		);
		const bytes = vi
			.spyOn(env.BLOBS, 'get')
			.mockRejectedValue(new Error('Unexpected payload read'));
		const actions: Action[] = [];
		await Promise.all(
			hints.map((hint) =>
				worker.queue(
					batch([transport(hint, actions)]),
					{
						...env,
						...testControlEnv,
						ARTIFACT_QUEUE: queue
					},
					createExecutionContext()
				)
			)
		);
		const claims = [...facts.mock.calls, ...parents.mock.calls].map(
			([claim]) => claim
		);
		expect({
			actions,
			scopes: claims.map((claim) => claim.scope).toSorted(byCodeUnit),
			owners: new Set(claims.map((claim) => claim.owner)).size,
			bytes: bytes.mock.calls,
			progress: await progress(database),
			wakes: sent
		}).toStrictEqual({
			actions: scopes.map(() => ({ action: 'ack' })),
			scopes,
			owners: 3,
			bytes: [],
			progress: {
				facts: [{ scanned: 1, captured: 1, isComplete: true }],
				parents: ['default', 'named'].map((kind) => ({
					kind,
					scanned: 1,
					captured: 1,
					isComplete: true
				})),
				dispatch: scopes.map((scope) => ({
					scope,
					generation: 1,
					owner: undefined
				}))
			},
			wakes: scopes.map(() => ({ kind: 'listing-adoption-dispatch' }))
		});
	});
	it('continues fixed pages through generic dispatch without replaying committed progress', async () => {
		const { database, sent, consumer } = await fixture(65);
		const actions: Action[] = [];
		await consumer().start();
		for (let turn = 0; turn < 64; turn++) {
			const hint = sent.shift();
			if (hint === undefined) {
				break;
			}
			await consumer().handleMessage(transport(hint, actions));
		}
		expect({
			queued: sent,
			actions,
			progress: await progress(database)
		}).toStrictEqual({
			queued: [],
			actions: Array.from({ length: 18 }, () => ({ action: 'ack' })),
			progress: {
				facts: [{ scanned: 65, captured: 65, isComplete: true }],
				parents: ['default', 'named'].map((kind) => ({
					kind,
					scanned: 65,
					captured: 65,
					isComplete: true
				})),
				dispatch: scopes.map((scope) => ({
					scope,
					generation: 3,
					owner: undefined
				}))
			}
		});
	});
	it.each(['before delivery', 'after delivery'] as const)(
		'recovers a failure %s only after the persisted reservation deadline',
		async (phase) => {
			const { database, sent, queue, consumer } = await fixture();
			const original = queue.sendBatch.bind(queue);
			const failure = vi
				.spyOn(queue, 'sendBatch')
				.mockImplementationOnce(async (entries) => {
					if (phase === 'after delivery') {
						await original(entries);
					}
					throw new Error('Queue unavailable');
				});
			const initial =
				phase === 'after delivery'
					? scopes.map((scope) => ({ kind: 'listing-adoption-seed', scope }))
					: [];
			await expect(consumer().start()).rejects.toThrow('Queue unavailable');
			await consumer().start();
			expect(sent).toStrictEqual(initial);
			await database
				.update(schema.listingAdoptionSeedDispatch)
				.set({ availableAt: now });
			await consumer().start();
			expect({
				calls: failure.mock.calls.length,
				sent,
				progress: await progress(database)
			}).toStrictEqual({
				calls: 2,
				sent: [
					...initial,
					...scopes.map((scope) => ({ kind: 'listing-adoption-seed', scope }))
				],
				progress: {
					facts: [],
					parents: [],
					dispatch: scopes.map((scope) => ({
						scope,
						generation: 0,
						owner: undefined
					}))
				}
			});
		}
	);
	it('preserves a committed page when its wake send fails', async () => {
		const { database, sent, queue, consumer } = await fixture(65);
		await consumer().start();
		sent.length = 0;
		vi.spyOn(queue, 'send').mockRejectedValueOnce(
			new Error('Wake unavailable')
		);
		const actions: Action[] = [];
		const hint = { kind: 'listing-adoption-seed', scope: 'facts' } as const;
		await consumer().handleMessage(transport(hint, actions));
		await consumer().handleMessage(transport(hint, actions));
		const snapshot = await progress(database);
		expect({
			actions,
			facts: snapshot.facts,
			sent
		}).toStrictEqual({
			actions: [{ action: 'retry', delaySeconds: 60 }, { action: 'ack' }],
			facts: [{ scanned: 64, captured: 64, isComplete: false }],
			sent: [{ kind: 'listing-adoption-dispatch' }]
		});
	});
	it('recovers an abandoned execution through cron delivery without trusting an old owner', async () => {
		const { database, sent, consumer } = await fixture();
		await consumer().start();
		sent.length = 0;
		await database
			.update(schema.listingAdoptionSeedDispatch)
			.set({
				owner: sql`'00000000-0000-4000-8000-000000000001'`,
				generation: 1,
				leaseExpiresAt: now,
				availableAt: now
			})
			.where(eq(schema.listingAdoptionSeedDispatch.scope, 'facts'));
		await consumer().start();
		const actions: Action[] = [];
		const hint = sent.shift();
		expect(hint).toStrictEqual({
			kind: 'listing-adoption-seed',
			scope: 'facts'
		});
		await consumer().handleMessage(transport(hint, actions));
		const snapshot = await progress(database);
		expect({
			actions,
			facts: snapshot.facts,
			dispatch: snapshot.dispatch.find((row) => row.scope === 'facts')
		}).toStrictEqual({
			actions: [{ action: 'ack' }],
			facts: [{ scanned: 1, captured: 1, isComplete: true }],
			dispatch: { scope: 'facts', generation: 2, owner: undefined }
		});
	});
	it.each(['time', 'subrequests'] as const)(
		'retries before claiming when the %s allowance is exhausted',
		async (condition) => {
			const { database, consumer } = await fixture();
			const queue = consumer();
			const actions: Action[] = [];
			if (condition === 'time') {
				vi.useFakeTimers({ toFake: ['Date'] });
				vi.setSystemTime(Date.now() + 25_000);
			}
			await withSubrequestSlice(
				() =>
					queue.handleMessage(
						transport(
							{ kind: 'listing-adoption-seed', scope: 'facts' },
							actions
						)
					),
				{ subrequests: condition === 'subrequests' ? 17 : 50, reserve: 0 }
			);
			expect({ actions, progress: await progress(database) }).toStrictEqual({
				actions: [{ action: 'retry', delaySeconds: 60 }],
				progress: { facts: [], parents: [], dispatch: [] }
			});
		}
	);
	it.each([
		undefined,
		{ kind: 'listing-adoption-seed', scope: 'other' },
		{ kind: 'listing-adoption-seed', scope: 'facts', owner: 'injected' },
		{ kind: 'listing-adoption-dispatch', scope: 'facts' }
	])('rejects malformed hints without database access: %j', async (body) => {
		const { consumer, sent } = await fixture();
		const actions: Action[] = [];
		const access = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation(() => {
				throw new Error('Unexpected database access');
			});
		await consumer().handleMessage(transport(body, actions));
		expect({ actions, sent, calls: access.mock.calls }).toStrictEqual({
			actions: [{ action: 'ack' }],
			sent: [],
			calls: []
		});
	});
	it('recovers a failed seed through durable lease expiry after acknowledging a duplicate hint', async () => {
		const { database, consumer, sent } = await fixture();
		await consumer().start();
		sent.length = 0;
		vi.spyOn(
			ListingAdoptionFactSeedStore.prototype,
			'advance'
		).mockRejectedValueOnce(new Error('Seed storage unavailable'));
		const actions: Action[] = [];
		const hint = { kind: 'listing-adoption-seed', scope: 'facts' } as const;
		await consumer().handleMessage(transport(hint, actions));
		await consumer().handleMessage(transport(hint, actions));
		const before = await progress(database);
		await database
			.update(schema.listingAdoptionSeedDispatch)
			.set({ availableAt: now, leaseExpiresAt: now })
			.where(eq(schema.listingAdoptionSeedDispatch.scope, 'facts'));
		await consumer().start();
		const recovery = sent.shift();
		await consumer().handleMessage(transport(recovery, actions));
		const after = await progress(database);
		expect({
			actions,
			recovery,
			before: before.facts,
			owned:
				before.dispatch.find((row) => row.scope === 'facts')?.owner !==
				undefined,
			after: after.facts,
			scope: after.dispatch.find((row) => row.scope === 'facts')
		}).toStrictEqual({
			actions: [
				{ action: 'retry', delaySeconds: 60 },
				{ action: 'ack' },
				{ action: 'ack' }
			],
			recovery: hint,
			before: [],
			owned: true,
			after: [{ scanned: 1, captured: 1, isComplete: true }],
			scope: { scope: 'facts', generation: 2, owner: undefined }
		});
	});
	it.each([
		{
			id: 'listing-adoption-fact-seed',
			table: 'listing_adoption_fact_seed',
			scopes: ['default-parents', 'named-parents']
		},
		{
			id: 'listing-adoption-parent-seed',
			table: 'listing_adoption_parent_seed',
			scopes: ['facts']
		}
	] as const)(
		'keeps other scopes eligible before $id expansion',
		async (transition) => {
			const { database, consumer, sent } = await fixture();
			await database
				.delete(schema.deploymentTransition)
				.where(eq(schema.deploymentTransition.id, transition.id));
			const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
			vi.spyOn(env.CUPBOARD_DB, 'prepare').mockImplementation((query) => {
				if (query.includes('"' + transition.table + '"')) {
					throw new Error('Absent seed storage was prepared');
				}
				return original(query);
			});
			await consumer().start();
			expect(sent).toStrictEqual(
				transition.scopes.map((scope) => ({
					kind: 'listing-adoption-seed',
					scope
				}))
			);
		}
	);
	it('waits during paused capture and resumes all scopes after readiness returns', async () => {
		const { database, consumer, sent } = await fixture();
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ isReady: false });
		await consumer().start();
		const paused = sent.splice(0);
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ isReady: true });
		await consumer().start();
		expect({ paused, sent }).toStrictEqual({
			paused: [],
			sent: scopes.map((scope) => ({ kind: 'listing-adoption-seed', scope }))
		});
	});

	it('waits for dispatch expansion before preparing absent storage', async () => {
		const { database, consumer, sent } = await fixture();
		await database
			.delete(schema.deploymentTransition)
			.where(
				eq(schema.deploymentTransition.id, 'listing-adoption-seed-dispatch')
			);
		const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
		vi.spyOn(env.CUPBOARD_DB, 'prepare').mockImplementation((query) => {
			if (query.includes('"listing_adoption_seed_dispatch"')) {
				throw new Error('Absent dispatch storage was prepared');
			}
			return original(query);
		});
		await consumer().start();
		const actions: Action[] = [];
		await consumer().handleMessage(
			transport({ kind: 'listing-adoption-seed', scope: 'facts' }, actions)
		);
		expect({ sent, actions }).toStrictEqual({
			sent: [],
			actions: [{ action: 'ack' }]
		});
	});
	it('runs a full parent page within the admitted subrequest allowance', async () => {
		const { database, consumer } = await fixture(65);
		await consumer().start();
		const actions: Action[] = [];
		await withSubrequestSlice(
			() =>
				consumer().handleMessage(
					transport(
						{ kind: 'listing-adoption-seed', scope: 'named-parents' },
						actions
					)
				),
			{ subrequests: 18, reserve: 0 }
		);
		const snapshot = await progress(database);
		expect({
			actions,
			parents: snapshot.parents
		}).toStrictEqual({
			actions: [{ action: 'ack' }],
			parents: [{ kind: 'named', scanned: 32, captured: 32, isComplete: false }]
		});
	});
	it('dispatches adoption from the actual cron entrypoint', async () => {
		await resetTestServer();
		await initialise();
		const { consumer, sent, queue } = await fixture();
		await worker.scheduled(scheduledController(), {
			...env,
			...testControlEnv,
			ARTIFACT_QUEUE: queue
		});
		expect(sent).toStrictEqual(
			scopes.map((scope) => ({ kind: 'listing-adoption-seed', scope }))
		);
		await consumer().start();
		expect(sent).toStrictEqual(
			scopes.map((scope) => ({ kind: 'listing-adoption-seed', scope }))
		);
	});
	it.each(['maintenance', 'adoption'] as const)(
		'keeps cron dispatch independent when %s fails',
		async (phase) => {
			await resetTestServer();
			await initialise();
			const { queue, sent } = await fixture();
			const maintenance = vi.spyOn(env.MAINTENANCE_QUEUE, 'sendBatch');
			const adoption = vi.spyOn(queue, 'sendBatch');
			const failing = phase === 'maintenance' ? maintenance : adoption;
			failing.mockRejectedValueOnce(new Error('Dispatch unavailable'));
			await expect(
				worker.scheduled(scheduledController(), {
					...env,
					...testControlEnv,
					ARTIFACT_QUEUE: queue
				})
			).rejects.toBeInstanceOf(AggregateError);
			expect({
				sent,
				maintenanceAttempted: maintenance.mock.calls.length > 0,
				adoptionAttempted: adoption.mock.calls.length > 0
			}).toStrictEqual({
				sent:
					phase === 'maintenance'
						? scopes.map((scope) => ({ kind: 'listing-adoption-seed', scope }))
						: [],
				maintenanceAttempted: true,
				adoptionAttempted: true
			});
		}
	);

	it('routes a generic adoption dispatch through the Worker router', async () => {
		const { sent, queue } = await fixture();
		const actions: Action[] = [];
		await handleWorkerQueue(
			batch([transport({ kind: 'listing-adoption-dispatch' }, actions)]),
			{ ...env, ...testControlEnv, ARTIFACT_QUEUE: queue },
			new NarReadBufferPool()
		);
		expect({ actions, sent }).toStrictEqual({
			actions: [{ action: 'ack' }],
			sent: scopes.map((scope) => ({ kind: 'listing-adoption-seed', scope }))
		});
	});
});
