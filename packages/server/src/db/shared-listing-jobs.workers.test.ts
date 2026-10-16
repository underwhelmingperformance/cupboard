import {
	artifactJobGenerationSchema,
	type ArtifactTaskOwner,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
	SharedListingDiscoveryClaim,
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
const later = isoTimestamp(new Date('2026-01-01T00:00:30.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);

function claimed(result: SharedListingDiscoveryClaimResult) {
	if (result.kind !== 'claimed') {
		throw new Error(
			`Expected a shared discovery claim, received ${result.kind}`
		);
	}
	return result.claim;
}

function expectedClaim(
	job: SharedListingJobSummary,
	claimOwner: ArtifactTaskOwner
): SharedListingDiscoveryClaim {
	return {
		job: { id: job.id, generation: job.generation },
		owner: claimOwner,
		generation: 1,
		leaseExpiresAt: deadline,
		cursor: undefined,
		eventCursor: job.eventCursor,
		phase: 'historical',
		eventThrough: undefined
	};
}

async function fixture(count = 1) {
	const { database, sources } = await sharedNarDiscoveryFixture(count);
	const store = new SharedListingJobStore(database);
	const capture = await new NarSourceCaptureStore(database).position();
	const job = await store.start(currentListingGeneratorRevision, now);
	return { database, store, job, sources, capture };
}

async function tasks() {
	return drizzle(env.CUPBOARD_DB, { schema })
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

describe('shared listing backfill jobs', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('persists a global job that another D1 client can inspect', async () => {
		const { job, capture } = await fixture();
		const other = new SharedListingJobStore(
			drizzle(env.CUPBOARD_DB, { schema })
		);
		expect(await other.find(job.id)).toStrictEqual({
			id: job.id,
			generation: artifactJobGenerationSchema.parse(1),
			generatorRevision: currentListingGeneratorRevision,
			state: 'running',
			phase: 'historical',
			cursor: undefined,
			eventCursor: capture.latest,
			eventThrough: undefined,
			progress: { discovered: 0, completed: 0, skipped: 0, failed: 0 },
			createdAt: now,
			updatedAt: now
		});
	});

	it('replays a lost claim response without extending ownership and defers another owner', async () => {
		const { store, job } = await fixture();
		const first = await store.claim(job, owner, now);
		expect({
			first,
			replay: await store.claim(job, owner, later),
			competing: await store.claim(job, otherOwner, later)
		}).toStrictEqual({
			first: {
				kind: 'claimed',
				claim: {
					job: { id: job.id, generation: job.generation },
					owner,
					generation: 1,
					leaseExpiresAt: deadline,
					cursor: undefined,
					eventCursor: job.eventCursor,
					phase: 'historical',
					eventThrough: undefined
				}
			},
			replay: first,
			competing: { kind: 'busy', retryAt: deadline }
		});
	});

	it('admits only one of two concurrent discovery owners', async () => {
		const { store, job } = await fixture();
		const results = await Promise.all([
			store.claim(job, owner, now),
			store.claim(job, otherOwner, now)
		]);
		const hasFirstClaim = results[0].kind === 'claimed';
		const winner = {
			kind: 'claimed',
			claim: expectedClaim(job, hasFirstClaim ? owner : otherOwner)
		};
		const waiting = { kind: 'busy', retryAt: deadline };
		expect(results).toStrictEqual(
			hasFirstClaim ? [winner, waiting] : [waiting, winner]
		);
	});

	it('keeps discovery claims independent across jobs', async () => {
		const { store, job } = await fixture();
		const other = await store.start(currentListingGeneratorRevision, now);
		const results = await Promise.all([
			store.claim(job, owner, now),
			store.claim(other, otherOwner, now)
		]);
		expect(results).toStrictEqual([
			{ kind: 'claimed', claim: expectedClaim(job, owner) },
			{ kind: 'claimed', claim: expectedClaim(other, otherOwner) }
		]);
	});

	it('checkpoints unique NAR tasks with its cursor and progress in bounded pages', async () => {
		const { store, job, sources } = await fixture(70);
		const pages = [];
		for (let index = 0; index < 3; index++) {
			const claim = claimed(await store.claim(job, owner, now));
			pages.push(await store.discover(claim));
		}
		expect({
			pages,
			tasks: await tasks()
		}).toStrictEqual({
			pages: [32, 64, 70].map((discovered) => ({
				...job,
				cursor: sharedNarSource(discovered - 1).narHash,
				phase: discovered === 70 ? 'catchup' : 'historical',
				eventThrough: discovered === 70 ? job.eventCursor : undefined,
				progress: { discovered, completed: 0, skipped: 0, failed: 0 }
			})),
			tasks: sources.map((source) => ({ jobId: job.id, ...source }))
		});
	});

	it('does not count an empty historical scan as a completed generation job', async () => {
		const { store, job } = await fixture(0);
		const claim = claimed(await store.claim(job, owner, now));
		expect(await store.discover(claim)).toStrictEqual({
			...job,
			phase: 'catchup',
			eventThrough: job.eventCursor
		});
	});

	it('persists cursor progress through an empty candidate page', async () => {
		const { store, job, database } = await fixture(33);
		await database
			.delete(schema.blobReference)
			.where(ne(schema.blobReference.narHash, sharedNarSource(32).narHash));
		const first = await store.discover(
			claimed(await store.claim(job, owner, now))
		);
		const second = await store.discover(
			claimed(await store.claim(job, otherOwner, now))
		);
		expect({ first, second, tasks: await tasks() }).toStrictEqual({
			first: { ...job, cursor: sharedNarSource(31).narHash },
			second: {
				...job,
				cursor: sharedNarSource(32).narHash,
				phase: 'catchup',
				eventThrough: job.eventCursor,
				progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 }
			},
			tasks: [{ jobId: job.id, ...sharedNarSource(32) }]
		});
	});

	it('counts only the inserted page when a job already has a large task catalogue', async () => {
		const { store, job, database } = await fixture(2);
		await database.run(sql`WITH RECURSIVE items(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM items WHERE i < 2000)
			INSERT INTO shared_listing_task (id, job_id, nar_hash, source_incarnation, nar_size, file_size, discovery_page, created_at)
			SELECT printf('00000000-0000-4000-8000-%012d', i), ${job.id}, printf('sha256:%052d', 100000 + i), 2, 200, 100, 'preceding-page', ${now} FROM items`);
		await database
			.update(schema.sharedListingJob)
			.set({ discovered: 2000 })
			.where(eq(schema.sharedListingJob.id, job.id));
		const claim = claimed(await store.claim(job, owner, now));
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
			const result = await store.discover(claim);
			expect({
				statements: reads.length,
				bounded: reads.every((read) => read <= 64),
				result
			}).toStrictEqual({
				statements: 2,
				bounded: true,
				result: {
					...job,
					phase: 'catchup',
					eventThrough: job.eventCursor,
					cursor: sharedNarSource(1).narHash,
					progress: { discovered: 2002, completed: 0, skipped: 0, failed: 0 }
				}
			});
		} finally {
			measured.mockRestore();
		}
	});

	it('rolls back a page if its progress counter would exceed the wire format', async () => {
		const { store, job, database } = await fixture();
		await database
			.update(schema.sharedListingJob)
			.set({ discovered: Number.MAX_SAFE_INTEGER })
			.where(eq(schema.sharedListingJob.id, job.id));
		const claim = claimed(await store.claim(job, owner, now));
		const snapshot = async () => ({
			jobs: await database.select().from(schema.sharedListingJob),
			tasks: await tasks()
		});
		const before = await snapshot();
		await expect(store.discover(claim)).rejects.toBeInstanceOf(
			SharedFactsUnavailableError
		);
		expect(await snapshot()).toStrictEqual(before);
	});

	it('renews monotonically and refuses an expired owner after takeover', async () => {
		const { store, job } = await fixture();
		const first = claimed(await store.claim(job, owner, now));
		const extended = isoTimestamp(new Date('2026-01-01T00:01:30.000Z'));
		expect([
			await store.renew(first, later),
			await store.renew(first, now)
		]).toStrictEqual([extended, extended]);
		vi.setSystemTime(extended);
		const replacement = claimed(await store.claim(job, otherOwner, extended));
		expect({
			replacement,
			renewed: await store.renew(first, extended),
			discovered: await store.discover(first),
			tasks: await tasks()
		}).toStrictEqual({
			replacement: {
				...expectedClaim(job, otherOwner),
				generation: 2,
				leaseExpiresAt: isoTimestamp(new Date('2026-01-01T00:02:30.000Z'))
			},
			renewed: undefined,
			discovered: undefined,
			tasks: []
		});
	});

	it.each(['cancel', 'resume', 'expire'] as const)(
		'fences a page when ownership changes through %s during discovery',
		async (mode) => {
			const { store, job, database } = await fixture(2);
			const claim = claimed(await store.claim(job, owner, now));
			const discovery = new SharedListingJobStore(database, {
				async page(cursor) {
					const page = await new SharedNarDiscovery(database).page(cursor);
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
			});
			const result = await discovery.discover(claim);
			const summary = await store.find(job.id);
			expect({
				result,
				tasks: await tasks(),
				summary
			}).toStrictEqual({
				result: undefined,
				tasks: [],
				summary: {
					...job,
					state: mode === 'cancel' ? 'cancelled' : 'running',
					generation:
						mode === 'resume'
							? artifactJobGenerationSchema.parse(2)
							: job.generation
				}
			});
		}
	);

	it('resumes from the checkpoint and refuses a cancellation for the previous job generation', async () => {
		const { store, job, sources } = await fixture(34);
		await store.discover(claimed(await store.claim(job, owner, now)));
		await store.cancel(job, now);
		const resumed = await store.resume(job, later);
		if (resumed === undefined) {
			throw new Error('The cancelled global job was not resumed');
		}
		vi.setSystemTime(later);
		const oldCancellation = await store.cancel(job, later);
		const last = await store.discover(
			claimed(await store.claim(resumed, otherOwner, later))
		);
		expect({ oldCancellation, last, tasks: await tasks() }).toStrictEqual({
			oldCancellation: undefined,
			last: {
				...job,
				generation: artifactJobGenerationSchema.parse(2),
				cursor: sharedNarSource(33).narHash,
				phase: 'catchup',
				eventThrough: job.eventCursor,
				progress: { discovered: 34, completed: 0, skipped: 0, failed: 0 },
				updatedAt: later
			},
			tasks: sources.map((source) => ({ jobId: job.id, ...source }))
		});
	});

	it('rolls back task insertion when the cursor checkpoint fails and permits a retry', async () => {
		const { store, job, database, sources } = await fixture(2);
		const claim = claimed(await store.claim(job, owner, now));
		const snapshot = async () => ({
			jobs: await database.select().from(schema.sharedListingJob),
			tasks: await database.select().from(schema.sharedListingTask)
		});
		const before = await snapshot();
		await env.CUPBOARD_DB.prepare(
			"CREATE TRIGGER refuse_shared_checkpoint BEFORE UPDATE ON shared_listing_job WHEN OLD.cursor IS NOT NEW.cursor BEGIN SELECT RAISE(ABORT, 'checkpoint refused'); END"
		).run();
		try {
			await expect(store.discover(claim)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
			expect(await snapshot()).toStrictEqual(before);
		} finally {
			await env.CUPBOARD_DB.prepare(
				'DROP TRIGGER refuse_shared_checkpoint'
			).run();
		}
		const result = await store.discover(claim);
		expect({ result, tasks: await tasks() }).toStrictEqual({
			result: {
				...job,
				phase: 'catchup',
				eventThrough: job.eventCursor,
				cursor: sharedNarSource(1).narHash,
				progress: { discovered: 2, completed: 0, skipped: 0, failed: 0 }
			},
			tasks: sources.map((source) => ({ jobId: job.id, ...source }))
		});
	});

	it('recovers a lost batch response without counting or inserting the page twice', async () => {
		const { store, job, sources } = await fixture(2);
		const claim = claimed(await store.claim(job, owner, now));
		const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const lostReply = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				await batch(statements);
				throw new Error('The committed reply was lost');
			});
		try {
			await expect(store.discover(claim)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			lostReply.mockRestore();
		}
		expect({
			replay: await store.discover(claim),
			summary: await store.find(job.id),
			tasks: await tasks()
		}).toStrictEqual({
			replay: undefined,
			summary: {
				...job,
				phase: 'catchup',
				eventThrough: job.eventCursor,
				cursor: sharedNarSource(1).narHash,
				progress: { discovered: 2, completed: 0, skipped: 0, failed: 0 }
			},
			tasks: sources.map((source) => ({ jobId: job.id, ...source }))
		});
	});
});
