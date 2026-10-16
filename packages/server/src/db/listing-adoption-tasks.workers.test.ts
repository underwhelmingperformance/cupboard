import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { listingGeneratorRevisionSchema } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import {
	listingAdoptionCaptureSequenceSchema,
	type ListingAdoptionCaptureSource
} from '../blob/listing-adoption-capture.ts';
import { listingAdoptionConsumerEpochSchema } from '../blob/listing-adoption-work.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { ListingAdoptionParentStore } from './listing-adoption-parents.ts';
import { ListingAdoptionTaskStore } from './listing-adoption-tasks.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);
const epoch = listingAdoptionConsumerEpochSchema.parse('1'.repeat(32));
const tenant = tenantIdSchema.parse('discovery-first');
const narHash = sharedNarSource(1).narHash;
const revision = listingGeneratorRevisionSchema.parse('history');
async function fixture(count = 3) {
	const { database } = await sharedNarDiscoveryFixture(0);
	await database.insert(schema.deploymentTransition).values([
		{ id: 'listing-adoption-capture', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-work', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-parents', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-tasks', state: 'complete', updatedAt: now }
	]);
	await database.insert(schema.cacheLifecycle).values({
		tenant,
		cacheKind: 'default',
		generation: cacheGenerationSchema.parse(1),
		access: 'private',
		updatedAt: now
	});
	for (let index = 0; index < count; index++) {
		await database.insert(schema.blobReference).values({
			tenant,
			cacheKind: 'default',
			cacheGeneration: cacheGenerationSchema.parse(1),
			storePathHash: storePathHashSchema.parse(String(index).padStart(32, '0')),
			generation: narInfoGenerationSchema.parse(1),
			narHash
		});
	}
	const paths = Array.from({ length: count }, (_, index) =>
		storePathHashSchema.parse(String(index).padStart(32, '0'))
	);
	for (let offset = 0; offset < paths.length; offset += 32) {
		await new ListingAdoptionParentStore(database).refresh({
			tenant,
			cache: { kind: 'default' },
			storePathHashes: paths.slice(offset, offset + 32)
		});
	}
	await database.insert(schema.listingFact).values({
		narHash,
		generatorRevision: revision,
		digest: sha256HexDigestSchema.parse('a'.repeat(64)),
		format: 1,
		size: 10,
		createdAt: now
	});
	const insert = async (eventId = 1, source?: ListingAdoptionCaptureSource) => {
		const event = listingAdoptionCaptureSequenceSchema.parse(eventId);
		await database.insert(schema.listingAdoptionWork).values({
			consumerEpoch: epoch,
			eventId: event,
			source: source ?? {
				kind: 'listing',
				identity: { narHash, generatorRevision: revision }
			}
		});
		const work = await database
			.select()
			.from(schema.listingAdoptionWork)
			.where(eq(schema.listingAdoptionWork.eventId, event))
			.get();
		if (work === undefined) {
			throw new Error('Expected captured work');
		}
		const row = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.workId, work.id))
			.get();
		if (row === undefined) {
			throw new Error('The work trigger must enrol an expansion task');
		}
		return row;
	};
	return { database, insert, store: new ListingAdoptionTaskStore(database) };
}
async function historicalFixture(count = 65) {
	const result = await fixture(0);
	const trigger = await env.CUPBOARD_DB.prepare(
		"SELECT sql FROM sqlite_master WHERE name='listing_adoption_work_enrol'"
	).first<string>('sql');
	if (trigger === null) {
		throw new Error('Expected compatible enrolment trigger');
	}
	await env.CUPBOARD_DB.prepare(
		'DROP TRIGGER listing_adoption_work_enrol'
	).run();
	try {
		await env.CUPBOARD_DB.prepare(
			"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<?) INSERT INTO listing_adoption_work(id,consumer_epoch,event_id,source) SELECT printf('%032x',value),?,value,json_object('kind','listing','identity',json_object('narHash',?,'generatorRevision',?)) FROM numbered"
		)
			.bind(count, epoch, narHash, revision)
			.run();
	} finally {
		await env.CUPBOARD_DB.prepare(trigger).run();
	}
	return result;
}

async function claimed(
	store: ListingAdoptionTaskStore,
	id: typeof schema.listingAdoptionTask.$inferSelect.id
) {
	const result = await store.claim(id, owner);
	if (result.kind !== 'claimed') {
		throw new Error('Expected an execution claim');
	}
	return result.claim;
}

describe('listing adoption execution', () => {
	it('durably copies new source work independently of the input row', async () => {
		const { database, insert } = await fixture();
		const row = await insert();
		await database.delete(schema.listingAdoptionWork);
		const saved = await database
			.select()
			.from(schema.listingAdoptionTask)
			.get();
		expect(saved).toStrictEqual(row);
	});
	it('enrols every parent before completing source progress', async () => {
		const { database, insert, store } = await fixture();
		const root = await insert();
		expect(await store.advance(await claimed(store, root.id))).toStrictEqual({
			kind: 'advanced',
			scanned: 3,
			enrolled: 3,
			isComplete: true
		});
		const rows = await database
			.select({
				kind: schema.listingAdoptionTask.kind,
				parentId: schema.listingAdoptionTask.parentId,
				revision: schema.listingAdoptionTask.generatorRevision
			})
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'deliver'))
			.orderBy(asc(schema.listingAdoptionTask.parentId));
		const parents = await database
			.select()
			.from(schema.listingAdoptionParent)
			.orderBy(asc(schema.listingAdoptionParent.id));
		expect(rows).toStrictEqual(
			parents.map((parent) => ({
				kind: 'deliver',
				parentId: parent.id,
				revision
			}))
		);
	});
	it('preserves live same-owner leases and excludes another owner', async () => {
		const { insert, store } = await fixture();
		const root = await insert();
		const first = await claimed(store, root.id);
		expect(await store.claim(root.id, owner)).toStrictEqual({
			kind: 'claimed',
			claim: first
		});
		expect(await store.claim(root.id, otherOwner)).toStrictEqual({
			kind: 'idle'
		});
	});
	it('rejects an expired execution owner after replacement', async () => {
		const { database, insert, store } = await fixture();
		const root = await insert();
		const first = await claimed(store, root.id);
		await database
			.update(schema.listingAdoptionTask)
			.set({ leaseExpiresAt: now })
			.where(eq(schema.listingAdoptionTask.id, root.id));
		const replacement = await store.claim(root.id, otherOwner);
		expect(replacement.kind).toBe('claimed');
		expect(await store.advance(first)).toStrictEqual({ kind: 'stale' });
		expect(
			await database
				.select()
				.from(schema.listingAdoptionTask)
				.where(eq(schema.listingAdoptionTask.kind, 'deliver'))
		).toStrictEqual([]);
	});
	it('defers one target without delaying its siblings', async () => {
		const { insert, store } = await fixture();
		const root = await insert();
		await store.advance(await claimed(store, root.id));
		const ids = await store.reserve(3);
		const first = ids[0];
		if (first === undefined) {
			throw new Error('Expected three deliveries');
		}
		expect(await store.defer(await claimed(store, first), 60)).toBe(true);
		for (const id of ids.slice(1)) {
			const result = await store.claim(id, otherOwner);
			expect(result.kind).toBe('claimed');
		}
		expect(await store.reserve(3)).toStrictEqual([]);
	});
	it('fences checkpoint and child writes if a claim expires after discovery', async () => {
		const { database, insert, store } = await fixture();
		const root = await insert();
		const claim = await claimed(store, root.id);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const delayed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database
					.update(schema.listingAdoptionTask)
					.set({ leaseExpiresAt: now })
					.where(eq(schema.listingAdoptionTask.id, root.id));
				return original(queries);
			});
		try {
			expect(await store.advance(claim)).toStrictEqual({ kind: 'stale' });
		} finally {
			delayed.mockRestore();
		}
		expect(
			await database
				.select()
				.from(schema.listingAdoptionTask)
				.where(eq(schema.listingAdoptionTask.kind, 'deliver'))
		).toStrictEqual([]);
	});
	it('returns unavailable before preparing absent task storage', async () => {
		const { database, store } = await fixture();
		await database
			.delete(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'listing-adoption-tasks'));
		const prepare = vi.spyOn(env.CUPBOARD_DB, 'prepare');
		try {
			expect(await store.reserve()).toStrictEqual([]);
			expect(
				prepare.mock.calls
					.map(([query]) => query)
					.some((query) => query.includes('listing_adoption_task"'))
			).toBe(false);
		} finally {
			prepare.mockRestore();
		}
	});
	it('replays bounded historical enrolment without resetting existing claims', async () => {
		const { database, store } = await historicalFixture();
		expect(await store.seed()).toStrictEqual({
			kind: 'advanced',
			scanned: 32,
			isComplete: false
		});
		const row = await database.select().from(schema.listingAdoptionTask).get();
		if (row === undefined) {
			throw new Error('Expected seeded task');
		}
		const claim = await claimed(store, row.id);
		expect(await store.seed()).toStrictEqual({
			kind: 'advanced',
			scanned: 32,
			isComplete: false
		});
		expect(await store.seed()).toStrictEqual({
			kind: 'advanced',
			scanned: 1,
			isComplete: true
		});
		expect(await store.seed()).toStrictEqual({ kind: 'complete' });
		expect(await store.claim(row.id, owner)).toStrictEqual({
			kind: 'claimed',
			claim
		});
		expect(
			await database
				.select({ count: sql<number>`count(*)` })
				.from(schema.listingAdoptionTask)
		).toStrictEqual([{ count: 65 }]);
	});

	it('resumes fixed windows across fresh store instances and deleted boundaries', async () => {
		const { database, insert, store } = await fixture(65);
		const root = await insert();
		expect(await store.advance(await claimed(store, root.id))).toStrictEqual({
			kind: 'advanced',
			scanned: 32,
			enrolled: 32,
			isComplete: false
		});
		const saved = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.id, root.id))
			.get();
		if (saved?.window?.kind !== 'listing') {
			throw new Error('Expected a saved listing cursor');
		}
		await database
			.delete(schema.listingAdoptionParent)
			.where(eq(schema.listingAdoptionParent.id, saved.window.through));
		const resumed = new ListingAdoptionTaskStore(database);
		expect(
			await resumed.advance(await claimed(resumed, root.id))
		).toStrictEqual({
			kind: 'advanced',
			scanned: 32,
			enrolled: 32,
			isComplete: true
		});
		expect(
			await database
				.select({
					scanned: schema.listingAdoptionTask.scanned,
					enrolled: schema.listingAdoptionTask.enrolled
				})
				.from(schema.listingAdoptionTask)
				.where(eq(schema.listingAdoptionTask.id, root.id))
		).toStrictEqual([{ scanned: 64, enrolled: 64 }]);
	});
	it('coalesces duplicate events without resetting pending target retries', async () => {
		const { database, insert, store } = await fixture(1);
		const first = await insert();
		await store.advance(await claimed(store, first.id));
		const target = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'deliver'))
			.get();
		if (target === undefined) {
			throw new Error('Expected target');
		}
		const claim = await claimed(store, target.id);
		await store.defer(claim, 60);
		const before = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.id, target.id))
			.get();
		const second = await insert(2);
		await store.advance(await claimed(store, second.id));
		expect(
			await database
				.select()
				.from(schema.listingAdoptionTask)
				.where(eq(schema.listingAdoptionTask.id, target.id))
				.get()
		).toStrictEqual(before);
		expect(await store.claim(target.id, owner)).toStrictEqual({ kind: 'idle' });
	});
	it('rotates a completed delivery epoch when new availability re-enrols it', async () => {
		const { database, insert, store } = await fixture(1);
		const first = await insert();
		await store.advance(await claimed(store, first.id));
		const target = await database
			.select()
			.from(schema.listingAdoptionTask)
			.where(eq(schema.listingAdoptionTask.kind, 'deliver'))
			.get();
		if (target === undefined) {
			throw new Error('Expected target');
		}
		const old = await claimed(store, target.id);
		expect(await store.finish(old, { kind: 'conflict' })).toBe(true);
		const second = await insert(2);
		await store.advance(await claimed(store, second.id));
		const next = await claimed(store, target.id);
		expect(next.epoch).not.toBe(old.epoch);
		expect(await store.finish(old, { kind: 'conflict' })).toBe(false);
		expect(await store.defer(old, 60)).toBe(false);
		expect(await store.claim(target.id, owner)).toStrictEqual({
			kind: 'claimed',
			claim: next
		});
	});
	it.each(['parent', 'listing', 'capture', 'progress'] as const)(
		'rechecks %s changes inside the enrolment transaction',
		async (kind) => {
			const { database, insert, store } = await fixture(1);
			const root = await insert();
			const claim = await claimed(store, root.id);
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const delayed = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (queries) => {
					switch (kind) {
						case 'parent': {
							await database
								.update(schema.listingAdoptionParent)
								.set({ generation: narInfoGenerationSchema.parse(2) });
							break;
						}
						case 'listing': {
							await database.delete(schema.listingFact);
							break;
						}
						case 'capture': {
							await database
								.update(schema.listingAdoptionCaptureState)
								.set({ isReady: false });
							break;
						}
						case 'progress': {
							await database
								.update(schema.listingAdoptionTask)
								.set({ progressRevision: 1 })
								.where(eq(schema.listingAdoptionTask.id, root.id));
							break;
						}
					}
					return original(queries);
				});
			try {
				expect(await store.advance(claim)).toStrictEqual(
					kind === 'parent'
						? { kind: 'advanced', scanned: 1, enrolled: 0, isComplete: true }
						: { kind: 'stale' }
				);
			} finally {
				delayed.mockRestore();
			}
			expect(
				await database
					.select()
					.from(schema.listingAdoptionTask)
					.where(eq(schema.listingAdoptionTask.kind, 'deliver'))
			).toStrictEqual([]);
		}
	);
	it('rolls back enrolled targets if the checkpoint cannot commit', async () => {
		const { database, insert, store } = await fixture();
		const root = await insert();
		const claim = await claimed(store, root.id);
		await env.CUPBOARD_DB.prepare(
			"CREATE TRIGGER reject_adoption_checkpoint BEFORE UPDATE OF progress_revision ON listing_adoption_task WHEN OLD.kind='expand' BEGIN SELECT RAISE(ABORT,'checkpoint unavailable'); END"
		).run();
		try {
			await expect(store.advance(claim)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			await env.CUPBOARD_DB.prepare(
				'DROP TRIGGER reject_adoption_checkpoint'
			).run();
		}
		expect(
			await database
				.select()
				.from(schema.listingAdoptionTask)
				.where(eq(schema.listingAdoptionTask.kind, 'deliver'))
		).toStrictEqual([]);
		expect(await store.advance(claim)).toStrictEqual({
			kind: 'advanced',
			scanned: 3,
			enrolled: 3,
			isComplete: true
		});
	});
	it.each([false, true])(
		'expands CAS recovery into fact events, repaired during commit: %s',
		async (repaired) => {
			const { database, insert, store } = await fixture(1);
			const digest = sha256HexDigestSchema.parse('a'.repeat(64));
			await database
				.insert(schema.casObject)
				.values({ digest, size: 10, incarnation: 2, storedAt: now });
			await database.insert(schema.objectIncarnation).values({
				kind: 'cas',
				objectId: digest,
				incarnation: 2,
				state: 'live',
				updatedAt: now
			});
			await database.delete(schema.listingAdoptionCaptureEvent);
			const root = await insert(1, { kind: 'cas', digest, incarnation: 2 });
			const claim = await claimed(store, root.id);
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const delayed = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (queries) => {
					if (repaired) {
						await database
							.update(schema.objectIncarnation)
							.set({ incarnation: 3 })
							.where(eq(schema.objectIncarnation.objectId, digest));
					}
					return original(queries);
				});
			try {
				expect(await store.advance(claim)).toStrictEqual(
					repaired
						? { kind: 'stale' }
						: { kind: 'advanced', scanned: 1, enrolled: 1, isComplete: true }
				);
			} finally {
				delayed.mockRestore();
			}
			const events = await database
				.select({ source: schema.listingAdoptionCaptureEvent.source })
				.from(schema.listingAdoptionCaptureEvent);
			expect(events).toStrictEqual(
				repaired
					? []
					: [
							{
								source: {
									kind: 'listing',
									identity: { narHash, generatorRevision: revision }
								}
							}
						]
			);
		}
	);
	it('expands parent availability to matching immutable listing identities', async () => {
		const { database, insert, store } = await fixture(1);
		const parent = await database
			.select()
			.from(schema.listingAdoptionParent)
			.get();
		if (parent === undefined) {
			throw new Error('Expected projected parent');
		}
		const root = await insert(1, {
			kind: 'parent',
			tenant,
			cache: { kind: 'default' },
			cacheGeneration: parent.cacheGeneration,
			storePathHash: parent.storePathHash,
			generation: parent.generation,
			narHash
		});
		expect(await store.advance(await claimed(store, root.id))).toStrictEqual({
			kind: 'advanced',
			scanned: 1,
			enrolled: 1,
			isComplete: true
		});
	});
	it('reads no NAR or listing payload bytes during execution', async () => {
		const { insert, store } = await fixture(1);
		const root = await insert();
		const get = vi.spyOn(env.BLOBS, 'get');
		const head = vi.spyOn(env.BLOBS, 'head');
		try {
			await store.advance(await claimed(store, root.id));
			expect({ get: get.mock.calls, head: head.mock.calls }).toStrictEqual({
				get: [],
				head: []
			});
		} finally {
			get.mockRestore();
			head.mockRestore();
		}
	});
	it('completes an empty historical window without postponing live work', async () => {
		const { insert, store } = await fixture(0);
		expect(await store.seed()).toStrictEqual({ kind: 'complete' });
		const root = await insert();
		expect(await store.claim(root.id, owner)).toMatchObject({
			kind: 'claimed'
		});
		expect(await store.seed()).toStrictEqual({ kind: 'complete' });
	});
	it('captures live work behind a fixed historical cursor', async () => {
		const { database, store } = await historicalFixture();
		await store.seed();
		await env.CUPBOARD_DB.prepare(
			"INSERT INTO listing_adoption_work(id,consumer_epoch,event_id,source) VALUES (printf('%032x',0),?,66,json_object('kind','listing','identity',json_object('narHash',?,'generatorRevision',?)))"
		)
			.bind(epoch, narHash, revision)
			.run();
		await store.seed();
		await store.seed();
		expect(
			await database
				.select({ count: sql<number>`count(*)` })
				.from(schema.listingAdoptionTask)
		).toStrictEqual([{ count: 66 }]);
		expect(
			await database
				.select({ scanned: schema.listingAdoptionTaskSeed.scanned })
				.from(schema.listingAdoptionTaskSeed)
		).toStrictEqual([{ scanned: 65 }]);
	});
	it('fences overlapping historical pages before inserting their tasks', async () => {
		const { database, store } = await historicalFixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const delayed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await new ListingAdoptionTaskStore(database).seed();
				return original(queries);
			});
		try {
			expect(await store.seed()).toStrictEqual({ kind: 'stale' });
		} finally {
			delayed.mockRestore();
		}
		expect(
			await database
				.select({ count: sql<number>`count(*)` })
				.from(schema.listingAdoptionTask)
		).toStrictEqual([{ count: 32 }]);
		expect(
			await database
				.select({ scanned: schema.listingAdoptionTaskSeed.scanned })
				.from(schema.listingAdoptionTaskSeed)
		).toStrictEqual([{ scanned: 32 }]);
	});
	it('recovers a lost historical commit reply without rescanning its page', async () => {
		const { database, store } = await historicalFixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const delayed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await original(queries);
				throw new Error('Lost committed reply');
			});
		try {
			await expect(store.seed()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			delayed.mockRestore();
		}
		expect(await new ListingAdoptionTaskStore(database).seed()).toStrictEqual({
			kind: 'advanced',
			scanned: 32,
			isComplete: false
		});
		expect(
			await database
				.select({ count: sql<number>`count(*)` })
				.from(schema.listingAdoptionTask)
		).toStrictEqual([{ count: 64 }]);
	});
	it('advances past deleted historical boundaries', async () => {
		const { database, store } = await historicalFixture();
		await store.seed();
		const state = await database
			.select()
			.from(schema.listingAdoptionTaskSeed)
			.get();
		if (state?.through === null || state?.through === undefined) {
			throw new Error('Expected fixed upper boundary');
		}
		await database
			.delete(schema.listingAdoptionWork)
			.where(eq(schema.listingAdoptionWork.id, state.through));
		expect(await store.seed()).toStrictEqual({
			kind: 'advanced',
			scanned: 32,
			isComplete: true
		});
		expect(
			await database
				.select({
					after: schema.listingAdoptionTaskSeed.after,
					through: schema.listingAdoptionTaskSeed.through,
					scanned: schema.listingAdoptionTaskSeed.scanned,
					isComplete: schema.listingAdoptionTaskSeed.isComplete
				})
				.from(schema.listingAdoptionTaskSeed)
		).toStrictEqual([
			{
				after: state.through,
				through: state.through,
				scanned: 64,
				isComplete: true
			}
		]);
	});
	it('bounds historical insertion and checkpoint reads across 25,000 inputs', async () => {
		const { store } = await historicalFixture(25_000);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let reads = 0;
		const measured = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (queries) => {
				const results = await original(queries);
				for (const result of results) {
					reads += result.meta.rows_read;
				}
				return results;
			});
		try {
			expect(await store.seed()).toStrictEqual({
				kind: 'advanced',
				scanned: 32,
				isComplete: false
			});
		} finally {
			measured.mockRestore();
		}
		expect(reads).toBeLessThanOrEqual(512);
	});
	it('checks capture storage readiness before preparing historical seed statements', async () => {
		const { database, store } = await fixture(0);
		await database
			.delete(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'listing-adoption-capture'));
		const prepare = vi.spyOn(env.CUPBOARD_DB, 'prepare');
		try {
			expect(await store.seed()).toStrictEqual({ kind: 'unavailable' });
			expect(
				prepare.mock.calls
					.map(([query]) => query)
					.some((query) => query.includes('listing_adoption_capture_state'))
			).toBe(false);
		} finally {
			prepare.mockRestore();
		}
	});
});
