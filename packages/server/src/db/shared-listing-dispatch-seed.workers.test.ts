import {
	artifactJobGenerationSchema,
	type ArtifactJobId,
	artifactJobIdSchema
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { SharedListingDispatchSeedStore } from './shared-listing-dispatch-seed.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import { sharedNarDiscoveryFixture } from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('3000-01-01T00:00:00.000Z'));
const generation = artifactJobGenerationSchema.parse(1);
function jobId(index: number): ArtifactJobId {
	return artifactJobIdSchema.parse(
		`10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
	);
}
async function fixture(count = 65) {
	const { database } = await sharedNarDiscoveryFixture(0);
	const ids = Array.from({ length: count }, (_, index) => jobId(index + 1));
	for (const id of ids) {
		await database.insert(schema.sharedListingJob).values({
			id,
			generation,
			generatorRevision: currentListingGeneratorRevision,
			createdAt: now,
			updatedAt: now
		});
	}
	await database.delete(schema.sharedListingJobDispatch);
	return { database, ids, store: new SharedListingDispatchSeedStore(database) };
}

describe('global listing dispatch catalogue recovery', () => {
	it('advances through fixed candidate pages even when terminal jobs fill the page', async () => {
		const { database, ids, store } = await fixture();
		await database
			.update(schema.sharedListingJob)
			.set({ state: 'cancelled' })
			.where(inArray(schema.sharedListingJob.id, ids.slice(0, 63)));
		await database.delete(schema.sharedListingJobDispatch);
		const first = await store.advance(now);
		const checkpoint = await database
			.select()
			.from(schema.sharedListingDispatchSeed);
		const second = await store.advance(now);
		const third = await store.advance(now);
		const tickets = await database
			.select({
				id: schema.sharedListingJobDispatch.jobId,
				seeded: schema.sharedListingJobDispatch.isSeeded
			})
			.from(schema.sharedListingJobDispatch)
			.orderBy(asc(schema.sharedListingJobDispatch.jobId));
		expect({
			first,
			checkpoint,
			second,
			third,
			tickets,
			again: await store.advance(now)
		}).toStrictEqual({
			first: { kind: 'advanced', scanned: 32, enrolled: 0, isComplete: false },
			checkpoint: [
				{ id: 1, after: jobId(32), through: jobId(65), isComplete: false }
			],
			second: { kind: 'advanced', scanned: 32, enrolled: 1, isComplete: false },
			third: { kind: 'advanced', scanned: 1, enrolled: 1, isComplete: true },
			tickets: [
				{ id: jobId(64), seeded: false },
				{ id: jobId(65), seeded: false }
			],
			again: { kind: 'complete' }
		});
	});

	it('preserves existing reservations and uses triggers for new jobs outside the frozen catalogue', async () => {
		const { database, store } = await fixture();
		await database.insert(schema.sharedListingJobDispatch).values({
			jobId: jobId(40),
			jobGeneration: generation,
			nextDeliveryAt: now,
			isSeeded: true
		});
		const before = await database
			.select()
			.from(schema.sharedListingJobDispatch)
			.where(eq(schema.sharedListingJobDispatch.jobId, jobId(40)));
		await store.advance(now);
		const late = [
			artifactJobIdSchema.parse('00000000-0000-4000-8000-000000000001'),
			artifactJobIdSchema.parse('20000000-0000-4000-8000-000000000001')
		];
		for (const id of late) {
			await database.insert(schema.sharedListingJob).values({
				id,
				generation,
				generatorRevision: currentListingGeneratorRevision,
				createdAt: now,
				updatedAt: now
			});
		}
		const second = await store.advance(now);
		const third = await store.advance(now);
		const after = await database
			.select()
			.from(schema.sharedListingJobDispatch)
			.where(eq(schema.sharedListingJobDispatch.jobId, jobId(40)));
		const captured = await database
			.select({
				id: schema.sharedListingJobDispatch.jobId,
				seeded: schema.sharedListingJobDispatch.isSeeded
			})
			.from(schema.sharedListingJobDispatch)
			.where(inArray(schema.sharedListingJobDispatch.jobId, late))
			.orderBy(asc(schema.sharedListingJobDispatch.jobId));
		expect({ before, after, second, third, captured }).toStrictEqual({
			before,
			after: before,
			second: {
				kind: 'advanced',
				scanned: 32,
				enrolled: 31,
				isComplete: false
			},
			third: { kind: 'advanced', scanned: 1, enrolled: 1, isComplete: true },
			captured: late.map((id) => ({ id, seeded: true }))
		});
	});

	it('recovers a committed page after its reply is lost', async () => {
		const { database, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const reply = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				await original(statements);
				throw new Error('The catalogue checkpoint reply was lost');
			});
		try {
			await expect(store.advance(now)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			reply.mockRestore();
		}
		const recovered = await new SharedListingDispatchSeedStore(
			database
		).advance(now);
		expect({
			recovered,
			checkpoint: await database
				.select()
				.from(schema.sharedListingDispatchSeed),
			tickets: await database
				.select({ id: schema.sharedListingJobDispatch.jobId })
				.from(schema.sharedListingJobDispatch)
				.orderBy(asc(schema.sharedListingJobDispatch.jobId))
		}).toStrictEqual({
			recovered: {
				kind: 'advanced',
				scanned: 32,
				enrolled: 32,
				isComplete: false
			},
			checkpoint: [
				{ id: 1, after: jobId(64), through: jobId(65), isComplete: false }
			],
			tickets: Array.from({ length: 64 }, (_, index) => ({
				id: jobId(index + 1)
			}))
		});
	});

	it('rolls back ticket enrolment when the cursor checkpoint fails', async () => {
		const { database, store } = await fixture(1);
		await env.CUPBOARD_DB.prepare(
			`CREATE TRIGGER test_dispatch_seed_abort BEFORE UPDATE ON shared_listing_dispatch_seed BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END`
		).run();
		try {
			await expect(store.advance(now)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			await env.CUPBOARD_DB.prepare(
				'DROP TRIGGER test_dispatch_seed_abort'
			).run();
		}
		const checkpoints = await database
			.select()
			.from(schema.sharedListingDispatchSeed);
		expect({
			tickets: await database.select().from(schema.sharedListingJobDispatch),
			checkpoint: checkpoints.map((row) => ({
				...row,
				after: row.after ?? undefined
			}))
		}).toStrictEqual({
			tickets: [],
			checkpoint: [
				{ id: 1, after: undefined, through: jobId(1), isComplete: false }
			]
		});
		expect(await store.advance(now)).toStrictEqual({
			kind: 'advanced',
			scanned: 1,
			enrolled: 1,
			isComplete: true
		});
	});

	it('refuses a late page after a concurrent consumer advances the cursor', async () => {
		const { database, store } = await fixture(97);
		await store.advance(now);
		const entered = Promise.withResolvers<undefined>();
		const release = Promise.withResolvers<undefined>();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const intercept = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				entered.resolve(undefined);
				await release.promise;
				return original(statements);
			});
		const delayed = store.advance(now);
		try {
			await entered.promise;
			await store.advance(now);
			await store.advance(now);
			release.resolve(undefined);
			const result = await delayed;
			expect({
				result,
				checkpoint: await database
					.select()
					.from(schema.sharedListingDispatchSeed)
			}).toStrictEqual({
				result: { kind: 'stale' },
				checkpoint: [
					{ id: 1, after: jobId(96), through: jobId(97), isComplete: false }
				]
			});
		} finally {
			release.resolve(undefined);
			await Promise.allSettled([delayed]);
			intercept.mockRestore();
		}
	});

	it.each(['cancelled', 'new-generation'] as const)(
		'rechecks a %s job when the selected page is committed',
		async (condition) => {
			const { database, store } = await fixture(1);
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const intercept = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (statements) => {
					await database
						.update(schema.sharedListingJob)
						.set(
							condition === 'cancelled'
								? { state: 'cancelled' }
								: { generation: artifactJobGenerationSchema.parse(2) }
						)
						.where(eq(schema.sharedListingJob.id, jobId(1)));
					await database.delete(schema.sharedListingJobDispatch);
					return original(statements);
				});
			try {
				await store.advance(now);
			} finally {
				intercept.mockRestore();
			}
			expect(
				await database
					.select({
						jobId: schema.sharedListingJobDispatch.jobId,
						generation: schema.sharedListingJobDispatch.jobGeneration
					})
					.from(schema.sharedListingJobDispatch)
			).toStrictEqual(
				condition === 'cancelled'
					? []
					: [
							{
								jobId: jobId(1),
								generation: artifactJobGenerationSchema.parse(2)
							}
						]
			);
		}
	);

	it('finishes through a deleted boundary and seeks past a deleted cursor', async () => {
		const { database, ids, store } = await fixture();
		await store.advance(now);
		await database
			.delete(schema.sharedListingJob)
			.where(inArray(schema.sharedListingJob.id, ids.slice(31)));
		expect({
			result: await store.advance(now),
			checkpoint: await database.select().from(schema.sharedListingDispatchSeed)
		}).toStrictEqual({
			result: { kind: 'advanced', scanned: 0, enrolled: 0, isComplete: true },
			checkpoint: [
				{ id: 1, after: jobId(65), through: jobId(65), isComplete: true }
			]
		});
	});

	it('finishes an empty catalogue once and captures later jobs without another scan', async () => {
		const { database, store } = await fixture(0);
		const first = await store.advance(now);
		const job = await new SharedListingJobStore(database).start(
			currentListingGeneratorRevision,
			now
		);
		const checkpoints = await database
			.select()
			.from(schema.sharedListingDispatchSeed);
		expect({
			first,
			again: await store.advance(now),
			checkpoint: checkpoints.map((row) => ({
				...row,
				after: row.after ?? undefined,
				through: row.through ?? undefined
			})),
			tickets: await database
				.select({
					jobId: schema.sharedListingJobDispatch.jobId,
					seeded: schema.sharedListingJobDispatch.isSeeded
				})
				.from(schema.sharedListingJobDispatch)
		}).toStrictEqual({
			first: { kind: 'complete' },
			again: { kind: 'complete' },
			checkpoint: [
				{ id: 1, after: undefined, through: undefined, isComplete: true }
			],
			tickets: [{ jobId: job.id, seeded: true }]
		});
	});
});
