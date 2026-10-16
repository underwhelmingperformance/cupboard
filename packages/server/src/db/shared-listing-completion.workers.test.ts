import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import { CasObjectStore } from '../blob/cas-object-store.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import {
	ListingFactConflictError,
	SharedFactsUnavailableError
} from '../errors.ts';
import { casObjectKey } from '../http/http.ts';

import * as schema from './d1-schema.ts';
import {
	SharedListingCompletionStore,
	SharedListingTaskOutcomeConflictError
} from './shared-listing-completion.ts';
import { SharedListingGenerationStore } from './shared-listing-generation.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import { SharedListingStageStore } from './shared-listing-staging.ts';
import { SharedListingTaskStore } from './shared-listing-tasks.ts';
import { sharedNarDiscoveryFixture } from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const later = isoTimestamp(new Date('2026-01-01T00:00:10.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
async function fixture() {
	const { database } = await sharedNarDiscoveryFixture();
	await database.insert(schema.deploymentTransition).values({
		id: 'shared-listing-completion',
		state: 'expanded',
		updatedAt: now
	});
	const jobs = new SharedListingJobStore(database);
	const tasks = new SharedListingTaskStore(database);
	const generation = new SharedListingGenerationStore(database);
	const stages = new SharedListingStageStore(database);
	const job = await jobs.start(currentListingGeneratorRevision, now);
	const discovery = await jobs.claim(job, owner, now);
	if (discovery.kind !== 'claimed') {
		throw new Error('Discovery ownership was not granted');
	}
	await jobs.discover(discovery.claim);
	const row = await database.select().from(schema.sharedListingTask).get();
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
	const computation = await generation.claim(task.claim, now);
	if (computation.kind !== 'claimed') {
		throw new Error('Computation ownership was not granted');
	}
	const claim = computation.claim;
	const stage = await stages.reserve(claim, now);
	if (stage.kind !== 'writing') {
		throw new Error('A fresh global stage is required');
	}
	const bytes = new TextEncoder().encode('canonical listing');
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
	const fact = {
		narHash: claim.task.narHash,
		generatorRevision: claim.task.generatorRevision,
		format: 1 as const,
		digest,
		size: bytes.byteLength
	};
	await stages.registerMultipart(stage.lease, 'multipart-completion', now);
	await stages.recordSeal(
		stage.lease,
		'multipart-completion',
		{ digest, size: fact.size },
		now
	);
	const incarnation = await new CasObjectStore(database, env.BLOBS).promote({
		digest,
		size: fact.size,
		bytes
	});
	return {
		database,
		bytes,
		jobs,
		job,
		tasks,
		generation,
		stages,
		claim,
		stage,
		output: {
			kind: 'generated' as const,
			fact,
			incarnation,
			stageId: stage.lease.id
		},
		store: new SharedListingCompletionStore(database)
	};
}

async function nextTask(context: Awaited<ReturnType<typeof fixture>>) {
	const { jobs, tasks, database } = context;
	const job = await jobs.start(currentListingGeneratorRevision, now);
	const discovery = await jobs.claim(job, owner, now);
	if (discovery.kind !== 'claimed') {
		throw new Error('Discovery ownership was not granted');
	}
	await jobs.discover(discovery.claim);
	const row = await database
		.select()
		.from(schema.sharedListingTask)
		.where(eq(schema.sharedListingTask.jobId, job.id))
		.get();
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
	return { job, claim: task.claim };
}

const invalidations = [
	['cancelled job', sql`UPDATE shared_listing_job SET state = 'cancelled'`],
	[
		'resumed job',
		sql`UPDATE shared_listing_job SET generation = generation + 1`
	],
	[
		'expired task',
		sql`UPDATE shared_listing_task SET lease_expires_at = ${now}`
	],
	[
		'reclaimed task',
		sql`UPDATE shared_listing_task SET claim_generation = claim_generation + 1`
	],
	[
		'different task owner',
		sql`UPDATE shared_listing_task SET claim_owner = '00000000-0000-4000-8000-000000000002'`
	],
	[
		'expired computation',
		sql`UPDATE shared_listing_generation SET lease_expires_at = ${now}`
	],
	[
		'reclaimed computation',
		sql`UPDATE shared_listing_generation SET generation = generation + 1`
	],
	[
		'released computation',
		sql`UPDATE shared_listing_generation SET owner = NULL, lease_expires_at = NULL`
	],
	['repaired NAR', sql`UPDATE blob_state SET incarnation = incarnation + 1`],
	[
		'changed NAR measurement',
		sql`UPDATE blob_state SET nar_size = nar_size + 1`
	],
	[
		'pending NAR',
		sql`UPDATE object_incarnation SET state = 'pending' WHERE kind = 'nar'`
	],
	['unretained NAR', sql`DELETE FROM blob_ref_storage`],
	[
		'repaired CAS',
		sql`UPDATE cas_object_storage SET incarnation = incarnation + 1`
	],
	[
		'changed CAS measurement',
		sql`UPDATE cas_object_storage SET size = size + 1`
	],
	[
		'pending CAS',
		sql`UPDATE object_incarnation SET state = 'pending' WHERE kind = 'cas'`
	],
	['missing CAS metadata', sql`DELETE FROM cas_object_storage`],
	[
		'unsealed stage',
		sql`UPDATE shared_listing_stage SET state = 'pending', writes_sealed = 0, digest = NULL, size = NULL`
	],
	['retired stage', sql`UPDATE shared_listing_stage SET state = 'retired'`],
	[
		'different stage computation',
		sql`UPDATE shared_listing_stage SET computation_generation = computation_generation + 1`
	],
	[
		'different stage measurement',
		sql`UPDATE shared_listing_stage SET size = size + 1`
	]
] as const;

async function snapshot(
	database: Awaited<ReturnType<typeof fixture>>['database']
) {
	return database.batch([
		database.select().from(schema.sharedListingJob),
		database.select().from(schema.sharedListingTask),
		database.select().from(schema.sharedListingGeneration),
		database.select().from(schema.sharedListingStage),
		database.select().from(schema.listingFact),
		database.select().from(schema.sharedListingOutputReference),
		database.select().from(schema.sharedListingTaskOutcome),
		database.select().from(schema.casObject)
	]);
}

describe('atomic global listing completion', () => {
	it('records a retained immutable output and increments progress while discovery continues', async () => {
		const { database, store, claim, output, jobs, job } = await fixture();
		const result = await store.complete(claim, output, now);
		const summary = await jobs.find(job.id);
		const taskRows = await database.select().from(schema.sharedListingTask);
		expect({
			kind: result.kind,
			progress: summary?.progress,
			phase: summary?.phase,
			task: taskRows.map((row) => row.state),
			facts: await database
				.select({
					digest: schema.listingFact.digest,
					size: schema.listingFact.size
				})
				.from(schema.listingFact),
			references: await database
				.select({
					digest: schema.sharedListingOutputReference.digest,
					size: schema.sharedListingOutputReference.size
				})
				.from(schema.sharedListingOutputReference)
		}).toStrictEqual({
			kind: 'recorded',
			progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
			phase: 'catchup',
			task: ['completed'],
			facts: [{ digest: output.fact.digest, size: output.fact.size }],
			references: [{ digest: output.fact.digest, size: output.fact.size }]
		});
	});
	it('recognises a committed completion after its reply is lost', async () => {
		const { store, claim, output, jobs, job } = await fixture();
		const first = await store.complete(claim, output, now);
		const replay = await store.complete(claim, output, later);
		const summary = await jobs.find(job.id);
		expect({
			first: first.kind,
			replay: replay.kind,
			progress: summary?.progress
		}).toStrictEqual({
			first: 'recorded',
			replay: 'already-recorded',
			progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 }
		});
	});
	it('does not finalise a job through a refused completion without an outcome receipt', async () => {
		const { database, store, claim, output } = await fixture();
		await database
			.update(schema.sharedListingTask)
			.set({ state: 'completed', leaseExpiresAt: sql`null` });
		await database
			.update(schema.sharedListingJob)
			.set({ phase: 'processing', completed: 1 });
		const before = await snapshot(database);
		const result = await store.complete(claim, output, now);
		expect({ result, after: await snapshot(database) }).toStrictEqual({
			result: { kind: 'unavailable' },
			after: before
		});
	});
	it.each([
		[
			'missing claim identity',
			sql`UPDATE shared_listing_task_outcome SET claim = '{}'`
		],
		[
			'missing fact measurement',
			sql`UPDATE shared_listing_task_outcome SET fact = '{}'`
		],
		[
			'missing failure reason',
			sql`UPDATE shared_listing_task_outcome SET kind = 'failed', fact = NULL, incarnation = NULL, reference_epoch = NULL, computation_generation = NULL, stage_id = NULL, reason = NULL`
		]
	])('rejects durable outcomes with %s', async (_description, corruption) => {
		const { database, store, claim, output } = await fixture();
		await store.complete(claim, output, now);
		const before = await snapshot(database);
		await expect(database.run(corruption)).rejects.toThrow();
		expect(await snapshot(database)).toStrictEqual(before);
	});

	it.each(invalidations)(
		'refuses a %s without changing completion state',
		async (_description, mutation) => {
			const { database, store, claim, output } = await fixture();
			await database.run(mutation);
			const before = await snapshot(database);
			const result = await store.complete(claim, output, now);
			expect({ result, after: await snapshot(database) }).toStrictEqual({
				result: { kind: 'unavailable' },
				after: before
			});
		}
	);

	it('rolls back retention, facts, outcomes, grace and counters if the task checkpoint fails', async () => {
		const { database, store, claim, output } = await fixture();
		await database.update(schema.casObject).set({ deleteAfter: later });
		await database.run(
			sql`CREATE TRIGGER reject_completion_checkpoint BEFORE UPDATE ON shared_listing_task WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'checkpoint refused'); END`
		);
		const before = await snapshot(database);
		try {
			await expect(store.complete(claim, output, now)).rejects.toThrow(
				SharedFactsUnavailableError
			);
			expect(await snapshot(database)).toStrictEqual(before);
		} finally {
			await database.run(sql`DROP TRIGGER reject_completion_checkpoint`);
		}
		expect(await store.complete(claim, output, now)).toMatchObject({
			kind: 'recorded'
		});
	});

	it('records concurrent duplicate completions only once', async () => {
		const { database, store, claim, output, jobs, job } = await fixture();
		const results = await Promise.all([
			store.complete(claim, output, now),
			store.complete(claim, output, now)
		]);
		const summary = await jobs.find(job.id);
		const outcomes = await database
			.select()
			.from(schema.sharedListingTaskOutcome);
		expect({
			kinds: results
				.map((result) => result.kind)
				.toSorted((left, right) => left.localeCompare(right)),
			progress: summary?.progress,
			outcomes: outcomes.map((row) => row.taskId)
		}).toStrictEqual({
			kinds: ['already-recorded', 'recorded'],
			progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
			outcomes: [claim.task.id]
		});
	});

	it('reuses a retained fact for another job without computation ownership or a NAR read', async () => {
		const context = await fixture();
		const { database, store, claim, output } = context;
		await store.complete(claim, output, now);
		const second = await nextTask(context);
		const originalGeneration = await database
			.select()
			.from(schema.sharedListingGeneration);
		const result = await store.reuse(
			second.claim,
			{ fact: output.fact, incarnation: output.incarnation },
			now
		);
		const root = await database
			.select()
			.from(schema.sharedListingOutputReference)
			.get();
		expect(result).toStrictEqual({
			kind: 'recorded',
			outcome: {
				kind: 'reused',
				computationGeneration: undefined,
				claim: second.claim,
				fact: output.fact,
				incarnation: output.incarnation,
				referenceEpoch: root?.epoch,
				completedAt: now
			}
		});
		expect(
			await database.select().from(schema.sharedListingGeneration)
		).toStrictEqual(originalGeneration);
	});

	it('requires retention as well as an immutable fact for task-only reuse', async () => {
		const { database, store, claim, output } = await fixture();
		await database
			.insert(schema.listingFact)
			.values({ ...output.fact, createdAt: now });
		const before = await snapshot(database);
		const result = await store.reuse(
			claim.task,
			{ fact: output.fact, incarnation: output.incarnation },
			now
		);
		expect({ result, after: await snapshot(database) }).toStrictEqual({
			result: { kind: 'unavailable' },
			after: before
		});
	});

	it('installs missing retention under an actual computation claim when reusing a fact', async () => {
		const { database, store, claim, output } = await fixture();
		await database
			.insert(schema.listingFact)
			.values({ ...output.fact, createdAt: now });
		const result = await store.complete(
			claim,
			{ kind: 'reused', fact: output.fact, incarnation: output.incarnation },
			now
		);
		const root = await database
			.select()
			.from(schema.sharedListingOutputReference)
			.get();
		expect(result).toStrictEqual({
			kind: 'recorded',
			outcome: {
				kind: 'reused',
				claim: claim.task,
				fact: output.fact,
				incarnation: output.incarnation,
				referenceEpoch: root?.epoch,
				computationGeneration: claim.generation,
				completedAt: now
			}
		});
	});

	it.each(['skipped', 'failed'] as const)(
		'records %s progress without requiring an available NAR',
		async (kind) => {
			const { database, store, claim, jobs, job } = await fixture();
			await database.delete(schema.blobReference);
			const result = await store.finish(
				claim.task,
				{ kind, reason: 'source-unavailable' },
				now
			);
			const repeated = await store.finish(
				claim.task,
				{ kind, reason: 'source-unavailable' },
				later
			);
			const summary = await jobs.find(job.id);
			const stages = await database
				.select({
					state: schema.sharedListingStage.state,
					at: schema.sharedListingStage.cleanupAfter
				})
				.from(schema.sharedListingStage);
			const computation = await database
				.select({
					owner: schema.sharedListingGeneration.owner,
					lease: schema.sharedListingGeneration.leaseExpiresAt
				})
				.from(schema.sharedListingGeneration);
			expect({
				result,
				repeated,
				progress: summary?.progress,
				stages,
				computation: computation.map((row) => ({
					owner: row.owner ?? undefined,
					lease: row.lease ?? undefined
				})),
				facts: await database.select().from(schema.listingFact),
				references: await database
					.select()
					.from(schema.sharedListingOutputReference)
			}).toStrictEqual({
				result: {
					kind: 'recorded',
					outcome: {
						kind,
						reason: 'source-unavailable',
						claim: claim.task,
						completedAt: now
					}
				},
				repeated: {
					kind: 'already-recorded',
					outcome: {
						kind,
						reason: 'source-unavailable',
						claim: claim.task,
						completedAt: now
					}
				},
				progress: {
					discovered: 1,
					completed: 0,
					skipped: kind === 'skipped' ? 1 : 0,
					failed: kind === 'failed' ? 1 : 0
				},
				stages: [{ state: 'retired', at: now }],
				computation: [{ owner: undefined, lease: undefined }],
				facts: [],
				references: []
			});
		}
	);

	it('preserves the late-write horizon when a failed task retires an unsealed stage', async () => {
		const { database, store, claim } = await fixture();
		await database.run(
			sql`UPDATE shared_listing_stage SET state = 'pending', writes_sealed = 0, digest = NULL, size = NULL`
		);
		const original = await database
			.select({ at: schema.sharedListingStage.cleanupAfter })
			.from(schema.sharedListingStage)
			.get();
		await store.finish(
			claim.task,
			{ kind: 'failed', reason: 'generation-failed' },
			now
		);
		const stages = await database
			.select({
				state: schema.sharedListingStage.state,
				at: schema.sharedListingStage.cleanupAfter,
				next: schema.sharedListingStage.nextCleanupAt
			})
			.from(schema.sharedListingStage);
		expect(stages).toStrictEqual([
			{ state: 'retired', at: original?.at, next: original?.at }
		]);
	});

	it('finishes a job when discovery closes after all tasks have completed', async () => {
		const { store, claim, output, jobs, job } = await fixture();
		await store.complete(claim, output, now);
		const discovery = await jobs.claim(job, owner, now);
		if (discovery.kind !== 'claimed') {
			throw new Error('Catch-up ownership was not granted');
		}
		const summary = await jobs.discover(discovery.claim);
		expect({
			state: summary?.state,
			phase: summary?.phase,
			progress: summary?.progress
		}).toStrictEqual({
			state: 'complete',
			phase: 'processing',
			progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 }
		});
	});

	it('finishes a job when the last task completes after discovery has closed', async () => {
		const { store, claim, output, jobs, job } = await fixture();
		const discovery = await jobs.claim(job, owner, now);
		if (discovery.kind !== 'claimed') {
			throw new Error('Catch-up ownership was not granted');
		}
		await jobs.discover(discovery.claim);
		await store.complete(claim, output, now);
		const summary = await jobs.find(job.id);
		expect({
			state: summary?.state,
			phase: summary?.phase,
			progress: summary?.progress
		}).toStrictEqual({
			state: 'complete',
			phase: 'processing',
			progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 }
		});
	});

	it('rejects conflicting immutable output without changing any checkpoint', async () => {
		const { database, store, claim, output } = await fixture();
		await database
			.insert(schema.listingFact)
			.values({ ...output.fact, size: output.fact.size + 1, createdAt: now });
		const before = await snapshot(database);
		await expect(store.complete(claim, output, now)).rejects.toThrow(
			ListingFactConflictError
		);
		expect(await snapshot(database)).toStrictEqual(before);
	});

	it('rejects a conflicting terminal outcome without incrementing another counter', async () => {
		const { database, store, claim, output } = await fixture();
		await store.complete(claim, output, now);
		const before = await snapshot(database);
		await expect(
			store.finish(
				claim.task,
				{ kind: 'failed', reason: 'generation-failed' },
				later
			)
		).rejects.toThrow(SharedListingTaskOutcomeConflictError);
		expect(await snapshot(database)).toStrictEqual(before);
	});

	it('does not access the new outcome table before expansion is recorded', async () => {
		const { database, store, claim, output } = await fixture();
		await database
			.delete(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'shared-listing-completion'));
		const definitions = await database.all<{ sql: string }>(
			sql`SELECT sql FROM sqlite_master WHERE tbl_name = 'shared_listing_task_outcome' AND sql IS NOT NULL ORDER BY type DESC`
		);
		await database.run(sql`DROP TABLE shared_listing_task_outcome`);
		try {
			expect(await store.complete(claim, output, now)).toStrictEqual({
				kind: 'unavailable'
			});
		} finally {
			for (const definition of definitions) {
				await database.run(sql.raw(definition.sql));
			}
		}
	});
	it('recovers an actual lost D1 batch reply without repeating the checkpoint', async () => {
		const { database, store, claim, output, jobs, job } = await fixture();
		const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const lostReply = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(batch)
			.mockImplementationOnce(async (statements) => {
				await batch(statements);
				throw new Error('The committed reply was lost');
			});
		try {
			await expect(store.complete(claim, output, now)).rejects.toThrow(
				SharedFactsUnavailableError
			);
		} finally {
			lostReply.mockRestore();
		}
		const result = await store.complete(claim, output, later);
		const summary = await jobs.find(job.id);
		const outcomes = await database
			.select()
			.from(schema.sharedListingTaskOutcome);
		expect({
			kind: result.kind,
			progress: summary?.progress,
			outcomes: outcomes.map((row) => row.taskId)
		}).toStrictEqual({
			kind: 'already-recorded',
			progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
			outcomes: [claim.task.id]
		});
	});

	it('reuses the same logical output reference after physical CAS repair', async () => {
		const context = await fixture();
		const { database, store, claim, output, bytes } = context;
		await store.complete(claim, output, now);
		const before = await database
			.select()
			.from(schema.sharedListingOutputReference);
		await env.BLOBS.delete(
			casObjectKey(output.fact.digest, output.incarnation)
		);
		const incarnation = await new CasObjectStore(database, env.BLOBS).promote(
			{ digest: output.fact.digest, size: output.fact.size, bytes },
			{ restoreMissingObject: true }
		);
		const second = await nextTask(context);
		const result = await store.reuse(
			second.claim,
			{ fact: output.fact, incarnation },
			now
		);
		expect({
			result,
			references: await database
				.select()
				.from(schema.sharedListingOutputReference)
		}).toStrictEqual({
			result: {
				kind: 'recorded',
				outcome: {
					kind: 'reused',
					computationGeneration: undefined,
					claim: second.claim,
					fact: output.fact,
					incarnation,
					referenceEpoch: before[0]?.epoch,
					completedAt: now
				}
			},
			references: before
		});
	});

	it('completes an empty job only after discovery closes', async () => {
		const { database } = await sharedNarDiscoveryFixture(0);
		await database.insert(schema.deploymentTransition).values({
			id: 'shared-listing-completion',
			state: 'expanded',
			updatedAt: now
		});
		const jobs = new SharedListingJobStore(database);
		const job = await jobs.start(currentListingGeneratorRevision, now);
		for (let page = 0; page < 2; page++) {
			const discovery = await jobs.claim(job, owner, now);
			if (discovery.kind !== 'claimed') {
				throw new Error('Discovery ownership was not granted');
			}
			await jobs.discover(discovery.claim);
		}
		const summary = await jobs.find(job.id);
		expect({
			state: summary?.state,
			phase: summary?.phase,
			progress: summary?.progress
		}).toStrictEqual({
			state: 'complete',
			phase: 'processing',
			progress: { discovered: 0, completed: 0, skipped: 0, failed: 0 }
		});
	});
	it('preserves terminal progress and captured evidence when discovery refreshes a repaired source', async () => {
		const { database, store, claim, output, jobs, job } = await fixture();
		const original = await store.complete(claim, output, now);
		const outcomes = await database
			.select()
			.from(schema.sharedListingTaskOutcome);
		await database
			.update(schema.objectIncarnation)
			.set({ incarnation: 3 })
			.where(eq(schema.objectIncarnation.kind, 'nar'));
		await database.update(schema.blobState).set({ incarnation: 3 });
		await database.run(
			sql`UPDATE nar_capture_state SET pruned_through = latest`
		);
		await database.delete(schema.narCaptureEvent);
		for (let page = 0; page < 3; page++) {
			const discovery = await jobs.claim(job, owner, now);
			if (discovery.kind !== 'claimed') {
				throw new Error('Discovery ownership was not granted');
			}
			await jobs.discover(discovery.claim);
		}
		const summary = await jobs.find(job.id);
		const tasks = await database
			.select({
				state: schema.sharedListingTask.state,
				source: schema.sharedListingTask.sourceIncarnation
			})
			.from(schema.sharedListingTask);
		const replay = await store.complete(claim, output, later);
		expect({
			state: summary?.state,
			progress: summary?.progress,
			tasks,
			outcomes: await database.select().from(schema.sharedListingTaskOutcome),
			replay
		}).toStrictEqual({
			state: 'complete',
			progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
			tasks: [{ state: 'completed', source: 3 }],
			outcomes,
			replay: { ...original, kind: 'already-recorded' }
		});
	});

	it('keeps completion reads, writes and bindings bounded with thousands of preceding outcomes', async () => {
		const { database, claim, output, job } = await fixture();
		await database.run(sql`WITH RECURSIVE items(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM items WHERE i < 2048)
   INSERT INTO shared_listing_task (id, job_id, nar_hash, source_incarnation, nar_size, file_size, discovery_page, created_at, state, claim_generation, claim_job_generation, claim_owner)
   SELECT printf('10000000-0000-4000-8000-%012d', i), ${job.id}, printf('sha256:%052d', i + 100000), 2, 200, 100, 'preceding-page', ${now}, 'skipped', 1, 1, ${owner} FROM items`);
		await database.run(sql`INSERT INTO shared_listing_task_outcome (task_id, job_id, job_generation, task_generation, owner, claim, completion_id, kind, reason, completed_at)
   SELECT id, job_id, 1, 1, claim_owner, json_set(${JSON.stringify(claim.task)}, '$.id', id, '$.narHash', nar_hash), id, 'skipped', 'source-unavailable', ${now} FROM shared_listing_task WHERE discovery_page = 'preceding-page'`);
		await database
			.update(schema.sharedListingJob)
			.set({ discovered: 2049, skipped: 2048 });
		const parameters: unknown[][] = [];
		const measured = new SharedListingCompletionStore(
			drizzle(env.CUPBOARD_DB, {
				schema,
				logger: {
					logQuery(_query, values) {
						parameters.push(values);
					}
				}
			})
		);
		const reads: number[] = [];
		const writes: number[] = [];
		const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const measurement = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (statements) => {
				const results = await batch(statements);
				reads.push(...results.map((result) => result.meta.rows_read));
				writes.push(...results.map((result) => result.meta.rows_written));
				return results;
			});
		try {
			const result = await measured.complete(claim, output, now);
			expect({
				kind: result.kind,
				reads: reads.map((value) => value <= 512),
				writes: writes.map((value) => value <= 64),
				bindings: parameters.every((values) => values.length <= 100)
			}).toStrictEqual({
				kind: 'recorded',
				reads: Array.from({ length: 11 }, () => true),
				writes: Array.from({ length: 11 }, () => true),
				bindings: true
			});
		} finally {
			measurement.mockRestore();
		}
	});
});
