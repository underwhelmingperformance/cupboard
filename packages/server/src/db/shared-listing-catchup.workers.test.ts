import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	artifactJobGenerationSchema,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, eq, lte, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import { narCaptureSequenceSchema } from '../blob/nar-source-capture.ts';
import type {
	SharedListingDiscoveryClaimResult,
	SharedListingJobSummary
} from '../blob/shared-listing-jobs.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { NarSourceCaptureStore } from './nar-source-capture.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';
import { SharedNarDiscovery } from './shared-nar-discovery.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const deadline = isoTimestamp(new Date('2026-01-01T00:01:00.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);

function claimed(result: SharedListingDiscoveryClaimResult) {
	if (result.kind !== 'claimed') {
		throw new Error(`Expected a discovery claim, received ${result.kind}`);
	}
	return result.claim;
}

function summary(result: SharedListingJobSummary | undefined) {
	if (result === undefined) {
		throw new Error('Expected a shared listing job checkpoint');
	}
	return result;
}

async function publishSource(
	database: DrizzleD1Database<typeof schema>,
	index: number
) {
	const source = sharedNarSource(index);
	const pathHash = storePathHashSchema.parse(String(index).padStart(32, '0'));
	await database.batch([
		database.insert(schema.blobState).values({
			narHash: source.narHash,
			fileHash: source.narHash,
			incarnation: source.sourceIncarnation,
			narSize: source.narSize,
			fileSize: source.fileSize,
			compression: 'zstd',
			verifiedAt: now
		}),
		database.insert(schema.objectIncarnation).values({
			kind: 'nar',
			objectId: source.narHash,
			incarnation: source.sourceIncarnation,
			state: 'live',
			updatedAt: now
		}),
		database.insert(schema.blobReference).values({
			tenant: tenantIdSchema.parse('discovery-first'),
			cacheKind: 'default',
			cacheGeneration: cacheGenerationSchema.parse(1),
			storePathHash: pathHash,
			generation: narInfoGenerationSchema.parse(1),
			narHash: source.narHash
		})
	]);
	return source;
}

async function fixture() {
	const { database } = await sharedNarDiscoveryFixture(0);
	const initial = await publishSource(database, 100);
	const capture = new NarSourceCaptureStore(database);
	const store = new SharedListingJobStore(database);
	const job = await store.start(currentListingGeneratorRevision, now);
	return { database, capture, store, job, initial };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function beginCatchup(context: Fixture, count = 1) {
	const reader = new SharedNarDiscovery(context.database);
	const store = new SharedListingJobStore(context.database, {
		async page(cursor) {
			const page = await reader.page(cursor);
			for (let index = 0; index < count; index++) {
				await publishSource(context.database, index);
			}
			return page;
		}
	});
	const claim = claimed(await store.claim(context.job, owner, now));
	return summary(await store.discover(claim));
}

function taskRows(database: DrizzleD1Database<typeof schema>) {
	return database
		.select({
			jobId: schema.sharedListingTask.jobId,
			narHash: schema.sharedListingTask.narHash,
			sourceIncarnation: schema.sharedListingTask.sourceIncarnation,
			narSize: schema.sharedListingTask.narSize,
			fileSize: schema.sharedListingTask.fileSize
		})
		.from(schema.sharedListingTask)
		.orderBy(schema.sharedListingTask.narHash);
}

describe('shared listing discovery catch-up', () => {
	it('closes a finite window and catches a source published behind the historical cursor', async () => {
		const context = await fixture();
		const { database, store, job, initial } = context;
		const historical = await beginCatchup(context);
		const through = narCaptureSequenceSchema.parse(job.eventCursor + 1);
		await publishSource(database, 1);
		const claim = claimed(await store.claim(job, otherOwner, now));
		const finished = await store.discover(claim);
		expect({
			historical,
			claim,
			finished,
			next: await store.claim(job, owner, now),
			tasks: await taskRows(database)
		}).toStrictEqual({
			historical: {
				...job,
				phase: 'catchup',
				cursor: initial.narHash,
				eventThrough: through,
				progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 }
			},
			claim: {
				job: { id: job.id, generation: job.generation },
				owner: otherOwner,
				generation: 2,
				leaseExpiresAt: deadline,
				phase: 'catchup',
				cursor: initial.narHash,
				eventCursor: job.eventCursor,
				eventThrough: through
			},
			finished: {
				...job,
				phase: 'processing',
				cursor: initial.narHash,
				eventCursor: through,
				eventThrough: through,
				progress: { discovered: 2, completed: 0, skipped: 0, failed: 0 }
			},
			next: { kind: 'unavailable' },
			tasks: [sharedNarSource(0), initial].map((source) => ({
				jobId: job.id,
				...source
			}))
		});
	});

	it('checkpoints bounded catch-up pages even when an entire candidate page is no longer retained', async () => {
		const context = await fixture();
		const { database, store, job, initial } = context;
		const historical = await beginCatchup(context, 65);
		await database
			.delete(schema.blobReference)
			.where(lte(schema.blobReference.narHash, sharedNarSource(31).narHash));
		const pages = [];
		for (let index = 0; index < 3; index++) {
			const claim = claimed(await store.claim(job, owner, now));
			pages.push(await store.discover(claim));
		}
		const through = narCaptureSequenceSchema.parse(job.eventCursor + 65);
		expect({ pages, tasks: await taskRows(database) }).toStrictEqual({
			pages: [
				{
					...historical,
					eventCursor: narCaptureSequenceSchema.parse(job.eventCursor + 32)
				},
				{
					...historical,
					eventCursor: narCaptureSequenceSchema.parse(job.eventCursor + 64),
					progress: { discovered: 33, completed: 0, skipped: 0, failed: 0 }
				},
				{
					...historical,
					phase: 'processing',
					eventCursor: through,
					progress: { discovered: 34, completed: 0, skipped: 0, failed: 0 }
				}
			],
			tasks: [
				...Array.from({ length: 33 }, (_, index) =>
					sharedNarSource(index + 32)
				),
				initial
			].map((source) => ({ jobId: job.id, ...source }))
		});
	});

	it('refreshes a repaired source without recounting its task or changing its creation page', async () => {
		const { database, store, job, initial } = await fixture();
		const reader = new SharedNarDiscovery(database);
		const discovery = new SharedListingJobStore(database, {
			async page(cursor) {
				const page = await reader.page(cursor);
				const identity = and(
					eq(schema.objectIncarnation.kind, 'nar'),
					eq(schema.objectIncarnation.objectId, initial.narHash)
				);
				await database
					.update(schema.objectIncarnation)
					.set({ state: 'pending', incarnation: 3 })
					.where(identity);
				await database
					.update(schema.blobState)
					.set({ incarnation: 3 })
					.where(eq(schema.blobState.narHash, initial.narHash));
				await database
					.update(schema.objectIncarnation)
					.set({ state: 'live' })
					.where(identity);
				return page;
			}
		});
		const claim = claimed(await store.claim(job, owner, now));
		const historical = summary(await discovery.discover(claim));
		const before = await database.select().from(schema.sharedListingTask);
		const finished = await store.discover(
			claimed(await store.claim(job, owner, now))
		);
		expect({
			finished,
			tasks: await database.select().from(schema.sharedListingTask)
		}).toStrictEqual({
			finished: {
				...historical,
				phase: 'processing',
				eventCursor: historical.eventThrough
			},
			tasks: before.map((task) => ({ ...task, sourceIncarnation: 3 }))
		});
	});

	it.each(['cancel', 'resume', 'expire'] as const)(
		'fences a catch-up checkpoint after %s during source replay',
		async (mode) => {
			const context = await fixture();
			const { database, store, capture, job } = context;
			const historical = await beginCatchup(context);
			const before = await taskRows(database);
			const claim = claimed(await store.claim(job, owner, now));
			const discovery = new SharedListingJobStore(
				database,
				new SharedNarDiscovery(database),
				{
					async page(window) {
						const page = await capture.page(window);
						if (mode === 'expire') {
							vi.setSystemTime(deadline);
							return page;
						}
						await store.cancel(job, now);
						if (mode === 'resume') {
							await store.resume(job, now);
						}
						return page;
					}
				}
			);
			expect({
				result: await discovery.discover(claim),
				summary: await store.find(job.id),
				tasks: await taskRows(database)
			}).toStrictEqual({
				result: undefined,
				summary: {
					...historical,
					state: mode === 'cancel' ? 'cancelled' : 'running',
					generation:
						mode === 'resume'
							? artifactJobGenerationSchema.parse(2)
							: job.generation
				},
				tasks: before
			});
		}
	);

	it('preserves the window across cancellation and recovers a lost catch-up checkpoint reply', async () => {
		const context = await fixture();
		const { database, store, job, initial } = context;
		const historical = await beginCatchup(context);
		await store.cancel(job, now);
		await publishSource(database, 1);
		const resumed = summary(await store.resume(job, now));
		const claim = claimed(await store.claim(resumed, otherOwner, now));
		const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const lostReply = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (statements) => {
				const results = await batch(statements);
				const persisted = await store.find(job.id);
				if (persisted?.phase === 'processing') {
					throw new Error('The committed catch-up reply was lost');
				}
				return results;
			});
		try {
			await expect(store.discover(claim)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			lostReply.mockRestore();
		}
		expect({
			resumed,
			replay: await store.discover(claim),
			finished: await store.find(job.id),
			tasks: await taskRows(database)
		}).toStrictEqual({
			resumed: {
				...historical,
				generation: artifactJobGenerationSchema.parse(2)
			},
			replay: undefined,
			finished: {
				...historical,
				generation: artifactJobGenerationSchema.parse(2),
				phase: 'processing',
				eventCursor: historical.eventThrough,
				progress: { discovered: 2, completed: 0, skipped: 0, failed: 0 }
			},
			tasks: [sharedNarSource(0), initial].map((source) => ({
				jobId: job.id,
				...source
			}))
		});
	});

	it('restarts historical discovery after a restored job loses its capture window', async () => {
		const context = await fixture();
		const { database, capture, store, job } = context;
		const historical = await beginCatchup(context);
		const position = await capture.position();
		await database.batch([
			database
				.update(schema.narCaptureState)
				.set({ prunedThrough: position.latest }),
			database.delete(schema.narCaptureEvent)
		]);
		const restarted = await store.discover(
			claimed(await store.claim(job, owner, now))
		);
		const rescanned = await store.discover(
			claimed(await store.claim(job, otherOwner, now))
		);
		expect({
			restarted,
			rescanned,
			tasks: await taskRows(database)
		}).toStrictEqual({
			restarted: {
				...historical,
				phase: 'historical',
				cursor: undefined,
				eventCursor: position.latest,
				eventThrough: undefined
			},
			rescanned: {
				...historical,
				eventCursor: position.latest,
				eventThrough: position.latest,
				progress: { discovered: 2, completed: 0, skipped: 0, failed: 0 }
			},
			tasks: [sharedNarSource(0), context.initial].map((source) => ({
				jobId: job.id,
				...source
			}))
		});
	});
	it.each(['cursor', 'window', 'phase'] as const)(
		'refuses a claim after its persisted %s changes',
		async (changed) => {
			const context = await fixture();
			const { database, store, job } = context;
			await beginCatchup(context, 2);
			const claim = claimed(await store.claim(job, owner, now));
			switch (changed) {
				case 'cursor': {
					await database.update(schema.sharedListingJob).set({
						eventCursor: narCaptureSequenceSchema.parse(job.eventCursor + 1)
					});
					break;
				}
				case 'window': {
					await database.update(schema.sharedListingJob).set({
						eventThrough: narCaptureSequenceSchema.parse(job.eventCursor + 1)
					});
					break;
				}
				case 'phase': {
					await database
						.update(schema.sharedListingJob)
						.set({ phase: 'processing' });
					break;
				}
			}

			const before = {
				jobs: await database.select().from(schema.sharedListingJob),
				tasks: await taskRows(database)
			};
			expect({
				renewed: await store.renew(claim, now),
				result: await store.discover(claim),
				persisted: {
					jobs: await database.select().from(schema.sharedListingJob),
					tasks: await taskRows(database)
				}
			}).toStrictEqual({
				renewed: undefined,
				result: undefined,
				persisted: before
			});
		}
	);

	it('keeps tasks and the historical cursor unchanged when capture readiness disappears before checkpoint', async () => {
		const { database, store, job } = await fixture();
		const claim = claimed(await store.claim(job, owner, now));
		const before = {
			jobs: await database.select().from(schema.sharedListingJob),
			tasks: await taskRows(database)
		};
		const reader = new SharedNarDiscovery(database);
		const discovery = new SharedListingJobStore(database, {
			async page(cursor) {
				const page = await reader.page(cursor);
				await database.update(schema.narCaptureState).set({ isReady: false });
				return page;
			}
		});
		expect({
			result: await discovery.discover(claim),
			persisted: {
				jobs: await database.select().from(schema.sharedListingJob),
				tasks: await taskRows(database)
			}
		}).toStrictEqual({ result: undefined, persisted: before });
	});

	it.each(['before-cursor', 'fractional', 'overflow'] as const)(
		'refuses an invalid persisted capture-window boundary: %s',
		async (invalid) => {
			const { database, store, job } = await fixture();
			const boundaries = {
				'before-cursor': job.eventCursor - 1,
				fractional: job.eventCursor + 0.5,
				overflow: Number.MAX_SAFE_INTEGER + 1
			};
			const through = boundaries[invalid];
			await expect(
				database.run(
					sql`UPDATE shared_listing_job SET event_through = ${through} WHERE id = ${job.id}`
				)
			).rejects.toThrow();
			expect(await store.find(job.id)).toStrictEqual(job);
		}
	);

	it('restarts a predecessor catch-up job that has no closed window', async () => {
		const context = await fixture();
		const { database, capture, store, job, initial } = context;
		const historical = await beginCatchup(context);
		await database.run(
			sql`UPDATE shared_listing_job SET event_through = NULL WHERE id = ${job.id}`
		);
		const position = await capture.position();
		const claim = claimed(await store.claim(job, otherOwner, now));
		const rescanned = await store.discover(claim);
		expect({ claim, rescanned, tasks: await taskRows(database) }).toStrictEqual(
			{
				claim: {
					job: { id: job.id, generation: job.generation },
					owner: otherOwner,
					generation: 2,
					leaseExpiresAt: deadline,
					phase: 'historical',
					cursor: undefined,
					eventCursor: position.latest,
					eventThrough: undefined
				},
				rescanned: {
					...historical,
					eventCursor: position.latest,
					eventThrough: position.latest,
					progress: { discovered: 2, completed: 0, skipped: 0, failed: 0 }
				},
				tasks: [sharedNarSource(0), initial].map((source) => ({
					jobId: job.id,
					...source
				}))
			}
		);
	});
});
