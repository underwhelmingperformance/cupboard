import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { listingGeneratorRevisionSchema } from '@cupboard/protocol/artifacts';
import { type TransitionId } from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { asc, eq, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import { listingAdoptionCaptureSequenceSchema } from '../blob/listing-adoption-capture.ts';
import {
	type ListingAdoptionSeedClaim,
	listingAdoptionSeedScopes
} from '../blob/listing-adoption-seed-dispatch.ts';
import { listingAdoptionConsumerEpochSchema } from '../blob/listing-adoption-work.ts';
import { boundedD1 } from '../do/bounded-io.ts';
import { withSubrequestSlice } from '../do/subrequest-slice.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { ListingAdoptionConsumerStore } from './listing-adoption-consumer.ts';
import { ListingAdoptionFactSeedStore } from './listing-adoption-fact-seed.ts';
import { ListingAdoptionParentSeedStore } from './listing-adoption-parent-seed.ts';
import {
	type ListingAdoptionRecoveryResult,
	ListingAdoptionRecoveryStore
} from './listing-adoption-recovery.ts';
import { ListingAdoptionSeedDispatchStore } from './listing-adoption-seed-dispatch.ts';
import { sharedNarSource } from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const required: readonly TransitionId[] = [
	'listing-adoption-capture',
	'listing-adoption-work',
	'listing-adoption-fact-seed',
	'listing-adoption-parents',
	'listing-adoption-parent-seed',
	'listing-adoption-seed-dispatch',
	'listing-adoption-tasks'
];
const source = {
	kind: 'listing' as const,
	identity: {
		narHash: sharedNarSource(1).narHash,
		generatorRevision: listingGeneratorRevisionSchema.parse('history')
	}
};
async function fixture() {
	const database = drizzle(env.CUPBOARD_DB, { schema });
	await database
		.insert(schema.deploymentTransition)
		.values(
			required.map((id) => ({ id, state: 'complete' as const, updatedAt: now }))
		);
	await database.insert(schema.listingAdoptionCaptureEvent).values({ source });
	await new ListingAdoptionConsumerStore(database).advance();
	await database
		.insert(schema.listingAdoptionCaptureEvent)
		.values([{ source }, { source }]);
	const events = await database
		.select()
		.from(schema.listingAdoptionCaptureEvent)
		.orderBy(asc(schema.listingAdoptionCaptureEvent.id));
	const floor = events[1]?.id;
	const latest = events[2]?.id;
	if (floor === undefined || latest === undefined) {
		throw new Error('The recovery fixture needs three capture events');
	}
	await database
		.delete(schema.listingAdoptionCaptureEvent)
		.where(lte(schema.listingAdoptionCaptureEvent.id, floor));
	await database
		.update(schema.listingAdoptionCaptureState)
		.set({ prunedThrough: floor });
	const dispatch = new ListingAdoptionSeedDispatchStore(database);
	await dispatch.reserve();
	const claims = await Array.fromAsync(
		listingAdoptionSeedScopes,
		async (scope): Promise<ListingAdoptionSeedClaim> => {
			const result = await dispatch.claim(scope, owner);
			if (result.kind !== 'claimed') {
				throw new Error('The historical seed was not claimed');
			}
			return result.claim;
		}
	);
	await database
		.insert(schema.listingAdoptionFactSeed)
		.values({ id: 1, isComplete: true });
	await database.insert(schema.listingAdoptionParentSeed).values([
		{ cacheKind: 'default', isComplete: true },
		{ cacheKind: 'named', isComplete: true }
	]);
	return {
		database,
		events,
		floor,
		latest,
		claims,
		dispatch,
		store: new ListingAdoptionRecoveryStore(database)
	};
}
async function snapshot(
	database: Awaited<ReturnType<typeof fixture>>['database']
) {
	return {
		consumer: await database
			.select({
				id: schema.listingAdoptionConsumer.id,
				epoch: schema.listingAdoptionConsumer.epoch,
				after: schema.listingAdoptionConsumer.after,
				scanned: schema.listingAdoptionConsumer.scanned,
				enrolled: schema.listingAdoptionConsumer.enrolled
			})
			.from(schema.listingAdoptionConsumer),
		position: await database.select().from(schema.listingAdoptionCaptureState),
		facts: await database.select().from(schema.listingAdoptionFactSeed),
		parents: await database
			.select()
			.from(schema.listingAdoptionParentSeed)
			.orderBy(asc(schema.listingAdoptionParentSeed.cacheKind)),
		dispatch: await database
			.select()
			.from(schema.listingAdoptionSeedDispatch)
			.orderBy(asc(schema.listingAdoptionSeedDispatch.scope)),
		work: await database
			.select()
			.from(schema.listingAdoptionWork)
			.orderBy(asc(schema.listingAdoptionWork.id)),
		tasks: await database
			.select()
			.from(schema.listingAdoptionTask)
			.orderBy(asc(schema.listingAdoptionTask.id))
	};
}

describe('listing adoption expired-prefix recovery', () => {
	it.each(['expired', 'missing'] as const)(
		'restarts historical seeds at a fresh barrier when the consumer is %s without deleting durable work',
		async (state) => {
			const { database, latest, store } = await fixture();
			if (state === 'missing') {
				await database.delete(schema.listingAdoptionConsumer);
			}
			const before = await snapshot(database);
			const result = await store.recover();
			if (result.kind !== 'recovered') {
				throw new Error('The expired consumer did not recover');
			}
			const previous = before.consumer[0];
			expect({
				result,
				state: await snapshot(database),
				rotated: result.epoch !== previous?.epoch
			}).toStrictEqual({
				result: { kind: 'recovered', after: latest, epoch: result.epoch },
				state: {
					...before,
					consumer: [
						{
							id: 1,
							epoch: result.epoch,
							after: latest,
							scanned: previous?.scanned ?? 0,
							enrolled: previous?.enrolled ?? 0
						}
					],
					facts: [],
					parents: [],
					dispatch: []
				},
				rotated: true
			});
		}
	);
	it('leaves a non-expired consumer and existing seed claims unchanged', async () => {
		const { database, store } = await fixture();
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ prunedThrough: listingAdoptionCaptureSequenceSchema.parse(0) });
		const before = await snapshot(database);
		expect({
			result: await store.recover(),
			state: await snapshot(database)
		}).toStrictEqual({ result: { kind: 'idle' }, state: before });
	});
	it.each(required)(
		'waits for %s before preparing recovery tables',
		async (id) => {
			const { database, store } = await fixture();
			await database
				.update(schema.deploymentTransition)
				.set({ state: 'expanded' })
				.where(eq(schema.deploymentTransition.id, id));
			const before = await snapshot(database);
			const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
			const queries: string[] = [];
			const prepared = vi
				.spyOn(env.CUPBOARD_DB, 'prepare')
				.mockImplementation((query) => {
					queries.push(query);
					return original(query);
				});
			let result: ListingAdoptionRecoveryResult;
			try {
				result = await store.recover();
			} finally {
				prepared.mockRestore();
			}
			expect({
				result,
				onlyReadiness:
					queries.length > 0 &&
					queries.every((query) => query.includes('deployment_transition')),
				state: await snapshot(database)
			}).toStrictEqual({
				result: { kind: 'unavailable' },
				onlyReadiness: true,
				state: before
			});
		}
	);
	it.each(['epoch', 'cursor', 'floor', 'readiness', 'storage'] as const)(
		'rejects a selected recovery after its %s changes',
		async (change) => {
			const { database, latest, store } = await fixture();
			const before = await snapshot(database);
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			let changed = before;
			const delayed = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (queries) => {
					switch (change) {
						case 'epoch': {
							await database.update(schema.listingAdoptionConsumer).set({
								epoch: listingAdoptionConsumerEpochSchema.parse('c'.repeat(32))
							});
							break;
						}
						case 'cursor': {
							await database
								.update(schema.listingAdoptionConsumer)
								.set({ after: latest });
							break;
						}
						case 'floor': {
							await database
								.update(schema.listingAdoptionCaptureState)
								.set({ prunedThrough: latest });
							break;
						}
						case 'storage': {
							await database
								.update(schema.deploymentTransition)
								.set({ state: 'expanded' })
								.where(
									eq(
										schema.deploymentTransition.id,
										'listing-adoption-fact-seed'
									)
								);
							break;
						}
						case 'readiness': {
							await database
								.update(schema.listingAdoptionCaptureState)
								.set({ isReady: false });
							break;
						}
					}
					changed = await snapshot(database);
					return original(queries);
				});
			let result: ListingAdoptionRecoveryResult;
			try {
				result = await store.recover();
			} finally {
				delayed.mockRestore();
			}
			expect({ result, state: await snapshot(database) }).toStrictEqual({
				result: { kind: 'stale' },
				state: changed
			});
		}
	);
	it('rejects recovery if another consumer appears before the reset commits', async () => {
		const { database, store } = await fixture();
		await database.delete(schema.listingAdoptionConsumer);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let current = await snapshot(database);
		const delayed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database.insert(schema.listingAdoptionConsumer).values({ id: 1 });
				current = await snapshot(database);
				return original(queries);
			});
		let result: ListingAdoptionRecoveryResult;
		try {
			result = await store.recover();
		} finally {
			delayed.mockRestore();
		}
		expect({ result, state: await snapshot(database) }).toStrictEqual({
			result: { kind: 'stale' },
			state: current
		});
	});
	it('preserves captures appended after the recovery barrier', async () => {
		const { database, events: originalEvents, latest, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const delayed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database
					.insert(schema.listingAdoptionCaptureEvent)
					.values({ source });
				return original(queries);
			});
		let recovered: ListingAdoptionRecoveryResult;
		try {
			recovered = await store.recover();
		} finally {
			delayed.mockRestore();
		}
		if (recovered.kind !== 'recovered') {
			throw new Error('The expired consumer did not recover');
		}
		const events = await database
			.select()
			.from(schema.listingAdoptionCaptureEvent)
			.orderBy(asc(schema.listingAdoptionCaptureEvent.id));
		expect({
			recovered,
			continued: await new ListingAdoptionConsumerStore(database).advance(),
			work: await database
				.select({ eventId: schema.listingAdoptionWork.eventId })
				.from(schema.listingAdoptionWork)
				.orderBy(asc(schema.listingAdoptionWork.eventId))
		}).toStrictEqual({
			recovered: { kind: 'recovered', after: latest, epoch: recovered.epoch },
			continued: {
				kind: 'advanced',
				scanned: 1,
				enrolled: 1,
				after: events.at(-1)?.id,
				hasMore: false
			},
			work: [{ eventId: originalEvents[0]?.id }, { eventId: events.at(-1)?.id }]
		});
	});
	it('allows only one overlapping recovery to reset the seeds', async () => {
		const { database, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let inner: ListingAdoptionRecoveryResult | undefined;
		const delayed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				inner = await new ListingAdoptionRecoveryStore(database).recover();
				return original(queries);
			});
		let outer: ListingAdoptionRecoveryResult;
		try {
			outer = await store.recover();
		} finally {
			delayed.mockRestore();
		}
		expect({
			outer,
			innerKind: inner?.kind,
			epochs: await database
				.select({ epoch: schema.listingAdoptionConsumer.epoch })
				.from(schema.listingAdoptionConsumer)
		}).toStrictEqual({
			outer: { kind: 'stale' },
			innerKind: 'recovered',
			epochs: [{ epoch: inner?.kind === 'recovered' ? inner.epoch : undefined }]
		});
	});
	it('rolls back seed resets when the consumer checkpoint cannot commit', async () => {
		const { database, store } = await fixture();
		const before = await snapshot(database);
		await env.CUPBOARD_DB.prepare(
			"CREATE TRIGGER reject_consumer_recovery BEFORE UPDATE OF epoch ON listing_adoption_consumer BEGIN SELECT RAISE(ABORT, 'recovery refused'); END"
		).run();
		try {
			await expect(store.recover()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			await env.CUPBOARD_DB.prepare(
				'DROP TRIGGER reject_consumer_recovery'
			).run();
		}
		expect(await snapshot(database)).toStrictEqual(before);
	});
	it('does not restart a committed recovery after its reply is lost', async () => {
		const { database, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const lost = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await original(queries);
				throw new Error('Recovery reply lost');
			});
		try {
			await expect(store.recover()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			lost.mockRestore();
		}
		const before = await snapshot(database);
		expect({
			result: await new ListingAdoptionRecoveryStore(database).recover(),
			state: await snapshot(database)
		}).toStrictEqual({ result: { kind: 'idle' }, state: before });
	});
	it('fences old seed claims before new scopes are enrolled', async () => {
		const { database, claims, dispatch, store } = await fixture();
		await store.recover();
		const stale = await Array.fromAsync(claims, (claim) =>
			claim.scope === 'facts'
				? new ListingAdoptionFactSeedStore(database).advance(claim)
				: new ListingAdoptionParentSeedStore(database).advance(claim)
		);
		const reserved = await dispatch.reserve();
		const current = await database
			.select()
			.from(schema.listingAdoptionSeedDispatch)
			.orderBy(asc(schema.listingAdoptionSeedDispatch.scope));
		expect({
			stale,
			reserved,
			fresh: current.every((row) =>
				claims.every((claim) => claim.epoch !== row.epoch)
			),
			checkpoints: {
				facts: await database.select().from(schema.listingAdoptionFactSeed),
				parents: await database.select().from(schema.listingAdoptionParentSeed)
			}
		}).toStrictEqual({
			stale: claims.map(() => ({ kind: 'stale' })),
			reserved: ['default-parents', 'facts', 'named-parents'],
			fresh: true,
			checkpoints: { facts: [], parents: [] }
		});
	});
	it('recovers with bounded point reads among 25,000 retained events', async () => {
		const { database } = await fixture();
		await env.CUPBOARD_DB.prepare(
			'WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<25000) INSERT INTO listing_adoption_capture_event(source) SELECT ? FROM numbered'
		)
			.bind(JSON.stringify(source))
			.run();
		const before = await database
			.select()
			.from(schema.listingAdoptionCaptureState)
			.get();
		const statements: { query: string; parameters: unknown[] }[] = [];
		const measured = drizzle(boundedD1(env.CUPBOARD_DB), {
			schema,
			logger: {
				logQuery(query, parameters) {
					statements.push({ query, parameters });
				}
			}
		});
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let reads = 0;
		let count = 0;
		const observed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				const result = await original(queries);
				reads = result.reduce((total, row) => total + row.meta.rows_read, 0);
				count = queries.length;
				return result;
			});
		let result: ListingAdoptionRecoveryResult;
		try {
			result = await withSubrequestSlice(
				() => new ListingAdoptionRecoveryStore(measured).recover(),
				{ subrequests: 15, reserve: 8 }
			);
		} finally {
			observed.mockRestore();
		}
		if (result.kind !== 'recovered') {
			throw new Error('The expired consumer did not recover');
		}
		expect({
			result,
			count,
			boundedReads: reads > 0 && reads <= 128,
			boundParameters: statements.every(
				(statement) => statement.parameters.length <= 100
			),
			boundSql: statements.every(
				(statement) =>
					new TextEncoder().encode(statement.query).byteLength <= 100_000
			)
		}).toStrictEqual({
			result: { kind: 'recovered', after: before?.latest, epoch: result.epoch },
			count: 4,
			boundedReads: true,
			boundParameters: true,
			boundSql: true
		});
	});
});
