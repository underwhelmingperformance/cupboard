import {
	sha256HexDigestSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import {
	type ForwardListingSource,
	ForwardListingStageConflictError,
	type ForwardListingStageReservation
} from '../blob/forward-listing-staging.ts';
import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import { type SharedListingGenerationClaimResult } from '../blob/shared-listing-generation.ts';
import {
	sharedListingStageKey,
	type SharedListingStageReservation
} from '../blob/shared-listing-staging.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { ForwardListingStageStore } from './forward-listing-staging.ts';
import { SharedListingGenerationStore } from './shared-listing-generation.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import { SharedListingStageStore } from './shared-listing-staging.ts';
import { SharedListingTaskStore } from './shared-listing-tasks.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';
const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const later = isoTimestamp(new Date('2026-01-01T00:00:30.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const writeUntil = isoTimestamp(new Date(Date.parse(now) + 15 * 60_000));
const cleanupAfter = isoTimestamp(
	new Date(Date.parse(now) + lateWriteTombstoneHorizonMs)
);
const otherOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);
const measurement = {
	digest: sha256HexDigestSchema.parse('a'.repeat(64)),
	size: 123
};
function generationClaim(result: SharedListingGenerationClaimResult) {
	if (result.kind !== 'claimed') {
		throw new Error('Expected computation ownership');
	}
	return result.claim;
}
function reserved(result: SharedListingStageReservation) {
	if (result.kind === 'unavailable') {
		throw new Error('Expected shared stage');
	}
	return result;
}
function forward(result: ForwardListingStageReservation) {
	if (result.kind !== 'writing' && result.kind !== 'ready') {
		throw new Error('Expected provisional stage');
	}
	return result;
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

async function provisionalFixture() {
	const value = await fixture();
	await value.database.insert(schema.deploymentTransition).values({
		id: 'forward-listing-staging',
		state: 'complete',
		updatedAt: now
	});
	const source: ForwardListingSource = {
		tenant: tenantIdSchema.parse('forward-tenant'),
		uploadId: uploadIdSchema.parse('upload-one'),
		owner,
		narHash: sharedNarSource(0).narHash,
		generatorRevision: currentListingGeneratorRevision
	};
	const provisional = new ForwardListingStageStore(value.database);
	async function stage() {
		return forward(await provisional.reserve(source, now));
	}
	async function sealed() {
		const value = await stage();
		expect(
			await provisional.registerMultipart(value.lease, 'multipart-one', now)
		).toBe(true);
		expect(
			await provisional.recordSeal(
				value.lease,
				'multipart-one',
				measurement,
				now
			)
		).toBe(true);
		return value;
	}
	return { ...value, source, provisional, stage, sealed };
}

async function seedUnrelatedStages(
	database: Awaited<ReturnType<typeof fixture>>['database']
): Promise<void> {
	await database.run(sql`WITH RECURSIVE items(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM items WHERE i<25000)
   INSERT INTO forward_listing_stage (id,tenant,upload_id,owner,nar_hash,generator_revision,r2_key,maximum_bytes,state,created_at,write_until,cleanup_after,next_cleanup_at)
   SELECT printf('00000000-0000-4000-8000-%012d',i),'noise-tenant',printf('noise-%d',i),printf('00000000-0000-4000-8000-%012d',i),printf('sha256:%052d',100000+i),${currentListingGeneratorRevision},printf('shared-artifact-staging/00000000-0000-4000-8000-%012d',i),${maxArtifactBytes.listing},'pending','2026-01-02T00:00:00.000Z','2026-01-02T00:15:00.000Z','2026-01-02T01:26:00.000Z','2026-01-02T00:15:00.000Z' FROM items`);
}

describe('provisional forward listing ownership', () => {
	it('persists the native source and replays a fixed reservation without creating authority', async () => {
		const { provisional, source, database } = await provisionalFixture();
		const first = forward(await provisional.reserve(source, now));
		expect({
			first,
			replay: await new ForwardListingStageStore(database).reserve(
				source,
				later
			),
			sharedStages: await database.select().from(schema.sharedListingStage),
			facts: await database.select().from(schema.listingFact)
		}).toStrictEqual({
			first: {
				kind: 'writing',
				lease: {
					id: first.lease.id,
					key: sharedListingStageKey(first.lease.id),
					source,
					maximumBytes: maxArtifactBytes.listing,
					writeUntil,
					cleanupAfter
				}
			},
			replay: first,
			sharedStages: [],
			facts: []
		});
	});
	it.each(['expanded', 'readers-ready', 'contracted'])(
		'refuses reservation before complete readiness (%s)',
		async (state) => {
			const { database, provisional, source } = await provisionalFixture();
			await database
				.update(schema.deploymentTransition)
				.set({ state })
				.where(eq(schema.deploymentTransition.id, 'forward-listing-staging'));
			expect(await provisional.reserve(source, now)).toStrictEqual({
				kind: 'unavailable'
			});
		}
	);
	it('coalesces simultaneous native owners for the same NAR and revision', async () => {
		const { provisional, source } = await provisionalFixture();
		const results = await Promise.all([
			provisional.reserve(source, now),
			provisional.reserve(
				{
					...source,
					owner: otherOwner,
					tenant: tenantIdSchema.parse('other-forward')
				},
				now
			)
		]);
		const writing = results.find((result) => result.kind === 'writing');
		if (writing === undefined) {
			throw new Error('No native owner was admitted');
		}
		expect(
			results.toSorted((a, b) => byCodeUnit(a.kind, b.kind))
		).toStrictEqual([
			{ kind: 'busy', retryAt: writing.lease.writeUntil },
			writing
		]);
	});
	it('admits ten independent NARs without a global stage-slot cap', async () => {
		const { provisional, source } = await provisionalFixture();
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				provisional.reserve(
					{
						...source,
						uploadId: uploadIdSchema.parse(`upload-${String(index)}`),
						narHash: sharedNarSource(index).narHash
					},
					now
				)
			)
		);
		expect(results.map((value) => value.kind)).toStrictEqual(
			Array.from({ length: 10 }, () => 'writing')
		);
	});
	it('seals measured output idempotently and rejects a conflicting measurement', async () => {
		const { provisional, source, sealed } = await provisionalFixture();
		const value = await sealed();
		expect({
			seal: await provisional.recordSeal(
				value.lease,
				'multipart-one',
				measurement,
				later
			),
			replay: await provisional.reserve(source, later)
		}).toStrictEqual({
			seal: true,
			replay: {
				kind: 'ready',
				lease: value.lease,
				multipartId: 'multipart-one',
				measurement
			}
		});
		await expect(
			provisional.recordSeal(
				value.lease,
				'multipart-one',
				{ ...measurement, size: 124 },
				later
			)
		).rejects.toBeInstanceOf(ForwardListingStageConflictError);
	});
	it('keeps late multipart registration for cleanup without returning ownership', async () => {
		const { provisional, stage } = await provisionalFixture();
		const value = await stage();
		expect({
			registered: await provisional.registerMultipart(
				value.lease,
				'late-multipart',
				value.lease.writeUntil
			),
			early: await provisional.claimCleanup(
				value.lease.id,
				otherOwner,
				value.lease.writeUntil
			)
		}).toStrictEqual({ registered: false, early: undefined });
		const claim = await provisional.claimCleanup(
			value.lease.id,
			otherOwner,
			value.lease.cleanupAfter
		);
		const leaseExpiresAt = isoTimestamp(
			new Date(Date.parse(value.lease.cleanupAfter) + 30_000)
		);
		expect(claim).toStrictEqual({
			id: value.lease.id,
			key: value.lease.key,
			generation: 1,
			owner: otherOwner,
			leaseExpiresAt,
			multipartId: 'late-multipart'
		});
	});
	it('retires sealed output immediately and unsealed output after the late-write horizon', async () => {
		const { provisional, stage, source } = await provisionalFixture();
		const first = await stage();
		await provisional.registerMultipart(first.lease, 'multipart-one', now);
		await provisional.retire(first.lease, now);
		const second = forward(
			await provisional.reserve({ ...source, owner: otherOwner }, now)
		);
		await provisional.registerMultipart(second.lease, 'multipart-two', now);
		await provisional.recordSeal(
			second.lease,
			'multipart-two',
			measurement,
			now
		);
		await provisional.retire(second.lease, now);
		expect({
			first: await provisional.claimCleanup(first.lease.id, owner, now),
			second: await provisional.claimCleanup(second.lease.id, owner, now)
		}).toStrictEqual({
			first: undefined,
			second: {
				id: second.lease.id,
				key: second.lease.key,
				generation: 1,
				owner,
				leaseExpiresAt: later
			}
		});
	});
	it('rejects stale cleanup acknowledgements after lease replacement', async () => {
		const { provisional, sealed } = await provisionalFixture();
		const value = await sealed();
		await provisional.retire(value.lease, now);
		const first = await provisional.claimCleanup(value.lease.id, owner, now);
		if (first === undefined) {
			throw new Error('Expected cleanup');
		}
		const second = await provisional.claimCleanup(
			value.lease.id,
			otherOwner,
			later
		);
		if (second === undefined) {
			throw new Error('Expected replacement cleanup');
		}
		expect({
			old: await provisional.acknowledgeCleanup(first, later),
			current: await provisional.acknowledgeCleanup(second, later),
			due: await provisional.due(value.lease.cleanupAfter)
		}).toStrictEqual({
			old: false,
			current: true,
			due: { stages: [], hasMore: false }
		});
	});
	it('transfers sealed output under an authoritative computation without payload I/O', async () => {
		const { provisional, sealed, claim, database } = await provisionalFixture();
		const value = await sealed();
		const computation = await claim();
		const get = vi.spyOn(env.BLOBS, 'get');
		const put = vi.spyOn(env.BLOBS, 'put');
		try {
			const adopted = await provisional.adopt(computation, now);
			const lease = {
				id: value.lease.id,
				key: value.lease.key,
				claim: computation,
				maximumBytes: maxArtifactBytes.listing,
				expiresAt: computation.leaseExpiresAt,
				writeUntil: value.lease.writeUntil,
				cleanupAfter: value.lease.cleanupAfter
			};
			expect({
				adopted,
				replay: await provisional.adopt(computation, later),
				oldRetire: await provisional.retire(value.lease, later),
				oldRegister: await provisional.registerMultipart(
					value.lease,
					'multipart-one',
					later
				),
				oldSeal: await provisional.recordSeal(
					value.lease,
					'multipart-one',
					measurement,
					later
				),
				due: await provisional.due(value.lease.cleanupAfter),
				reads: get.mock.calls,
				writes: put.mock.calls,
				facts: await database.select().from(schema.listingFact)
			}).toStrictEqual({
				adopted: {
					kind: 'ready',
					lease,
					multipartId: 'multipart-one',
					measurement
				},
				replay: {
					kind: 'ready',
					lease,
					multipartId: 'multipart-one',
					measurement
				},
				oldRetire: false,
				oldRegister: false,
				oldSeal: false,
				due: { stages: [], hasMore: false },
				reads: [],
				writes: [],
				facts: []
			});
		} finally {
			get.mockRestore();
			put.mockRestore();
		}
	});
	it.each([
		'expired computation',
		'cancelled job',
		'unretained source',
		'replaced incarnation'
	])('refuses transfer after %s', async (failure) => {
		const { provisional, sealed, claim, database, job } =
			await provisionalFixture();
		const value = await sealed();
		const computation = await claim();
		let at = now;
		switch (failure) {
			case 'expired computation': {
				at = computation.leaseExpiresAt;
				break;
			}
			case 'cancelled job': {
				await database
					.update(schema.sharedListingJob)
					.set({ state: 'cancelled' })
					.where(eq(schema.sharedListingJob.id, job.id));
				break;
			}
			case 'unretained source': {
				await database
					.delete(schema.blobReference)
					.where(eq(schema.blobReference.narHash, value.lease.source.narHash));
				break;
			}
			case 'replaced incarnation': {
				await database
					.update(schema.objectIncarnation)
					.set({ incarnation: 3 })
					.where(
						eq(schema.objectIncarnation.objectId, value.lease.source.narHash)
					);
				break;
			}
		}
		expect({
			adopted: await provisional.adopt(computation, at),
			shared: await database.select().from(schema.sharedListingStage)
		}).toStrictEqual({ adopted: { kind: 'unavailable' }, shared: [] });
	});
	it('rolls back both sides when transfer fails within the batch', async () => {
		const { provisional, sealed, claim, database } = await provisionalFixture();
		const value = await sealed();
		const computation = await claim();
		const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const broken = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce((statements) =>
				batch([
					...statements,
					env.CUPBOARD_DB.prepare(
						'SELECT * FROM missing_forward_transfer_table'
					)
				])
			);
		try {
			await expect(provisional.adopt(computation, now)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			broken.mockRestore();
		}
		expect({
			replay: await provisional.reserve(value.lease.source, now),
			shared: await database.select().from(schema.sharedListingStage)
		}).toStrictEqual({
			replay: {
				kind: 'ready',
				lease: value.lease,
				multipartId: 'multipart-one',
				measurement
			},
			shared: []
		});
	});
	it('refuses a late seal after cleanup has claimed the unsealed stage', async () => {
		const { provisional, stage } = await provisionalFixture();
		const value = await stage();
		await provisional.registerMultipart(value.lease, 'multipart-one', now);
		const cleanup = await provisional.claimCleanup(
			value.lease.id,
			otherOwner,
			value.lease.cleanupAfter
		);
		if (cleanup === undefined) {
			throw new Error('Expected cleanup ownership');
		}
		expect({
			seal: await provisional.recordSeal(
				value.lease,
				'multipart-one',
				measurement,
				value.lease.cleanupAfter
			),
			register: await provisional.registerMultipart(
				value.lease,
				'multipart-one',
				value.lease.cleanupAfter
			),
			cleanup: await provisional.claimCleanup(
				value.lease.id,
				otherOwner,
				value.lease.cleanupAfter
			)
		}).toStrictEqual({ seal: false, register: false, cleanup });
	});
	it('persists cleanup retry progress and rejects the preceding cleanup generation', async () => {
		const { provisional, sealed } = await provisionalFixture();
		const value = await sealed();
		await provisional.retire(value.lease, now);
		const first = await provisional.claimCleanup(value.lease.id, owner, now);
		if (first === undefined) {
			throw new Error('Expected cleanup');
		}
		const retryAt = await provisional.deferCleanup(first, now);
		const second = await provisional.claimCleanup(
			value.lease.id,
			otherOwner,
			later
		);
		if (second === undefined) {
			throw new Error('Expected retry cleanup');
		}
		expect({
			retryAt,
			replay: await provisional.deferCleanup(first, later),
			old: await provisional.acknowledgeCleanup(first, later),
			current: await provisional.acknowledgeCleanup(second, later)
		}).toStrictEqual({
			retryAt: later,
			replay: undefined,
			old: false,
			current: true
		});
	});
	it('checks readiness again inside the reservation batch', async () => {
		const { provisional, source } = await provisionalFixture();
		const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const revoked = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				const result = await batch([
					env.CUPBOARD_DB.prepare(
						"UPDATE deployment_transition SET state='expanded' WHERE id='forward-listing-staging'"
					),
					...statements
				]);
				return result.slice(1);
			});
		try {
			expect(await provisional.reserve(source, now)).toStrictEqual({
				kind: 'unavailable'
			});
		} finally {
			revoked.mockRestore();
		}
	});

	it('pages cleanup with bounded indexed reads among 25,000 unrelated stages', async () => {
		const { database, provisional, source } = await provisionalFixture();
		const ids = [];
		for (let index = 0; index < 9; index += 1) {
			const reservation = await provisional.reserve(
				{
					...source,
					uploadId: uploadIdSchema.parse(`page-${String(index)}`),
					narHash: sharedNarSource(index).narHash
				},
				now
			);
			const value = forward(reservation);
			await provisional.registerMultipart(value.lease, 'multipart', now);
			await provisional.recordSeal(value.lease, 'multipart', measurement, now);
			await provisional.retire(value.lease, now);
			ids.push(value.lease.id);
		}
		await seedUnrelatedStages(database);
		const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const reads: number[] = [];
		const observed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (statements) => {
				const result = await batch(statements);
				reads.push(...result.map((value) => value.meta.rows_read));
				return result;
			});
		try {
			const first = await provisional.due(now);
			const second = await provisional.due(now, first.next);
			const ordered = ids.toSorted(byCodeUnit);
			expect({
				first,
				second,
				bounded: reads.every((value) => value <= 32),
				statements: reads.length
			}).toStrictEqual({
				first: {
					stages: ordered.slice(0, 8),
					hasMore: true,
					next: { at: now, id: ordered[7] }
				},
				second: { stages: ordered.slice(8), hasMore: false },
				bounded: true,
				statements: 2
			});
		} finally {
			observed.mockRestore();
		}
	});
	it('permits writes only before sealing for the captured unexpired native owner', async () => {
		const { provisional, stage } = await provisionalFixture();
		const value = await stage();
		const before = {
			current: await provisional.canWrite(value.lease, now),
			other: await provisional.canWrite(
				{
					...value.lease,
					source: { ...value.lease.source, owner: otherOwner }
				},
				now
			),
			expired: await provisional.canWrite(value.lease, value.lease.writeUntil)
		};
		await provisional.registerMultipart(value.lease, 'multipart-one', now);
		await provisional.recordSeal(
			value.lease,
			'multipart-one',
			measurement,
			now
		);
		expect({
			before,
			sealed: await provisional.canWrite(value.lease, now)
		}).toStrictEqual({
			before: { current: true, other: false, expired: false },
			sealed: false
		});
	});
	it('bounds reservation and transfer among 25,000 unrelated stages', async () => {
		const { database, source, claim } = await provisionalFixture();
		const computation = await claim();
		await seedUnrelatedStages(database);
		const parameters: number[] = [];
		const measured = drizzle(env.CUPBOARD_DB, {
			schema,
			logger: {
				logQuery(_query, values) {
					parameters.push(values.length);
				}
			}
		});
		const provisional = new ForwardListingStageStore(measured);
		const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const reads: number[] = [];
		const observed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (statements) => {
				const result = await batch(statements);
				reads.push(...result.map((value) => value.meta.rows_read));
				return result;
			});
		try {
			const value = forward(await provisional.reserve(source, now));
			await provisional.registerMultipart(value.lease, 'multipart', now);
			await provisional.recordSeal(value.lease, 'multipart', measurement, now);
			const adopted = await provisional.adopt(computation, now);
			expect(
				{
					reserved: value.kind,
					adopted: adopted.kind,
					readBounded: reads.every((value) => value <= 32),
					parameterBounded: parameters.every((value) => value <= 100)
				},
				JSON.stringify({ reads, parameters })
			).toStrictEqual({
				reserved: 'writing',
				adopted: 'ready',
				readBounded: true,
				parameterBounded: true
			});
		} finally {
			observed.mockRestore();
		}
	});
	it.each(['source removal', 'computation replacement'])(
		'rejects %s inside the transfer batch',
		async (failure) => {
			const { database, provisional, sealed, claim } =
				await provisionalFixture();
			const value = await sealed();
			const computation = await claim();
			const mutation =
				failure === 'source removal'
					? env.CUPBOARD_DB.prepare(
							'DELETE FROM blob_ref_storage WHERE nar_hash=?'
						).bind(value.lease.source.narHash)
					: env.CUPBOARD_DB.prepare(
							'UPDATE shared_listing_generation SET owner=? WHERE nar_hash=?'
						).bind(otherOwner, value.lease.source.narHash);
			const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const changed = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (statements) => {
					const result = await batch([mutation, ...statements]);
					return result.slice(1);
				});
			try {
				expect(await provisional.adopt(computation, now)).toStrictEqual({
					kind: 'unavailable'
				});
			} finally {
				changed.mockRestore();
			}
			expect({
				forward: await provisional.reserve(value.lease.source, now),
				shared: await database.select().from(schema.sharedListingStage)
			}).toStrictEqual({
				forward: {
					kind: 'ready',
					lease: value.lease,
					multipartId: 'multipart-one',
					measurement
				},
				shared: []
			});
		}
	);
	it('keeps cleanup ownership when collection starts before transfer', async () => {
		const { database, provisional, sealed, claim } = await provisionalFixture();
		const value = await sealed();
		const computation = await claim();
		await provisional.retire(value.lease, now);
		const cleanup = await provisional.claimCleanup(value.lease.id, owner, now);
		if (cleanup === undefined) {
			throw new Error('Expected cleanup');
		}
		expect({
			transfer: await provisional.adopt(computation, now),
			shared: await database.select().from(schema.sharedListingStage),
			cleanup: await provisional.acknowledgeCleanup(cleanup, now)
		}).toStrictEqual({
			transfer: { kind: 'unavailable' },
			shared: [],
			cleanup: true
		});
	});
});
