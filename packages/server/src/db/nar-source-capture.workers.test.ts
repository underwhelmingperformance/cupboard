import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, eq, ne, sql } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import { narCaptureSequenceSchema } from '../blob/nar-source-capture.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { NarSourceCaptureStore } from './nar-source-capture.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';
import type { SharedNarSource } from './shared-nar-discovery.ts';

const zero = narCaptureSequenceSchema.parse(0);
const tenant = tenantIdSchema.parse('discovery-first');
const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));

function metadata(
	source: SharedNarSource
): typeof schema.blobState.$inferInsert {
	return {
		narHash: source.narHash,
		fileHash: source.narHash,
		fileSize: source.fileSize,
		narSize: source.narSize,
		compression: 'zstd',
		incarnation: source.sourceIncarnation,
		verifiedAt: now
	};
}

function reference(
	source: SharedNarSource,
	index = 0
): typeof schema.blobReference.$inferInsert {
	return {
		tenant,
		cacheKind: 'default',
		cacheGeneration: cacheGenerationSchema.parse(1),
		generation: narInfoGenerationSchema.parse(1),
		storePathHash: storePathHashSchema.parse(String(index).padStart(32, '0')),
		narHash: source.narHash
	};
}

async function storeSource(
	database: DrizzleD1Database<typeof schema>,
	index: number
) {
	const source = sharedNarSource(index);
	await database.batch([
		database.insert(schema.blobState).values(metadata(source)),
		database.insert(schema.objectIncarnation).values({
			kind: 'nar',
			objectId: source.narHash,
			incarnation: source.sourceIncarnation,
			state: 'live',
			updatedAt: now
		})
	]);
	return source;
}

async function fixture(count = 1) {
	const baseline =
		(await env.CUPBOARD_DB.prepare(
			"SELECT seq FROM sqlite_sequence WHERE name = 'nar_capture_event'"
		).first<number>('seq')) ?? 0;
	const { database, sources } = await sharedNarDiscoveryFixture(count);
	return {
		database,
		sources,
		capture: new NarSourceCaptureStore(database),
		sequence: (offset: number) =>
			narCaptureSequenceSchema.parse(baseline + offset)
	};
}

async function events() {
	return drizzle(env.CUPBOARD_DB, { schema })
		.select({
			id: schema.narCaptureEvent.id,
			narHash: schema.narCaptureEvent.narHash,
			sourceIncarnation: schema.narCaptureEvent.sourceIncarnation
		})
		.from(schema.narCaptureEvent)
		.orderBy(schema.narCaptureEvent.id);
}

describe('shared NAR source capture', () => {
	it('captures a retained source once across tenant references', async () => {
		const { capture, sequence } = await fixture();
		expect({
			position: await capture.position(),
			events: await events()
		}).toStrictEqual({
			position: { latest: sequence(1), prunedThrough: zero, isReady: true },
			events: [
				{
					id: sequence(1),
					narHash: sharedNarSource(0).narHash,
					sourceIncarnation: 2
				}
			]
		});
	});

	it('does not append for additional references or readability updates, and recaptures a new retention edge', async () => {
		const { database, capture, sequence } = await fixture();
		await database
			.insert(schema.blobReference)
			.values(reference(sharedNarSource(0), 1));
		await database.update(schema.blobReference).set({ readable: false });
		const before = await capture.position();
		await database.delete(schema.blobReference);
		await database
			.insert(schema.blobReference)
			.values(reference(sharedNarSource(0)));
		expect({
			before,
			after: await capture.position(),
			events: await events()
		}).toStrictEqual({
			before: { latest: sequence(1), prunedThrough: zero, isReady: true },
			after: { latest: sequence(2), prunedThrough: zero, isReady: true },
			events: [1, 2].map((offset) => ({
				id: sequence(offset),
				narHash: sharedNarSource(0).narHash,
				sourceIncarnation: 2
			}))
		});
	});

	it('captures a reference that changes to a previously unretained NAR', async () => {
		const { database, capture, sequence } = await fixture();
		const next = await storeSource(database, 1);
		await database
			.update(schema.blobReference)
			.set({ narHash: next.narHash })
			.where(eq(schema.blobReference.tenant, tenant));
		expect({
			position: await capture.position(),
			events: await events()
		}).toStrictEqual({
			position: { latest: sequence(2), prunedThrough: zero, isReady: true },
			events: [0, 1].map((index) => ({
				id: sequence(index + 1),
				narHash: sharedNarSource(index).narHash,
				sourceIncarnation: 2
			}))
		});
	});

	it.each(['metadata-first', 'registration-first'] as const)(
		'captures legacy references when their source becomes available through %s',
		async (order) => {
			const { database, capture, sequence } = await fixture(0);
			const source = sharedNarSource(0);
			await database.insert(schema.blobReference).values(reference(source));
			const registration = () =>
				database.insert(schema.objectIncarnation).values({
					kind: 'nar',
					objectId: source.narHash,
					incarnation: 2,
					state: 'live',
					updatedAt: now
				});
			const blob = () =>
				database.insert(schema.blobState).values(metadata(source));
			if (order === 'metadata-first') {
				await blob();
				await registration();
			} else {
				await registration();
				await blob();
			}
			expect({
				position: await capture.position(),
				events: await events()
			}).toStrictEqual({
				position: { latest: sequence(1), prunedThrough: zero, isReady: true },
				events: [
					{ id: sequence(1), narHash: source.narHash, sourceIncarnation: 2 }
				]
			});
		}
	);

	it('captures a recovered source and refuses a superseded incarnation during replay', async () => {
		const { database, capture, sequence } = await fixture();
		const identity = and(
			eq(schema.objectIncarnation.kind, 'nar'),
			eq(schema.objectIncarnation.objectId, sharedNarSource(0).narHash)
		);
		await database
			.update(schema.objectIncarnation)
			.set({ incarnation: 3, state: 'pending' })
			.where(identity);
		await database.update(schema.blobState).set({ incarnation: 3 });
		await database
			.update(schema.objectIncarnation)
			.set({ state: 'live' })
			.where(identity);
		expect({
			events: await events(),
			replay: await capture.page({ after: zero, through: sequence(2) })
		}).toStrictEqual({
			events: [
				{
					id: sequence(1),
					narHash: sharedNarSource(0).narHash,
					sourceIncarnation: 2
				},
				{
					id: sequence(2),
					narHash: sharedNarSource(0).narHash,
					sourceIncarnation: 3
				}
			],
			replay: {
				kind: 'page',
				sources: [{ ...sharedNarSource(0), sourceIncarnation: 3 }],
				cursor: sequence(2),
				isComplete: true
			}
		});
	});

	it('rolls back the reference when its capture clock cannot commit', async () => {
		const { database, capture, sequence } = await fixture(0);
		const source = await storeSource(database, 0);
		await env.CUPBOARD_DB.prepare(
			"CREATE TRIGGER refuse_capture_clock BEFORE UPDATE ON nar_capture_state WHEN NEW.latest > OLD.latest BEGIN SELECT RAISE(ABORT, 'capture clock refused'); END"
		).run();
		try {
			await expect(
				database.insert(schema.blobReference).values(reference(source))
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof Error &&
					error.cause instanceof Error &&
					error.cause.message.includes('capture clock refused')
			);
			expect({
				position: await capture.position(),
				events: await events(),
				references: await database.select().from(schema.blobReference)
			}).toStrictEqual({
				position: { latest: zero, prunedThrough: zero, isReady: true },
				events: [],
				references: []
			});
		} finally {
			await env.CUPBOARD_DB.prepare('DROP TRIGGER refuse_capture_clock').run();
		}
		await database.insert(schema.blobReference).values(reference(source));
		expect(await capture.position()).toStrictEqual({
			latest: sequence(1),
			prunedThrough: zero,
			isReady: true
		});
	});

	it('replays bounded pages through a closed publication boundary', async () => {
		const { database, capture, sequence, sources } = await fixture(65);
		const through = sequence(65);
		const extra = await storeSource(database, 65);
		await database.insert(schema.blobReference).values(reference(extra, 65));
		const first = await capture.page({ after: zero, through });
		const second = await capture.page({ after: sequence(32), through });
		const last = await capture.page({ after: sequence(64), through });
		expect([first, second, last]).toStrictEqual([
			{
				kind: 'page',
				sources: sources.slice(0, 32),
				cursor: sequence(32),
				isComplete: false
			},
			{
				kind: 'page',
				sources: sources.slice(32, 64),
				cursor: sequence(64),
				isComplete: false
			},
			{
				kind: 'page',
				sources: sources.slice(64),
				cursor: through,
				isComplete: true
			}
		]);
		expect(
			await capture.page({ after: through, through: sequence(66) })
		).toStrictEqual({
			kind: 'page',
			sources: [extra],
			cursor: sequence(66),
			isComplete: true
		});
	});

	it('advances an empty candidate page and coalesces repeated captures', async () => {
		const { database, capture, sequence } = await fixture(33);
		await database
			.delete(schema.blobReference)
			.where(ne(schema.blobReference.narHash, sharedNarSource(32).narHash));
		expect(
			await capture.page({ after: zero, through: sequence(33) })
		).toStrictEqual({
			kind: 'page',
			sources: [],
			cursor: sequence(32),
			isComplete: false
		});
		await database.delete(schema.blobReference);
		await database
			.insert(schema.blobReference)
			.values(reference(sharedNarSource(32), 32));
		expect(
			await capture.page({ after: sequence(32), through: sequence(34) })
		).toStrictEqual({
			kind: 'page',
			sources: [sharedNarSource(32)],
			cursor: sequence(34),
			isComplete: true
		});
	});

	it('prunes in bounded pages without reusing sequence numbers', async () => {
		const { database, capture, sequence } = await fixture(300);
		const results = [];
		for (let index = 0; index < 3; index++) {
			results.push(await capture.pruneThrough(sequence(300)));
		}
		expect({
			results,
			position: await capture.position(),
			events: await events()
		}).toStrictEqual({
			results: [
				{
					removed: 128,
					prunedThrough: sequence(128),
					hasMore: true,
					protectedByJobs: false
				},
				{
					removed: 128,
					prunedThrough: sequence(256),
					hasMore: true,
					protectedByJobs: false
				},
				{
					removed: 44,
					prunedThrough: sequence(300),
					hasMore: false,
					protectedByJobs: false
				}
			],
			position: {
				latest: sequence(300),
				prunedThrough: sequence(300),
				isReady: true
			},
			events: []
		});
		const next = await storeSource(database, 300);
		await database.insert(schema.blobReference).values(reference(next, 300));
		expect({
			expired: await capture.page({ after: zero, through: sequence(300) }),
			next: await capture.page({
				after: sequence(300),
				through: sequence(301)
			}),
			position: await capture.position()
		}).toStrictEqual({
			expired: { kind: 'expired', prunedThrough: sequence(300) },
			next: {
				kind: 'page',
				sources: [next],
				cursor: sequence(301),
				isComplete: true
			},
			position: {
				latest: sequence(301),
				prunedThrough: sequence(300),
				isReady: true
			}
		});
	});

	it.each([3000, 6000])(
		'bounds replay and pruning with %s events and 2,000 jobs',
		async (eventCount) => {
			const { database, capture, sequence } = await fixture();
			const source = sharedNarSource(0);
			await database.run(sql`WITH RECURSIVE items(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM items WHERE i < ${eventCount})
			INSERT INTO nar_capture_event (nar_hash, source_incarnation)
			SELECT ${source.narHash}, ${source.sourceIncarnation} FROM items`);
			await database.run(sql`WITH RECURSIVE items(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM items WHERE i < 2000)
			INSERT INTO shared_listing_job (id, generator_revision, event_cursor, phase, state, created_at, updated_at)
			SELECT printf('00000000-0000-4000-8000-%012d', i), ${currentListingGeneratorRevision}, ${sequence(eventCount + 1)},
			CASE WHEN i % 2 = 0 THEN 'historical' ELSE 'catchup' END,
			CASE WHEN i % 3 = 0 THEN 'cancelled' ELSE 'running' END, ${now}, ${now} FROM items`);
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
				const replay = await capture.page({
					after: sequence(eventCount - 10),
					through: sequence(eventCount + 1)
				});
				const pruned = await capture.pruneThrough(sequence(eventCount + 1));
				expect({
					replay,
					pruned,
					statements: reads.length,
					hasBoundedReads: reads.every((read) => read <= 512)
				}).toStrictEqual({
					replay: {
						kind: 'page',
						sources: [source],
						cursor: sequence(eventCount + 1),
						isComplete: true
					},
					pruned: {
						removed: 128,
						prunedThrough: sequence(128),
						hasMore: true,
						protectedByJobs: false
					},
					statements: 5,
					hasBoundedReads: true
				});
			} finally {
				measured.mockRestore();
			}
		}
	);

	it.each(['historical', 'catchup'] as const)(
		'preserves the unread prefix of running and cancelled %s jobs',
		async (phase) => {
			const { database, capture, sequence } = await fixture(5);
			const jobs = new SharedListingJobStore(database);
			const job = await jobs.start(currentListingGeneratorRevision, now);
			await database
				.update(schema.sharedListingJob)
				.set({ phase })
				.where(eq(schema.sharedListingJob.id, job.id));
			const next = await storeSource(database, 5);
			await database.insert(schema.blobReference).values(reference(next, 5));
			const running = await capture.pruneThrough(sequence(6));
			await jobs.cancel(job, now);
			const cancelled = await capture.pruneThrough(sequence(6));
			await database.delete(schema.sharedListingJob);
			expect({
				cursor: job.eventCursor,
				running,
				cancelled,
				purged: await capture.pruneThrough(sequence(6))
			}).toStrictEqual({
				cursor: sequence(5),
				running: {
					removed: 5,
					prunedThrough: sequence(5),
					hasMore: false,
					protectedByJobs: true
				},
				cancelled: {
					removed: 0,
					prunedThrough: sequence(5),
					hasMore: false,
					protectedByJobs: true
				},
				purged: {
					removed: 1,
					prunedThrough: sequence(6),
					hasMore: false,
					protectedByJobs: false
				}
			});
		}
	);

	it('rolls back the prune floor when captured events cannot be deleted', async () => {
		const { capture, sequence } = await fixture(2);
		const before = {
			position: await capture.position(),
			events: await events()
		};
		await env.CUPBOARD_DB.prepare(
			"CREATE TRIGGER refuse_capture_delete BEFORE DELETE ON nar_capture_event BEGIN SELECT RAISE(ABORT, 'capture deletion refused'); END"
		).run();
		try {
			await expect(capture.pruneThrough(sequence(2))).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
			expect({
				position: await capture.position(),
				events: await events()
			}).toStrictEqual(before);
		} finally {
			await env.CUPBOARD_DB.prepare('DROP TRIGGER refuse_capture_delete').run();
		}
		expect(await capture.pruneThrough(sequence(2))).toStrictEqual({
			removed: 2,
			prunedThrough: sequence(2),
			hasMore: false,
			protectedByJobs: false
		});
	});

	it('refuses an unpublished boundary without changing retained events', async () => {
		const { capture, sequence } = await fixture(2);
		const before = {
			position: await capture.position(),
			events: await events()
		};
		await expect(
			capture.page({ after: zero, through: sequence(3) })
		).rejects.toBeInstanceOf(SharedFactsUnavailableError);
		await expect(capture.pruneThrough(sequence(3))).rejects.toBeInstanceOf(
			SharedFactsUnavailableError
		);
		expect({
			position: await capture.position(),
			events: await events()
		}).toStrictEqual(before);
	});

	it('refuses historical jobs and replay before capture readiness', async () => {
		const { database, capture } = await fixture(0);
		await database.update(schema.narCaptureState).set({ isReady: false });
		await expect(
			new SharedListingJobStore(database).start(
				currentListingGeneratorRevision,
				now
			)
		).rejects.toBeInstanceOf(SharedFactsUnavailableError);
		await expect(
			capture.page({ after: zero, through: zero })
		).rejects.toBeInstanceOf(SharedFactsUnavailableError);
		expect(await database.select().from(schema.sharedListingJob)).toStrictEqual(
			[]
		);
	});

	it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
		'refuses a job capture cursor outside the sequence domain: %s',
		async (cursor) => {
			const { database } = await fixture(0);
			const jobs = new SharedListingJobStore(database);
			const job = await jobs.start(currentListingGeneratorRevision, now);
			await expect(
				database.run(
					sql`UPDATE shared_listing_job SET event_cursor = ${cursor} WHERE id = ${job.id}`
				)
			).rejects.toThrow();
			expect(await jobs.find(job.id)).toStrictEqual(job);
		}
	);
});
