import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import type { SharedListingGenerationClaimResult } from '../blob/shared-listing-generation.ts';
import {
	SharedListingStageConflictError,
	sharedListingStageKey,
	type SharedListingStageReservation
} from '../blob/shared-listing-staging.ts';
import { ArtifactTooLargeError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { SharedListingGenerationStore } from './shared-listing-generation.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import { SharedListingStageStore } from './shared-listing-staging.ts';
import { SharedListingTaskStore } from './shared-listing-tasks.ts';
import { sharedNarDiscoveryFixture } from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const later = isoTimestamp(new Date('2026-01-01T00:00:30.000Z'));
const deadline = isoTimestamp(new Date('2026-01-01T00:01:00.000Z'));
const cleanupAt = isoTimestamp(
	new Date(Date.parse(now) + lateWriteTombstoneHorizonMs)
);
const expiredCleanupLeaseAt = isoTimestamp(
	new Date(Date.parse(deadline) + 30_000)
);
const cleanupLeaseAt = isoTimestamp(new Date(Date.parse(cleanupAt) + 30_000));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);
const measurement = {
	digest: sha256HexDigestSchema.parse('a'.repeat(64)),
	size: 123
};

function reserved(result: SharedListingStageReservation) {
	if (result.kind === 'unavailable') {
		throw new Error('No global stage was reserved');
	}
	return result;
}
function generationClaim(result: SharedListingGenerationClaimResult) {
	if (result.kind !== 'claimed') {
		throw new Error(`Expected computation ownership, received ${result.kind}`);
	}
	return result.claim;
}
async function fixture(count = 2) {
	const { database } = await sharedNarDiscoveryFixture(count);
	const jobs = new SharedListingJobStore(database);
	const tasks = new SharedListingTaskStore(database);
	const generation = new SharedListingGenerationStore(database);
	const job = await jobs.start(currentListingGeneratorRevision, now);
	const discovery = await jobs.claim(job, owner, now);
	if (discovery.kind !== 'claimed') {
		throw new Error('Discovery ownership was not granted');
	}
	await jobs.discover(discovery.claim);
	const rows = await database
		.select()
		.from(schema.sharedListingTask)
		.orderBy(schema.sharedListingTask.narHash);
	async function claim(index = 0) {
		const row = rows[index];
		if (row === undefined) {
			throw new Error('The discovered task is missing');
		}
		const task = await tasks.claim(
			{ job: { id: job.id, generation: job.generation }, id: row.id, owner },
			now
		);
		if (task.kind !== 'claimed') {
			throw new Error('Task ownership was not granted');
		}
		return generationClaim(await generation.claim(task.claim, now));
	}
	const store = new SharedListingStageStore(database);
	async function createStage(index = 0) {
		const computation = await claim(index);
		return reserved(await store.reserve(computation, now));
	}
	return { database, jobs, job, tasks, generation, claim, store, createStage };
}

describe('global listing staging ownership', () => {
	it('persists a reservation and replays it without extending the write or cleanup window', async () => {
		const { database, claim, store } = await fixture();
		const computation = await claim();
		const first = reserved(await store.reserve(computation, now));
		expect({
			first,
			replay: await new SharedListingStageStore(database).reserve(
				computation,
				later
			)
		}).toStrictEqual({
			first: {
				kind: 'writing',
				lease: {
					id: first.lease.id,
					key: sharedListingStageKey(first.lease.id),
					claim: computation,
					maximumBytes: maxArtifactBytes.listing,
					expiresAt: deadline,
					writeUntil: isoTimestamp(new Date('2026-01-01T00:15:00.000Z')),
					cleanupAfter: cleanupAt
				}
			},
			replay: first
		});
	});

	it('returns one stage when the same owner reserves concurrently', async () => {
		const { claim, store } = await fixture();
		const computation = await claim();
		const results = await Promise.all([
			store.reserve(computation, now),
			store.reserve(computation, now)
		]);
		expect(results).toStrictEqual([reserved(results[0]), results[0]]);
	});

	it('reserves ten independent NARs from one job without a global stage-slot limit', async () => {
		const { claim, store } = await fixture(10);
		const claims = await Promise.all(
			Array.from({ length: 10 }, (_, index) => claim(index))
		);
		const results = await Promise.all(
			claims.map((token) => store.reserve(token, now))
		);
		expect(
			results.map((result) => ({
				kind: result.kind,
				narHash:
					result.kind === 'unavailable'
						? undefined
						: result.lease.claim.task.narHash,
				keyIsGlobal:
					result.kind !== 'unavailable' &&
					result.lease.key === sharedListingStageKey(result.lease.id)
			}))
		).toStrictEqual(
			claims.map((token) => ({
				kind: 'writing',
				narHash: token.task.narHash,
				keyIsGlobal: true
			}))
		);
	});

	it('records one multipart upload and preserves a late registration for cleanup without granting ownership', async () => {
		const { claim, store } = await fixture();
		const computation = await claim();
		const stage = reserved(await store.reserve(computation, now));
		expect({
			first: await store.registerMultipart(stage.lease, 'upload-1', now),
			replay: await store.registerMultipart(stage.lease, 'upload-1', later),
			conflict: await store.registerMultipart(stage.lease, 'upload-2', later),
			late: await store.registerMultipart(stage.lease, 'upload-1', deadline)
		}).toStrictEqual({
			first: true,
			replay: true,
			conflict: false,
			late: false
		});
		const cleanup = await store.claimCleanup(stage.lease.id, owner, cleanupAt);
		expect(cleanup).toStrictEqual({
			id: stage.lease.id,
			key: stage.lease.key,
			generation: 1,
			owner,
			leaseExpiresAt: cleanupLeaseAt,
			multipartId: 'upload-1'
		});
	});

	it('records a sealed measurement idempotently and rejects conflicting bytes', async () => {
		const { createStage, store } = await fixture();
		const stage = await createStage();
		await store.registerMultipart(stage.lease, 'upload', now);
		expect({
			sealed: await store.recordSeal(stage.lease, 'upload', measurement, now),
			replay: await store.recordSeal(stage.lease, 'upload', measurement, later),
			ready: await store.ready(stage.lease, later)
		}).toStrictEqual({ sealed: true, replay: true, ready: measurement });
		const conflicting = {
			...measurement,
			digest: sha256HexDigestSchema.parse('b'.repeat(64))
		};
		await expect(
			store.recordSeal(stage.lease, 'upload', conflicting, later)
		).rejects.toBeInstanceOf(SharedListingStageConflictError);
	});

	it('rejects a conflicting seal when both requests observed an unsealed stage', async () => {
		const { createStage, store } = await fixture();
		const stage = await createStage();
		await store.registerMultipart(stage.lease, 'upload', now);
		const measurements = [
			measurement,
			{ ...measurement, digest: sha256HexDigestSchema.parse('b'.repeat(64)) }
		];
		const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const gate = Promise.withResolvers<undefined>();
		let arrivals = 0;
		const barrier = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (statements) => {
				arrivals += 1;
				if (arrivals === 2) {
					gate.resolve(undefined);
				}
				await gate.promise;
				return batch(statements);
			});
		try {
			const results = await Promise.allSettled(
				measurements.map((value) =>
					store.recordSeal(stage.lease, 'upload', value, now)
				)
			);
			const winner = results.findIndex((result) => {
				if (result.status !== 'fulfilled') {
					return false;
				}
				return result.value;
			});
			expect({
				results,
				ready: await store.ready(stage.lease, now)
			}).toStrictEqual({
				results: measurements.map((_, index) =>
					index === winner
						? { status: 'fulfilled', value: true }
						: {
								status: 'rejected',
								reason: new SharedListingStageConflictError()
							}
				),
				ready: measurements[winner]
			});
		} finally {
			barrier.mockRestore();
		}
	});

	it('rejects a measurement above the stage byte budget', async () => {
		const { createStage, store } = await fixture();
		const stage = await createStage();
		await store.registerMultipart(stage.lease, 'upload', now);
		await expect(
			store.recordSeal(
				stage.lease,
				'upload',
				{ ...measurement, size: maxArtifactBytes.listing + 1 },
				now
			)
		).rejects.toBeInstanceOf(ArtifactTooLargeError);
		expect(await store.ready(stage.lease, now)).toBeUndefined();
	});

	it('renews against computation ownership without extending the producer window', async () => {
		const { database, claim, store } = await fixture();
		const computation = await claim();
		const stage = reserved(await store.reserve(computation, now));
		const longLease = isoTimestamp(new Date('2026-01-01T00:20:00.000Z'));
		await database
			.update(schema.sharedListingTask)
			.set({ leaseExpiresAt: longLease })
			.where(eq(schema.sharedListingTask.id, computation.task.id));
		await database
			.update(schema.sharedListingGeneration)
			.set({ leaseExpiresAt: longLease })
			.where(
				eq(schema.sharedListingGeneration.narHash, computation.task.narHash)
			);
		expect({
			renewal: await store.renew(stage.lease, later),
			replay: await store.renew(stage.lease, now),
			expiredWindow: await store.renew(stage.lease, stage.lease.writeUntil)
		}).toStrictEqual({
			renewal: stage.lease.writeUntil,
			replay: stage.lease.writeUntil,
			expiredWindow: undefined
		});
	});

	it('passes sealed bytes to a replacement computation and fences the previous token', async () => {
		const { claim, generation, store } = await fixture();
		const computation = await claim();
		const original = reserved(await store.reserve(computation, now));
		await store.registerMultipart(original.lease, 'upload', now);
		await store.recordSeal(original.lease, 'upload', measurement, now);
		await generation.release(computation, now);
		const replacement = generationClaim(
			await generation.claim(computation.task, now)
		);
		const reused = await store.reserve(replacement, now);
		expect({
			reused,
			oldReady: await store.ready(original.lease, now),
			oldRetirement: await store.retire(original.lease, now)
		}).toStrictEqual({
			reused: {
				kind: 'ready',
				lease: { ...original.lease, claim: replacement },
				multipartId: 'upload',
				measurement
			},
			oldReady: undefined,
			oldRetirement: false
		});
	});

	it('recovers sealed output without allocating a stage for a missing output', async () => {
		const { database, claim, generation, store } = await fixture();
		const computation = await claim();
		const original = reserved(await store.reserve(computation, now));
		await store.registerMultipart(original.lease, 'upload', now);
		await store.recordSeal(original.lease, 'upload', measurement, now);
		await generation.release(computation, now);
		const replacement = generationClaim(
			await generation.claim(computation.task, now)
		);
		const independent = await claim(1);
		const recovered = await store.recover(replacement, now);
		const missing = await store.recover(independent, now);
		const stages = await database
			.select({ id: schema.sharedListingStage.id })
			.from(schema.sharedListingStage);
		expect({ recovered, missing, stages }).toStrictEqual({
			recovered: {
				kind: 'ready',
				lease: { ...original.lease, claim: replacement },
				multipartId: 'upload',
				measurement
			},
			missing: { kind: 'unavailable' },
			stages: [{ id: original.lease.id }]
		});
	});

	it('allocates a fresh retry key while preserving the old unsealed stage for late-write cleanup', async () => {
		const { claim, generation, store } = await fixture();
		const computation = await claim();
		const old = reserved(await store.reserve(computation, now));
		await store.registerMultipart(old.lease, 'old-upload', now);
		await generation.release(computation, now);
		const replacement = generationClaim(
			await generation.claim(computation.task, now)
		);
		const next = reserved(await store.reserve(replacement, now));
		expect({
			differentKey: old.lease.key !== next.lease.key,
			nextClaim: next.lease.claim,
			oldCleanup: await store.claimCleanup(old.lease.id, owner, cleanupAt)
		}).toStrictEqual({
			differentKey: true,
			nextClaim: replacement,
			oldCleanup: {
				id: old.lease.id,
				key: old.lease.key,
				generation: 1,
				owner,
				multipartId: 'old-upload',
				leaseExpiresAt: cleanupLeaseAt
			}
		});
	});

	it('records a late seal as retired without publishing it or extending cleanup', async () => {
		const { createStage, store } = await fixture();
		const stage = await createStage();
		await store.registerMultipart(stage.lease, 'upload', now);
		expect({
			sealed: await store.recordSeal(
				stage.lease,
				'upload',
				measurement,
				deadline
			),
			ready: await store.ready(stage.lease, deadline),
			cleanup: await store.claimCleanup(stage.lease.id, owner, deadline)
		}).toStrictEqual({
			sealed: false,
			ready: undefined,
			cleanup: {
				id: stage.lease.id,
				key: stage.lease.key,
				generation: 1,
				owner,
				leaseExpiresAt: expiredCleanupLeaseAt
			}
		});
	});

	it('revokes cancelled production while preserving its unsealed cleanup horizon', async () => {
		const { claim, jobs, job, store } = await fixture();
		const computation = await claim();
		const stage = reserved(await store.reserve(computation, now));
		await jobs.cancel(job, now);
		expect({
			reserve: await store.reserve(computation, now),
			renewal: await store.renew(stage.lease, now),
			ready: await store.ready(stage.lease, now),
			earlyCleanup: await store.claimCleanup(stage.lease.id, owner, deadline),
			cleanup: await store.claimCleanup(stage.lease.id, owner, cleanupAt)
		}).toStrictEqual({
			reserve: { kind: 'unavailable' },
			renewal: undefined,
			ready: undefined,
			earlyCleanup: undefined,
			cleanup: {
				id: stage.lease.id,
				key: stage.lease.key,
				generation: 1,
				owner,
				leaseExpiresAt: cleanupLeaseAt
			}
		});
	});

	it('retains sealed recovery after lease expiry until its bounded cleanup deadline', async () => {
		const { createStage, store } = await fixture();
		const stage = await createStage();
		await store.registerMultipart(stage.lease, 'upload', now);
		await store.recordSeal(stage.lease, 'upload', measurement, now);
		expect({
			ready: await store.ready(stage.lease, deadline),
			earlyCleanup: await store.claimCleanup(stage.lease.id, owner, deadline),
			cleanup: await store.claimCleanup(stage.lease.id, owner, cleanupAt)
		}).toStrictEqual({
			ready: undefined,
			earlyCleanup: undefined,
			cleanup: {
				id: stage.lease.id,
				key: stage.lease.key,
				generation: 1,
				owner,
				leaseExpiresAt: cleanupLeaseAt
			}
		});
	});

	it('retires current sealed bytes immediately and prevents stale reservation after cleanup', async () => {
		const { claim, generation, store } = await fixture();
		const computation = await claim();
		const stage = reserved(await store.reserve(computation, now));
		await store.registerMultipart(stage.lease, 'upload', now);
		await store.recordSeal(stage.lease, 'upload', measurement, now);
		const isRetired = await store.retire(stage.lease, now);
		const isReplay = await store.retire(stage.lease, now);
		const reserve = await store.reserve(computation, now);
		const cleanup = await store.claimCleanup(stage.lease.id, owner, now);
		if (cleanup === undefined) {
			throw new Error('Sealed cleanup ownership was not granted');
		}
		const isAcknowledged = await store.acknowledgeCleanup(cleanup, now);
		expect({
			retired: isRetired,
			replay: isReplay,
			reserve,
			cleanup,
			acknowledged: isAcknowledged,
			staleReservation: await store.reserve(computation, now),
			staleRenewal: await generation.renew(computation, now)
		}).toStrictEqual({
			retired: true,
			replay: true,
			reserve: { kind: 'unavailable' },
			cleanup: {
				id: stage.lease.id,
				key: stage.lease.key,
				generation: 1,
				owner,
				leaseExpiresAt: later
			},
			acknowledged: true,
			staleReservation: { kind: 'unavailable' },
			staleRenewal: undefined
		});
	});

	it('acknowledges an older stage without revoking its replacement computation', async () => {
		const { claim, generation, store } = await fixture();
		const computation = await claim();
		const old = reserved(await store.reserve(computation, now));
		await store.registerMultipart(old.lease, 'upload', now);
		await store.recordSeal(old.lease, 'upload', measurement, now);
		await store.retire(old.lease, now);
		await generation.release(computation, now);
		const replacement = generationClaim(
			await generation.claim(computation.task, now)
		);
		const next = reserved(await store.reserve(replacement, now));
		const cleanup = await store.claimCleanup(old.lease.id, owner, now);
		if (cleanup === undefined) {
			throw new Error('Old stage cleanup ownership was not granted');
		}
		expect({
			acknowledged: await store.acknowledgeCleanup(cleanup, now),
			renewal: await generation.renew(replacement, now),
			stage: await store.reserve(replacement, now),
			oldReservation: await store.reserve(computation, now)
		}).toStrictEqual({
			acknowledged: true,
			renewal: deadline,
			stage: next,
			oldReservation: { kind: 'unavailable' }
		});
	});

	it('bounds cleanup discovery and acknowledgement with a large unrelated catalogue', async () => {
		const { database, job, createStage, store } = await fixture();
		const stage = await createStage();
		await store.registerMultipart(stage.lease, 'upload', now);
		await store.recordSeal(stage.lease, 'upload', measurement, now);
		await store.retire(stage.lease, now);
		const cleanup = await store.claimCleanup(stage.lease.id, owner, now);
		if (cleanup === undefined) {
			throw new Error('Cleanup ownership was not granted');
		}
		await database.run(sql`WITH RECURSIVE items(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM items WHERE i < 3000)
			INSERT INTO shared_listing_generation (nar_hash, generator_revision, source_incarnation, generation, job_id, job_generation, task_id, task_generation, updated_at)
			SELECT printf('sha256:%052d', 100000 + i), ${currentListingGeneratorRevision}, 2, 1, ${job.id}, 1, printf('00000000-0000-4000-8000-%012d', i), 1, ${now} FROM items`);
		await database.run(sql`WITH RECURSIVE items(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM items WHERE i < 3000)
			INSERT INTO shared_listing_stage (id, nar_hash, generator_revision, source_incarnation, computation_generation, r2_key, maximum_bytes, state, created_at, expires_at, write_until, cleanup_after, next_cleanup_at)
			SELECT printf('00000000-0000-4000-8000-%012d', i), printf('sha256:%052d', 100000 + i), ${currentListingGeneratorRevision}, 2, 1, printf('shared-artifact-staging/00000000-0000-4000-8000-%012d', i), ${maxArtifactBytes.listing}, 'pending', ${now}, ${deadline}, ${stage.lease.writeUntil}, ${cleanupAt}, ${deadline} FROM items`);
		const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const costs: { readonly read: number; readonly written: number }[] = [];
		const measured = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (statements) => {
				const results = await batch(statements);
				costs.push(
					...results.map((result) => ({
						read: result.meta.rows_read,
						written: result.meta.rows_written
					}))
				);
				return results;
			});
		try {
			const due = await store.due(now);
			const isAcknowledged = await store.acknowledgeCleanup(cleanup, now);
			expect({
				due,
				acknowledged: isAcknowledged,
				statements: costs.length,
				bounded: costs.every((cost) => cost.read <= 64 && cost.written <= 64)
			}).toStrictEqual({
				due: { stages: [], hasMore: false },
				acknowledged: true,
				statements: 3,
				bounded: true
			});
		} finally {
			measured.mockRestore();
		}
	});

	it('leases cleanup durably and fences acknowledgements after takeover or deferral', async () => {
		const { createStage, store } = await fixture();
		const stage = await createStage();
		await store.retire(stage.lease, now);
		const first = await store.claimCleanup(stage.lease.id, owner, cleanupAt);
		if (first === undefined) {
			throw new Error('Cleanup ownership was not granted');
		}
		const replay = await store.claimCleanup(stage.lease.id, owner, cleanupAt);
		const busy = await store.claimCleanup(
			stage.lease.id,
			otherOwner,
			cleanupAt
		);
		const second = await store.claimCleanup(
			stage.lease.id,
			otherOwner,
			first.leaseExpiresAt
		);
		if (second === undefined) {
			throw new Error('Expired cleanup ownership was not replaced');
		}
		const retryAt = await store.deferCleanup(second, first.leaseExpiresAt);
		const expectedRetry = isoTimestamp(
			new Date(Date.parse(first.leaseExpiresAt) + 30_000)
		);
		expect({
			replay,
			busy,
			stale: await store.acknowledgeCleanup(first, first.leaseExpiresAt),
			retryAt,
			deferredAck: await store.acknowledgeCleanup(second, first.leaseExpiresAt)
		}).toStrictEqual({
			replay: first,
			busy: undefined,
			stale: false,
			retryAt: expectedRetry,
			deferredAck: false
		});
		if (retryAt === undefined) {
			throw new Error('Cleanup was not deferred');
		}
		const final = await store.claimCleanup(stage.lease.id, owner, retryAt);
		if (final === undefined) {
			throw new Error('Deferred cleanup was not reclaimed');
		}
		expect({
			acknowledged: await store.acknowledgeCleanup(final, retryAt),
			replay: await store.acknowledgeCleanup(final, retryAt),
			due: await store.due(retryAt)
		}).toStrictEqual({
			acknowledged: true,
			replay: false,
			due: { stages: [], hasMore: false }
		});
	});

	it.each([
		{ description: 'source incarnation', values: { sourceIncarnation: 0 } },
		{
			description: 'fractional computation generation',
			values: { computationGeneration: 1.5 }
		},
		{
			description: 'unsafe cleanup generation',
			values: { cleanupGeneration: Number.MAX_SAFE_INTEGER + 1 }
		},
		{
			description: 'byte budget',
			values: { maximumBytes: maxArtifactBytes.listing + 1 }
		},
		{ description: 'incomplete seal', values: { writesSealed: true } },
		{
			description: 'unsealed ready state',
			values: { state: 'ready' as const }
		},
		{
			description: 'cleanup before retirement',
			values: { cleanupGeneration: 1, cleanupOwner: owner }
		}
	])('rejects an invalid persisted $description', async ({ values }) => {
		const { database, createStage } = await fixture();
		await createStage();
		const before = await database.select().from(schema.sharedListingStage);
		await expect(
			database.update(schema.sharedListingStage).set(values)
		).rejects.toThrow();
		expect(
			await database.select().from(schema.sharedListingStage)
		).toStrictEqual(before);
	});

	it('returns bounded cleanup pages for independent stages', async () => {
		const { createStage, store } = await fixture(10);
		const stages = await Promise.all(
			Array.from({ length: 10 }, (_, index) => createStage(index))
		);
		const ids = stages.map((stage) => stage.lease.id).toSorted(byCodeUnit);
		expect(await store.due(deadline)).toStrictEqual({
			stages: ids.slice(0, 8),
			hasMore: true
		});
		await Promise.all(
			ids.slice(0, 8).map((id) => store.claimCleanup(id, owner, deadline))
		);
		expect(await store.due(deadline)).toStrictEqual({
			stages: ids.slice(8),
			hasMore: false
		});
	});
});
