import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { listingGeneratorRevisionSchema } from '@cupboard/protocol/artifacts';
import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { listingAdoptionCaptureSequenceSchema } from '../blob/listing-adoption-capture.ts';
import {
	listingAdoptionTaskEpochSchema,
	listingAdoptionTaskIdSchema
} from '../blob/listing-adoption-tasks.ts';
import { listingAdoptionConsumerEpochSchema } from '../blob/listing-adoption-work.ts';
import {
	type ListingAdoptionOutcome,
	type NarListingAdoptionRequest
} from '../blob/nar-listing-adoption.ts';
import * as schema from '../db/d1-schema.ts';
import { ListingAdoptionConsumerStore } from '../db/listing-adoption-consumer.ts';
import { ListingAdoptionParentStore } from '../db/listing-adoption-parents.ts';
import { ListingAdoptionTaskStore } from '../db/listing-adoption-tasks.ts';
import { ListingFactStore } from '../db/listing-facts.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from '../db/shared-nar-discovery.test-support.ts';
import { withSubrequestSlice } from '../do/subrequest-slice.ts';

import { type ListingAdoptionWorkMessage } from './listing-adoption-work-message.ts';
import { ListingAdoptionWorkQueue } from './listing-adoption-work-queue.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const firstTenant = tenantIdSchema.parse('discovery-first');
const secondTenant = tenantIdSchema.parse('discovery-second');
const narHash = sharedNarSource(1).narHash;
const revision = listingGeneratorRevisionSchema.parse('history');
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
interface Action {
	readonly action: 'ack' | 'retry';
	readonly delaySeconds?: number;
}
function message(body: unknown, actions: Action[]): Message {
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
async function fixture(count = 3, tenantCount = 1) {
	const { database } = await sharedNarDiscoveryFixture(0);
	await database
		.insert(schema.deploymentTransition)
		.values(
			[
				'listing-adoption-capture',
				'listing-adoption-work',
				'listing-adoption-parents',
				'listing-adoption-tasks'
			].map((id) => ({ id, state: 'complete' as const, updatedAt: now }))
		);
	const tenants = Array.from({ length: tenantCount }, (_, index) =>
		index === 0
			? firstTenant
			: index === 1
				? secondTenant
				: tenantIdSchema.parse(`delivery-${index.toString()}`)
	);
	for (const tenant of tenants.slice(2)) {
		await database.insert(schema.tenant).values({
			id: tenant,
			status: 'active',
			ownerIssuer: 'https://issuer.example',
			ownerSubject: 'subject',
			ownerAudience: 'cupboard',
			configVersion: 1,
			createdAt: now
		});
	}
	for (const tenant of tenants) {
		await database.insert(schema.cacheLifecycle).values({
			tenant,
			cacheKind: 'default',
			generation: cacheGenerationSchema.parse(1),
			access: 'private',
			updatedAt: now
		});
	}
	for (let index = 1; index <= count; index++) {
		const tenant = tenants[(index - 1) % tenants.length];
		if (tenant === undefined) {
			throw new Error('Expected configured tenant');
		}
		const path = storePathHashSchema.parse(String(index).padStart(32, '0'));
		await database.insert(schema.blobReference).values({
			tenant,
			cacheKind: 'default',
			cacheGeneration: cacheGenerationSchema.parse(1),
			storePathHash: path,
			generation: narInfoGenerationSchema.parse(1),
			narHash
		});
		await new ListingAdoptionParentStore(database).refresh({
			tenant,
			cache: { kind: 'default' },
			storePathHashes: [path]
		});
	}
	await new ListingFactStore(database).record({
		narHash,
		generatorRevision: revision,
		format: 1,
		digest: sha256HexDigestSchema.parse('a'.repeat(64)),
		size: 10
	});
	await database.delete(schema.listingAdoptionCaptureEvent);
	await database.insert(schema.listingAdoptionCaptureEvent).values({
		source: {
			kind: 'listing',
			identity: { narHash, generatorRevision: revision }
		}
	});
	const sent: ListingAdoptionWorkMessage[] = [];
	const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
	const queue: Queue<ListingAdoptionWorkMessage> = {
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
	const rpc = vi.fn(
		(
			_tenant: TenantId,
			requests: readonly NarListingAdoptionRequest[]
		): Promise<readonly ListingAdoptionOutcome[]> =>
			Promise.resolve(requests.map(() => ({ kind: 'conflict' })))
	);
	const dependencies = {
		database: env.CUPBOARD_DB,
		queue,
		serverFor: (tenant: TenantId) => ({
			adoptNarListings: (requests: readonly NarListingAdoptionRequest[]) =>
				rpc(tenant, requests)
		})
	};
	const consumer = () => new ListingAdoptionWorkQueue(dependencies);
	const store = new ListingAdoptionTaskStore(database);
	const deliveries = async () => {
		await database.insert(schema.listingAdoptionWork).values({
			consumerEpoch: listingAdoptionConsumerEpochSchema.parse('1'.repeat(32)),
			eventId: listingAdoptionCaptureSequenceSchema.parse(1),
			source: {
				kind: 'listing',
				identity: { narHash, generatorRevision: revision }
			}
		});
		const root = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'expand'))
			.get();
		if (root === undefined) {
			throw new Error('Expected source work');
		}
		const result = await store.claim(root.id, owner);
		if (result.kind !== 'claimed') {
			throw new Error('Expected source claim');
		}
		await store.advance(result.claim);
		const rows = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'deliver'))
			.orderBy(asc(schema.listingAdoptionTask.id));
		return rows.map((row) => row.id);
	};
	return { database, queue, sent, rpc, consumer, store, deliveries };
}
async function state(
	database: Awaited<ReturnType<typeof fixture>>['database']
) {
	const rows = await database
		.select()
		.from(schema.listingAdoptionTask)
		.where(eq(schema.listingAdoptionTask.kind, 'deliver'));
	return rows
		.map((row) => ({
			source: row.source,
			done: row.completedAt !== null,
			leased: row.owner !== null,
			delayed: row.retryAt > row.updatedAt,
			outcome: row.outcome ?? undefined
		}))
		.toSorted((left, right) =>
			byCodeUnit(JSON.stringify(left.source), JSON.stringify(right.source))
		);
}
describe('listing adoption execution queue', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	it('consumes captured availability and dispatches source identities without ownership', async () => {
		const { database, sent, consumer } = await fixture();
		await consumer().start();
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-work-dispatch' }, actions)
		);
		const rows = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'expand'));
		expect(sent).toStrictEqual([
			{ kind: 'listing-adoption-work-dispatch' },
			...rows.map((row) => ({ kind: 'listing-adoption-expand', id: row.id }))
		]);
		expect(actions).toStrictEqual([{ action: 'ack' }]);
		expect(
			rows.map((row) => ({
				kind: row.kind,
				owner: row.owner ?? undefined,
				generation: row.generation
			}))
		).toStrictEqual([{ kind: 'expand', owner: undefined, generation: 0 }]);
	});
	it('uses the authoritative RPC once per tenant for independent captured targets', async () => {
		const { database, rpc, consumer, deliveries } = await fixture(3, 2);
		const ids = await deliveries();
		const before = await state(database);
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-deliver', ids }, actions)
		);
		const calls = rpc.mock.calls
			.map(([tenant, requests]) => ({
				tenant,
				paths: requests
					.map((request) => request.storePathHash)
					.toSorted(byCodeUnit)
			}))
			.toSorted((left, right) => byCodeUnit(left.tenant, right.tenant));
		expect({ actions, calls, states: await state(database) }).toStrictEqual({
			actions: [{ action: 'ack' }],
			calls: [
				{
					tenant: firstTenant,
					paths: [
						storePathHashSchema.parse('1'.padStart(32, '0')),
						storePathHashSchema.parse('3'.padStart(32, '0'))
					]
				},
				{
					tenant: secondTenant,
					paths: [storePathHashSchema.parse('2'.padStart(32, '0'))]
				}
			],
			states: before.map((row) => ({
				...row,
				done: true,
				outcome: { kind: 'conflict' }
			}))
		});
	});
	it.each([
		'unavailable',
		'over-quota',
		'bytes-missing',
		'fact-missing'
	] as const)(
		'defers %s without resetting completed siblings',
		async (outcome) => {
			const { database, rpc, consumer, deliveries } = await fixture(2);
			const ids = await deliveries();
			rpc.mockImplementation((_tenant, requests) =>
				Promise.resolve(
					requests.map((_, index) => ({
						kind: index === 0 ? outcome : 'conflict'
					}))
				)
			);
			const actions: Action[] = [];
			await consumer().handleMessage(
				message({ kind: 'listing-adoption-deliver', ids }, actions)
			);
			const rows = await state(database);
			expect(
				rows
					.map((row) => ({
						done: row.done,
						leased: row.leased,
						delayed: row.delayed,
						outcome: row.outcome
					}))
					.toSorted((left, right) => Number(left.done) - Number(right.done))
			).toStrictEqual([
				{
					done: false,
					leased: false,
					delayed: true,
					outcome: { kind: outcome }
				},
				{
					done: true,
					leased: false,
					delayed: false,
					outcome: { kind: 'conflict' }
				}
			]);
			expect(actions).toStrictEqual([{ action: 'ack' }]);
		}
	);
	it('ignores malformed delivery hints before database access', async () => {
		const { consumer } = await fixture();
		const actions: Action[] = [];
		const prepare = vi.spyOn(env.CUPBOARD_DB, 'prepare');
		await consumer().handleMessage(
			message(
				{ kind: 'listing-adoption-deliver', ids: [], owner: 'untrusted' },
				actions
			)
		);
		expect({ actions, queries: prepare.mock.calls }).toStrictEqual({
			actions: [{ action: 'ack' }],
			queries: []
		});
	});
	it('defers work when the invocation cannot afford a delivery batch', async () => {
		const { consumer, deliveries, rpc } = await fixture();
		const ids = await deliveries();
		const actions: Action[] = [];
		await withSubrequestSlice(
			() =>
				consumer().handleMessage(
					message({ kind: 'listing-adoption-deliver', ids }, actions)
				),
			{ subrequests: 1, reserve: 0 }
		);
		expect({ actions, rpc: rpc.mock.calls }).toStrictEqual({
			actions: [{ action: 'retry', delaySeconds: 60 }],
			rpc: []
		});
	});
	it.each([
		50,
		workersInvocationAllowances.free.subrequests,
		workersInvocationAllowances.paid.subrequests
	])(
		'admits eight independently grouped tenants within a %i-call slice',
		async (subrequests) => {
			const { database, rpc, consumer, deliveries } = await fixture(8, 8);
			const ids = await deliveries();
			const before = await state(database);
			const actions: Action[] = [];
			await withSubrequestSlice(
				() =>
					consumer().handleMessage(
						message({ kind: 'listing-adoption-deliver', ids }, actions)
					),
				{ subrequests, reserve: 8 }
			);
			expect({
				actions,
				calls: rpc.mock.calls.length,
				states: await state(database)
			}).toStrictEqual({
				actions: [{ action: 'ack' }],
				calls: 8,
				states: before.map((row) => ({
					...row,
					done: true,
					outcome: { kind: 'conflict' }
				}))
			});
		}
	);
	it('persists a fast tenant before an unrelated tenant completes', async () => {
		const { database, rpc, consumer, deliveries } = await fixture(2, 2);
		const ids = await deliveries();
		const slow = Promise.withResolvers<readonly ListingAdoptionOutcome[]>();
		const fastCommitted = Promise.withResolvers<undefined>();
		rpc.mockImplementation((tenant, requests) =>
			tenant === firstTenant
				? slow.promise
				: Promise.resolve(requests.map(() => ({ kind: 'conflict' })))
		);
		const storage = new ListingAdoptionTaskStore(database);
		const original = storage.resolveDeliveries.bind(storage);
		vi.spyOn(
			ListingAdoptionTaskStore.prototype,
			'resolveDeliveries'
		).mockImplementation(async (resolutions) => {
			const result = await original(resolutions);
			fastCommitted.resolve(undefined);
			return result;
		});
		const actions: Action[] = [];
		const processing = consumer().handleMessage(
			message({ kind: 'listing-adoption-deliver', ids }, actions)
		);
		try {
			await fastCommitted.promise;
			const rows = await state(database);
			expect(
				rows
					.map((row) => ({
						tenant:
							row.source.kind === 'deliver'
								? row.source.target.parent.tenant
								: undefined,
						done: row.done,
						leased: row.leased
					}))
					.toSorted((left, right) =>
						byCodeUnit(left.tenant ?? '', right.tenant ?? '')
					)
			).toStrictEqual([
				{ tenant: firstTenant, done: false, leased: true },
				{ tenant: secondTenant, done: true, leased: false }
			]);
			expect(actions).toStrictEqual([]);
		} finally {
			slow.resolve([{ kind: 'conflict' }]);
			await processing;
		}
		expect(actions).toStrictEqual([{ action: 'ack' }]);
	});
	it('retries one failed tenant after durably finishing its valid peer', async () => {
		const { database, rpc, consumer, deliveries } = await fixture(2, 2);
		const ids = await deliveries();
		rpc.mockImplementation((tenant, requests) =>
			tenant === firstTenant
				? Promise.reject(new Error('Tenant unavailable'))
				: Promise.resolve(requests.map(() => ({ kind: 'conflict' })))
		);
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-deliver', ids }, actions)
		);
		const snapshot = await state(database);
		expect({
			actions,
			states: snapshot
				.map((row) => ({
					tenant:
						row.source.kind === 'deliver'
							? row.source.target.parent.tenant
							: undefined,
					done: row.done,
					leased: row.leased,
					delayed: row.delayed,
					outcome: row.outcome
				}))
				.toSorted((left, right) =>
					byCodeUnit(left.tenant ?? '', right.tenant ?? '')
				)
		}).toStrictEqual({
			actions: [{ action: 'retry', delaySeconds: 60 }],
			states: [
				{
					tenant: firstTenant,
					done: false,
					leased: false,
					delayed: true,
					outcome: { kind: 'rpc-failed' }
				},
				{
					tenant: secondTenant,
					done: true,
					leased: false,
					delayed: false,
					outcome: { kind: 'conflict' }
				}
			]
		});
	});
	it('never lets an old RPC response overwrite a replacement execution epoch', async () => {
		const { database, rpc, consumer, deliveries } = await fixture(1);
		const ids = await deliveries();
		let replacement: (typeof schema.listingAdoptionTask.$inferSelect)[] = [];
		rpc.mockImplementation(async (_tenant, requests) => {
			await database
				.update(schema.listingAdoptionTask)
				.set({ epoch: listingAdoptionTaskEpochSchema.parse('2'.repeat(32)) })
				.where(eq(schema.listingAdoptionTask.kind, 'deliver'));
			replacement = await database
				.select()
				.from(schema.listingAdoptionTask)
				.where(eq(schema.listingAdoptionTask.kind, 'deliver'));
			return requests.map(() => ({ kind: 'conflict' }));
		});
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-deliver', ids }, actions)
		);
		expect(
			await database
				.select()
				.from(schema.listingAdoptionTask)
				.where(eq(schema.listingAdoptionTask.kind, 'deliver'))
		).toStrictEqual(replacement);
		expect(actions).toStrictEqual([{ action: 'ack' }]);
	});
	it.each([
		'deleted',
		'publication-generation',
		'cache-generation',
		'nar'
	] as const)(
		'retires an obsolete %s parent without asking its tenant to publish',
		async (condition) => {
			const { database, rpc, consumer, deliveries } = await fixture(1);
			const ids = await deliveries();
			const before = await state(database);
			switch (condition) {
				case 'deleted': {
					await database.delete(schema.listingAdoptionParent);
					break;
				}
				case 'publication-generation': {
					await database
						.update(schema.listingAdoptionParent)
						.set({ generation: narInfoGenerationSchema.parse(2) });
					break;
				}
				case 'cache-generation': {
					await database
						.update(schema.listingAdoptionParent)
						.set({ cacheGeneration: cacheGenerationSchema.parse(2) });
					break;
				}
				case 'nar': {
					await database
						.update(schema.listingAdoptionParent)
						.set({ narHash: sharedNarSource(2).narHash });
					break;
				}
			}
			const actions: Action[] = [];
			await consumer().handleMessage(
				message({ kind: 'listing-adoption-deliver', ids }, actions)
			);
			expect({
				actions,
				rpc: rpc.mock.calls,
				states: await state(database)
			}).toStrictEqual({
				actions: [{ action: 'ack' }],
				rpc: [],
				states: before.map((row) => ({
					...row,
					done: true,
					outcome: { kind: 'obsolete' }
				}))
			});
		}
	);
	it('treats an incomplete RPC response as a retry for every captured item', async () => {
		const { database, rpc, consumer, deliveries } = await fixture(2);
		const ids = await deliveries();
		const before = await state(database);
		rpc.mockResolvedValueOnce([{ kind: 'conflict' }]);
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-deliver', ids }, actions)
		);
		expect({ actions, states: await state(database) }).toStrictEqual({
			actions: [{ action: 'retry', delaySeconds: 60 }],
			states: before.map((row) => ({
				...row,
				delayed: true,
				outcome: { kind: 'rpc-failed' }
			}))
		});
	});
	it('uses a short durable delay for native RPC capacity refusals', async () => {
		const { database, rpc, consumer, deliveries } = await fixture(1);
		const ids = await deliveries();
		rpc.mockResolvedValueOnce([{ kind: 'capacity' }]);
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-deliver', ids }, actions)
		);
		const delay = await database
			.select({
				seconds: sql<number>`cast(round((julianday(${schema.listingAdoptionTask.retryAt})-julianday(${schema.listingAdoptionTask.updatedAt}))*86400) as integer)`
			})
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'deliver'));
		expect({ actions, delay }).toStrictEqual({
			actions: [{ action: 'ack' }],
			delay: [{ seconds: 1 }]
		});
	});
	it('recovers a failed task send through the persisted reservation deadline', async () => {
		const { database, queue, consumer, sent } = await fixture(1);
		const actions: Action[] = [];
		vi.spyOn(queue, 'sendBatch').mockRejectedValueOnce(
			new Error('Queue unavailable')
		);
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-work-dispatch' }, actions)
		);
		expect({ actions, sent }).toStrictEqual({
			actions: [{ action: 'retry', delaySeconds: 60 }],
			sent: []
		});
		const root = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'expand'))
			.get();
		if (root === undefined) {
			throw new Error('Expected durable reserved source task');
		}
		await database
			.update(schema.listingAdoptionTask)
			.set({ availableAt: now })
			.where(eq(schema.listingAdoptionTask.id, root.id));
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-work-dispatch' }, actions)
		);
		expect({ actions, sent }).toStrictEqual({
			actions: [{ action: 'retry', delaySeconds: 60 }, { action: 'ack' }],
			sent: [{ kind: 'listing-adoption-expand', id: root.id }]
		});
	});
	it('runs source hints through bounded expansion and dispatches their durable targets', async () => {
		const { database, consumer, sent } = await fixture(3);
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-work-dispatch' }, actions)
		);
		const root = sent.shift();
		if (root?.kind !== 'listing-adoption-expand') {
			throw new Error('Expected expansion hint');
		}
		await consumer().handleMessage(message(root, actions));
		const wake = sent.shift();
		if (wake === undefined) {
			throw new Error('Expected dispatch wake');
		}
		await consumer().handleMessage(message(wake, actions));
		const rows = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'deliver'))
			.orderBy(asc(schema.listingAdoptionTask.id));
		expect({ actions, sent }).toStrictEqual({
			actions: [{ action: 'ack' }, { action: 'ack' }, { action: 'ack' }],
			sent: [
				{ kind: 'listing-adoption-deliver', ids: rows.map((row) => row.id) }
			]
		});
	});
	it('acknowledges duplicate delivery hints without repeating completed RPC work', async () => {
		const { rpc, consumer, deliveries } = await fixture(1);
		const ids = await deliveries();
		const actions: Action[] = [];
		const hint = { kind: 'listing-adoption-deliver', ids };
		await consumer().handleMessage(message(hint, actions));
		await consumer().handleMessage(message(hint, actions));
		expect({ actions, calls: rpc.mock.calls.length }).toStrictEqual({
			actions: [{ action: 'ack' }, { action: 'ack' }],
			calls: 1
		});
	});
	it('ignores an expansion hint for a delivery without changing its execution', async () => {
		const { database, consumer, deliveries, rpc } = await fixture(1);
		const ids = await deliveries();
		const id = ids[0];
		if (id === undefined) {
			throw new Error('Expected delivery');
		}
		const before = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.id, id));
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-expand', id }, actions)
		);
		expect({
			actions,
			rpc: rpc.mock.calls,
			rows: await database
				.select()
				.from(schema.listingAdoptionTask)
				.where(eq(schema.listingAdoptionTask.id, id))
		}).toStrictEqual({ actions: [{ action: 'ack' }], rpc: [], rows: before });
	});
	it('schedules capacity retries at their durable deadline without waiting for cron', async () => {
		const { queue, rpc, consumer, deliveries } = await fixture(1);
		const ids = await deliveries();
		rpc.mockResolvedValueOnce([{ kind: 'capacity' }]);
		const send = vi.spyOn(queue, 'send');
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-deliver', ids }, actions)
		);
		expect({ actions, sends: send.mock.calls }).toStrictEqual({
			actions: [{ action: 'ack' }],
			sends: [[{ kind: 'listing-adoption-deliver', ids }, { delaySeconds: 1 }]]
		});
	});
	it('schedules paused expansion at its durable retry deadline', async () => {
		const { database, queue, consumer, sent } = await fixture(1);
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-work-dispatch' }, actions)
		);
		const hint = sent.shift();
		if (hint?.kind !== 'listing-adoption-expand') {
			throw new Error('Expected source hint');
		}
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ isReady: false });
		const send = vi.spyOn(queue, 'send');
		await consumer().handleMessage(message(hint, actions));
		expect(send.mock.calls).toStrictEqual([
			[hint, { delaySeconds: 60 }],
			[{ kind: 'listing-adoption-work-dispatch' }]
		]);
		const row = await database
			.select({
				leased: sql<number>`${schema.listingAdoptionTask.owner} IS NOT NULL`,
				done: sql<number>`${schema.listingAdoptionTask.completedAt} IS NOT NULL`
			})
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.id, hint.id));
		expect({ actions, row }).toStrictEqual({
			actions: [{ action: 'ack' }, { action: 'ack' }],
			row: [{ leased: 0, done: 0 }]
		});
	});
	it('recovers a lost continuation send after source progress has committed', async () => {
		const { database, queue, consumer, sent } = await fixture(2);
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-work-dispatch' }, actions)
		);
		const hint = sent.shift();
		if (hint?.kind !== 'listing-adoption-expand') {
			throw new Error('Expected source hint');
		}
		vi.spyOn(queue, 'send').mockRejectedValueOnce(
			new Error('Wake unavailable')
		);
		await consumer().handleMessage(message(hint, actions));
		await consumer().handleMessage(message(hint, actions));
		const wake = sent.shift();
		if (wake === undefined) {
			throw new Error('Expected recovered generic wake');
		}
		await consumer().handleMessage(message(wake, actions));
		const state = await database
			.select({
				scanned: schema.listingAdoptionTask.scanned,
				enrolled: schema.listingAdoptionTask.enrolled,
				generation: schema.listingAdoptionTask.generation
			})
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.id, hint.id));
		expect({
			actions,
			state,
			kinds: sent.map((item) => item.kind)
		}).toStrictEqual({
			actions: [
				{ action: 'ack' },
				{ action: 'retry', delaySeconds: 60 },
				{ action: 'ack' },
				{ action: 'ack' }
			],
			state: [{ scanned: 2, enrolled: 2, generation: 1 }],
			kinds: ['listing-adoption-deliver']
		});
	});
	it('dispatches already enrolled targets even when capture consumption fails', async () => {
		const { consumer, deliveries, sent } = await fixture(1);
		const ids = await deliveries();
		vi.spyOn(
			ListingAdoptionConsumerStore.prototype,
			'advance'
		).mockRejectedValueOnce(new Error('Capture unavailable'));
		const actions: Action[] = [];
		await consumer().handleMessage(
			message({ kind: 'listing-adoption-work-dispatch' }, actions)
		);
		expect({ actions, sent }).toStrictEqual({
			actions: [{ action: 'retry', delaySeconds: 60 }],
			sent: [{ kind: 'listing-adoption-deliver', ids }]
		});
	});
	it('drains a multi-page source through independent eight-target delivery batches', async () => {
		const { database, consumer, sent, rpc } = await fixture(65);
		await consumer().start();
		const actions: Action[] = [];
		for (let turn = 0; turn < 256; turn++) {
			const hint = sent.shift();
			if (hint === undefined) {
				break;
			}
			await withSubrequestSlice(
				() => consumer().handleMessage(message(hint, actions)),
				{ subrequests: 50, reserve: 8 }
			);
		}
		const roots = await database
			.select({
				scanned: schema.listingAdoptionTask.scanned,
				enrolled: schema.listingAdoptionTask.enrolled,
				done: sql<number>`${schema.listingAdoptionTask.completedAt} IS NOT NULL`
			})
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'expand'));
		const targets = await state(database);
		expect({
			queued: sent,
			roots,
			targets: targets.map((row) => ({
				done: row.done,
				leased: row.leased,
				outcome: row.outcome
			})),
			paths: rpc.mock.calls
				.flatMap(([, requests]) =>
					requests.map((request) => request.storePathHash)
				)
				.toSorted(byCodeUnit)
		}).toStrictEqual({
			queued: [],
			roots: [{ scanned: 65, enrolled: 65, done: 1 }],
			targets: Array.from({ length: 65 }, () => ({
				done: true,
				leased: false,
				outcome: { kind: 'conflict' }
			})),
			paths: Array.from({ length: 65 }, (_, index) =>
				storePathHashSchema.parse(String(index + 1).padStart(32, '0'))
			)
		});
		expect(
			Math.max(...rpc.mock.calls.map(([, requests]) => requests.length))
		).toBeLessThanOrEqual(8);
	});
	it('bounds claimed delivery preparation across 25,000 unrelated pending targets', async () => {
		const { deliveries } = await fixture(8);
		const ids = await deliveries();
		await env.CUPBOARD_DB.prepare(
			"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<25000) INSERT INTO listing_adoption_task(id,kind,parent_id,generator_revision,source,available_at,retry_at) SELECT printf('%032x',value+1000000),'deliver',printf('%032x',value+1000000),?,json_object('kind','deliver','target',json_object('parent',json_object('id',printf('%032x',value+1000000),'tenant',?,'cache',json_object('kind','default'),'cacheGeneration',1,'storePathHash',printf('%032d',value+1000000),'generation',1,'narHash',?,'updatedAt',?),'identity',json_object('narHash',?,'generatorRevision',?))),'2999-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z' FROM numbered"
		)
			.bind(revision, firstTenant, narHash, now, narHash, revision)
			.run();
		const statements: { query: string; parameters: unknown[] }[] = [];
		const database = drizzle(env.CUPBOARD_DB, {
			schema,
			logger: {
				logQuery(query, parameters) {
					statements.push({ query, parameters });
				}
			}
		});
		const store = new ListingAdoptionTaskStore(database);
		const claimed = await store.claimDeliveries(ids, owner);
		if (claimed.kind !== 'claimed') {
			throw new Error('Expected delivery claims');
		}
		statements.length = 0;
		const prepared = await store.prepareDeliveries(claimed.claims);
		if (prepared.kind !== 'ready') {
			throw new Error('Expected prepared targets');
		}
		let reads = 0;
		for (const statement of statements) {
			const parameters = z
				.array(z.union([z.string(), z.number()]))
				.parse(statement.parameters);
			const result = await env.CUPBOARD_DB.prepare(statement.query)
				.bind(...parameters)
				.all();
			reads += result.meta.rows_read;
			expect(parameters.length).toBeLessThanOrEqual(100);
			expect(statement.query.length).toBeLessThanOrEqual(100_000);
		}
		expect({
			ids: prepared.deliveries
				.map((item) => item.claim.id)
				.toSorted(byCodeUnit),
			obsolete: prepared.obsolete
		}).toStrictEqual({ ids, obsolete: [] });
		expect(reads).toBeLessThanOrEqual(256);
	});
	it('returns deterministic hint identities after oldest-first selection', async () => {
		const { database, deliveries, store } = await fixture(3);
		await deliveries();
		const rows = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'deliver'));
		await database.delete(schema.listingAdoptionTask);
		const ids = [3, 1, 2].map((index) =>
			listingAdoptionTaskIdSchema.parse(index.toString().padStart(32, '0'))
		);
		for (const [index, row] of rows.entries()) {
			const id = ids[index];
			if (id === undefined) {
				throw new Error('Expected stable fixture identity');
			}
			await database.insert(schema.listingAdoptionTask).values({ ...row, id });
		}
		expect(await store.reserveWork()).toStrictEqual(
			ids.toSorted(byCodeUnit).map((id) => ({ id, kind: 'deliver' }))
		);
	});
	it('fences a delivery acknowledgement after the captured lease expires in storage time', async () => {
		const { database, rpc, consumer, deliveries } = await fixture(1);
		const ids = await deliveries();
		let before: (typeof schema.listingAdoptionTask.$inferSelect)[] = [];
		let hasReply = false;
		let didAdvanceClock = false;
		rpc.mockImplementation(async (_tenant, requests) => {
			before = await database
				.select()
				.from(schema.listingAdoptionTask)
				.where(eq(schema.listingAdoptionTask.kind, 'deliver'));
			hasReply = true;
			return requests.map(() => ({ kind: 'conflict' }));
		});
		const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
		const prepare = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation((query) => {
				if (
					hasReply &&
					query.includes('update "listing_adoption_task"') &&
					query.includes('"completed_at"')
				) {
					didAdvanceClock = true;
					return original(
						query.replaceAll(
							"strftime('%Y-%m-%dT%H:%M:%fZ','now')",
							"'2999-01-01T00:00:00.000Z'"
						)
					);
				}
				return original(query);
			});
		const actions: Action[] = [];
		try {
			await consumer().handleMessage(
				message({ kind: 'listing-adoption-deliver', ids }, actions)
			);
		} finally {
			prepare.mockRestore();
		}
		const after = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'deliver'));
		expect({ actions, didAdvanceClock, rows: after }).toStrictEqual({
			actions: [{ action: 'ack' }],
			didAdvanceClock: true,
			rows: before
		});
	});
	it('isolates retry targets after a whole tenant RPC fails', async () => {
		const { database, rpc, consumer, deliveries } = await fixture(2);
		const ids = await deliveries();
		const badPath = storePathHashSchema.parse('1'.padStart(32, '0'));
		rpc.mockImplementation((_tenant, requests) =>
			requests.some((request) => request.storePathHash === badPath)
				? Promise.reject(new Error('One target fails before an RPC outcome'))
				: Promise.resolve(requests.map(() => ({ kind: 'conflict' })))
		);
		const actions: Action[] = [];
		const hint = { kind: 'listing-adoption-deliver', ids };
		await consumer().handleMessage(message(hint, actions));
		await database
			.update(schema.listingAdoptionTask)
			.set({ retryAt: now, availableAt: now })
			.where(eq(schema.listingAdoptionTask.kind, 'deliver'));
		await consumer().handleMessage(message(hint, actions));
		const rows = await state(database);
		expect({
			actions,
			batches: rpc.mock.calls.map(([, requests]) => requests.length),
			states: rows
				.map((row) => ({
					path:
						row.source.kind === 'deliver'
							? row.source.target.parent.storePathHash
							: undefined,
					done: row.done,
					delayed: row.delayed,
					outcome: row.outcome
				}))
				.toSorted((left, right) =>
					byCodeUnit(left.path ?? '', right.path ?? '')
				)
		}).toStrictEqual({
			actions: [
				{ action: 'retry', delaySeconds: 60 },
				{ action: 'retry', delaySeconds: 60 }
			],
			batches: [2, 1, 1],
			states: [
				{
					path: badPath,
					done: false,
					delayed: true,
					outcome: { kind: 'rpc-failed' }
				},
				{
					path: storePathHashSchema.parse('2'.padStart(32, '0')),
					done: true,
					delayed: false,
					outcome: { kind: 'conflict' }
				}
			]
		});
	});
});
