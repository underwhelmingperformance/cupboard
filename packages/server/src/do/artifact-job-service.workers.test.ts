import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	type ArtifactTaskClaim,
	type ArtifactTaskClaimResult,
	artifactTaskOwnerSchema,
	type ArtifactTaskSource
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	commitPath,
	currentServer,
	defaultCache,
	initialise,
	narInfoGeneration,
	resetTestServer,
	uploadMetadata,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import { ArtifactJobService } from './artifact-job-service.ts';
import type { ServerContext } from './context.ts';

const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const replacementOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);
const definition = {
	kind: 'listing',
	generatorRevision: currentListingGeneratorRevision
} as const;
const hash = storePathHashSchema.parse('c'.repeat(32));

function claimOf(result: ArtifactTaskClaimResult): ArtifactTaskClaim {
	if (result.claim === undefined) {
		throw new Error('The fixture task was not claimed');
	}
	return result.claim;
}

async function withJob<T>(
	body: (
		jobs: ArtifactJobService,
		context: ServerContext,
		source: Extract<ArtifactTaskSource, { kind: 'nar' }>
	) => Promise<T>
): Promise<T> {
	const token = await initialise();
	const nar = await verifiableNar('artifact-job-source');
	await commitPath(
		token,
		uploadMetadata({
			storePathHash: hash,
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		}),
		nar
	);
	const source: Extract<ArtifactTaskSource, { kind: 'nar' }> = {
		kind: 'nar',
		storePathHash: hash,
		generation: narInfoGenerationSchema.parse(await narInfoGeneration(hash)),
		narHash: nar.narHash
	};
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.criticalSection(() =>
			body(new ArtifactJobService(instance.context), instance.context, source)
		)
	);
}

describe('durable artifact task claims', () => {
	beforeEach(resetTestServer);

	it('enqueues a source once and persists discovery progress', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				const first = jobs.enqueueInSection(job, source);
				const repeated = jobs.enqueueInSection(job, source);
				expect({
					sameTask: first === repeated,
					taskRows: context.db.select().from(schema.artifactTasks).all().length,
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					sameTask: true,
					taskRows: 1,
					progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 }
				});
			})
		));

	it('reclaims an expired lease and refuses its earlier completion', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, _context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.enqueueInSection(job, source);
				const first = claimOf(jobs.claimInSection(job.id, owner));
				vi.setSystemTime(new Date(Date.parse(first.leaseExpiresAt) + 1));
				const second = claimOf(jobs.claimInSection(job.id, replacementOwner));
				const isEarlier = jobs.finishInSection(first, 'completed');
				const isCurrent = jobs.finishInSection(second, 'completed');
				jobs.checkpointInSection(job, hash, true);
				expect({
					sameTask: first.id === second.id,
					generation: second.generation,
					earlier: isEarlier,
					current: isCurrent,
					state: jobs.summaryInSection(job.id)?.state,
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					sameTask: true,
					generation: 2,
					earlier: false,
					current: true,
					state: 'complete',
					progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 }
				});
			})
		));

	it('fences a cancelled run and resumes its work without repeating progress', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, _context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.enqueueInSection(job, source);
				const first = claimOf(jobs.claimInSection(job.id, owner));
				jobs.cancelInSection(job.id);
				const cancelled = jobs.claimInSection(job.id, replacementOwner);
				jobs.resumeInSection(job.id);
				const second = claimOf(jobs.claimInSection(job.id, replacementOwner));
				const isEarlier = jobs.finishInSection(first, 'completed');
				const isCurrent = jobs.finishInSection(second, 'completed');
				expect({
					cancelled,
					earlier: isEarlier,
					current: isCurrent,
					jobGeneration: second.jobGeneration,
					taskGeneration: second.generation,
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					cancelled: { pending: false },
					earlier: false,
					current: true,
					jobGeneration: 3,
					taskGeneration: 2,
					progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 }
				});
			})
		));

	it('refuses completion after the source publication changes and skips it on retry', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.enqueueInSection(job, source);
				const first = claimOf(jobs.claimInSection(job.id, owner));
				context.db
					.update(schema.narInfos)
					.set({ generation: narInfoGenerationSchema.parse(2) })
					.where(eq(schema.narInfos.storePathHash, hash))
					.run();
				const isCompleted = jobs.finishInSection(first, 'completed');
				vi.setSystemTime(new Date(Date.parse(first.leaseExpiresAt) + 1));
				const retry = jobs.claimInSection(job.id, replacementOwner);
				jobs.checkpointInSection(job, hash, true);
				expect({
					completed: isCompleted,
					retry,
					state: jobs.summaryInSection(job.id)?.state,
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					completed: false,
					retry: { pending: false },
					state: 'complete',
					progress: { discovered: 1, completed: 0, skipped: 1, failed: 0 }
				});
			})
		));

	it('counts a claimed outcome once and refuses an incorrect owner', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, _context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.enqueueInSection(job, source);
				const claim = claimOf(jobs.claimInSection(job.id, owner));
				const isIncorrect = jobs.finishInSection(
					{ ...claim, owner: replacementOwner },
					'failed'
				);
				const isFirst = jobs.finishInSection(claim, 'failed');
				const isRepeated = jobs.finishInSection(claim, 'failed');
				expect({
					incorrect: isIncorrect,
					first: isFirst,
					repeated: isRepeated,
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					incorrect: false,
					first: true,
					repeated: false,
					progress: { discovered: 1, completed: 0, skipped: 0, failed: 1 }
				});
			})
		));

	it('does not complete before discovery closes, and refuses new work after completion', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, _context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				const initial = jobs.summaryInSection(job.id)?.state;
				jobs.checkpointInSection(job, undefined, true);
				const appended = jobs.enqueueInSection(job, source);
				expect({
					initial,
					appended,
					state: jobs.summaryInSection(job.id)?.state,
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					initial: 'running',
					appended: undefined,
					state: 'complete',
					progress: { discovered: 0, completed: 0, skipped: 0, failed: 0 }
				});
			})
		));

	it('refuses a late claim result after the cache generation changes', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.enqueueInSection(job, source);
				const claim = claimOf(jobs.claimInSection(job.id, owner));
				context.db
					.update(schema.cacheIdentities)
					.set({ generation: cacheGenerationSchema.parse(2) })
					.run();
				expect({
					completed: jobs.finishInSection(claim, 'completed'),
					next: jobs.claimInSection(job.id, replacementOwner),
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					completed: false,
					next: { pending: false },
					progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 }
				});
			})
		));
	it('keeps a renewed claim valid beyond its original deadline and rejects changes to its source', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, _context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.enqueueInSection(job, source);
				const claim = claimOf(jobs.claimInSection(job.id, owner));
				vi.setSystemTime(new Date(Date.parse(claim.leaseExpiresAt) - 1));
				const renewed = jobs.renewInSection(claim);
				vi.setSystemTime(new Date(Date.parse(claim.leaseExpiresAt) + 1));
				const changedSource = {
					...source,
					generation: narInfoGenerationSchema.parse(2)
				};
				const isChanged = jobs.finishInSection(
					{ ...claim, source: changedSource },
					'completed'
				);
				const isCurrent = jobs.finishInSection(claim, 'completed');
				expect({
					renewed: renewed !== undefined,
					changed: isChanged,
					current: isCurrent,
					repeatedRenewal: jobs.renewInSection(claim),
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					renewed: true,
					changed: false,
					current: true,
					repeatedRenewal: undefined,
					progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 }
				});
			})
		));

	it('keeps discovery closed while pending tasks finish', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, _context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.enqueueInSection(job, source);
				jobs.checkpointInSection(job, hash, true);
				const isReopened = jobs.checkpointInSection(job, hash);
				const appended = jobs.enqueueInSection(job, source);
				const claim = claimOf(jobs.claimInSection(job.id, owner));
				jobs.finishInSection(claim, 'completed');
				expect({
					reopened: isReopened,
					appended,
					state: jobs.summaryInSection(job.id)?.state,
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					reopened: false,
					appended: undefined,
					state: 'complete',
					progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 }
				});
			})
		));

	it('refuses discovery writes from the cancelled run after resume', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, _context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.cancelInSection(job.id);
				jobs.resumeInSection(job.id);
				const staleTask = jobs.enqueueInSection(job, source);
				const isStaleCheckpoint = jobs.checkpointInSection(job, hash, true);
				expect({
					staleTask,
					staleCheckpoint: isStaleCheckpoint,
					state: jobs.summaryInSection(job.id)?.state,
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					staleTask: undefined,
					staleCheckpoint: false,
					state: 'running',
					progress: { discovered: 0, completed: 0, skipped: 0, failed: 0 }
				});
				const resumed = jobs.summaryInSection(job.id);
				if (resumed === undefined) {
					throw new Error('The resumed job is missing');
				}
				expect({
					enqueued: jobs.enqueueInSection(resumed, source) !== undefined,
					checkpointed: jobs.checkpointInSection(resumed, hash, true),
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					enqueued: true,
					checkpointed: true,
					progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 }
				});
			})
		));
});
