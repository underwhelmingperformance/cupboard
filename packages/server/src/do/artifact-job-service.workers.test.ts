import {
	cacheGenerationSchema,
	cacheNameSchema,
	narInfoGenerationSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type ArtifactTaskClaim,
	type ArtifactTaskClaimResult,
	artifactTaskOwnerSchema,
	type ArtifactTaskSource
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { runInDurableObject } from 'cloudflare:test';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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

import {
	type ArtifactJobDispatchResult,
	ArtifactJobDispatchService
} from './artifact-job-dispatch-service.ts';
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

function dispatchOf(result: ArtifactJobDispatchResult) {
	if (result.kind !== 'dispatch') {
		throw new Error('The fixture job was not reserved for dispatch');
	}
	return result.dispatch;
}

function seedDiscoverySources(context: ServerContext) {
	const base = context.db.select().from(schema.narInfos).get();
	if (base === undefined) {
		throw new Error('The discovery source fixture is missing');
	}
	const hashes = Array.from({ length: 40 }, (_, index) =>
		storePathHashSchema.parse(String(index + 1).padStart(32, '0'))
	);
	for (const storePathHash of hashes) {
		context.db
			.insert(schema.narInfos)
			.values({
				...base,
				storePathHash,
				storePath: storePathSchema.parse(
					`/nix/store/${storePathHash}-discovery-source`
				)
			})
			.run();
	}
	const other = context.cacheRepository.resolveOrCreate(
		{
			kind: 'named',
			name: cacheNameSchema.parse('other')
		},
		'public'
	);
	context.db
		.insert(schema.narInfos)
		.values({ ...base, cacheId: other.id })
		.run();
	return hashes;
}

describe('durable artifact task claims', () => {
	beforeEach(resetTestServer);

	it('discovers one cache in bounded pages and resumes from its durable cursor', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, source) => {
				const hashes = seedDiscoverySources(context);
				const job = await jobs.startInSection(defaultCache(), definition);
				const first = jobs.discoverListingsInSection(job);
				const firstCursor = jobs.summaryInSection(job.id)?.cursor;
				context.db
					.update(schema.narInfos)
					.set({
						generation: narInfoGenerationSchema.parse(2)
					})
					.where(eq(schema.narInfos.storePathHash, hash))
					.run();
				const restarted = new ArtifactJobService(context);
				const second = restarted.discoverListingsInSection(job);
				const tasks = context.db
					.select()
					.from(schema.artifactTasks)
					.orderBy(asc(schema.artifactTasks.sourceKey))
					.all();
				expect({
					first,
					firstCursor,
					second,
					cursor: restarted.summaryInSection(job.id)?.cursor,
					discoveryComplete: restarted.summaryInSection(job.id)
						?.discoveryComplete,
					progress: restarted.summaryInSection(job.id)?.progress,
					sources: tasks.map((task) => task.source)
				}).toStrictEqual({
					first: { discovered: 32, isComplete: false },
					firstCursor: hashes[31],
					second: { discovered: 9, isComplete: true },
					cursor: hash,
					discoveryComplete: true,
					progress: { discovered: 41, completed: 0, skipped: 0, failed: 0 },
					sources: [
						...hashes.map((storePathHash) => ({ ...source, storePathHash })),
						{ ...source, generation: 2 }
					]
				});
			})
		));

	it('refuses a stale discovery run and allows the resumed generation to scan', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, _context, _source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.cancelInSection(job.id);
				jobs.resumeInSection(job.id);
				const stale = jobs.discoverListingsInSection(job);
				const resumed = jobs.summaryInSection(job.id);
				if (resumed === undefined) {
					throw new Error('The resumed discovery job is missing');
				}
				const current = jobs.discoverListingsInSection(resumed);
				expect({
					stale,
					current,
					progress: jobs.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					stale: undefined,
					current: { discovered: 1, isComplete: true },
					progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 }
				});
			})
		));

	it('completes an empty discovery without creating tasks', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, _source) => {
				context.db.delete(schema.narInfos).run();
				const job = await jobs.startInSection(defaultCache(), definition);
				expect({
					page: jobs.discoverListingsInSection(job),
					state: jobs.summaryInSection(job.id)?.state,
					progress: jobs.summaryInSection(job.id)?.progress,
					tasks: context.db.select().from(schema.artifactTasks).all()
				}).toStrictEqual({
					page: { discovered: 0, isComplete: true },
					state: 'complete',
					progress: { discovered: 0, completed: 0, skipped: 0, failed: 0 },
					tasks: []
				});
			})
		));

	it('replays a page after enqueueing without a checkpoint without repeating its counters', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				const task = jobs.enqueueInSection(job, source);
				const restarted = new ArtifactJobService(context);
				const replay = restarted.discoverListingsInSection(job);
				const rows = context.db.select().from(schema.artifactTasks).all();
				expect({
					replay,
					tasks: rows.map((row) => ({ id: row.id, source: row.source })),
					progress: restarted.summaryInSection(job.id)?.progress
				}).toStrictEqual({
					replay: { discovered: 0, isComplete: true },
					tasks: [{ id: task, source }],
					progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 }
				});
			})
		));

	it('uses the cache and hash index for historical discovery', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, _source) => {
				seedDiscoverySources(context);
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.discoverListingsInSection(job);
				const execute = vi.spyOn(context.ctx.storage.sql, 'exec');
				let captured: readonly [string, ...unknown[]] | undefined;
				try {
					jobs.discoverListingsInSection(job);
					captured = execute.mock.calls.find(([query]) =>
						query.includes('order by "narinfo"."store_path_hash"')
					);
				} finally {
					execute.mockRestore();
				}
				if (captured === undefined) {
					throw new Error('The discovery page query was not recorded');
				}
				const [query, ...inputBindings] = captured;
				const bindings = z
					.array(z.union([z.string(), z.number()]))
					.parse(inputBindings);
				const plan = Array.from(
					context.ctx.storage.sql.exec<{ detail: string }>(
						`EXPLAIN QUERY PLAN ${query}`,
						...bindings
					),
					(row) => row.detail
				);
				expect(plan).toStrictEqual([
					'SEARCH narinfo USING INDEX sqlite_autoindex_narinfo_1 (cache_id=? AND store_path_hash>?)'
				]);
			})
		));

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

	it('persists a redispatch deadline before queue delivery and recovers after message loss', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.enqueueInSection(job, source);
				jobs.checkpointInSection(job, hash, true);
				const dispatches = new ArtifactJobDispatchService(context);
				vi.setSystemTime(new Date());
				const now = Date.now();
				const first = dispatchOf(dispatches.reserveInSection());
				expect({
					first,
					nextAt: dispatches.nextAtInSection(),
					duplicate: dispatches.reserveInSection()
				}).toStrictEqual({
					first: {
						job: { id: job.id, generation: job.generation },
						artifactKind: 'listing',
						revision: 1,
						notBefore: now + 900_000
					},
					nextAt: now + 900_000,
					duplicate: { kind: 'idle' }
				});
				vi.setSystemTime(new Date(first.notBefore));
				expect(dispatches.reserveInSection()).toStrictEqual({
					kind: 'dispatch',
					dispatch: {
						...first,
						revision: 2,
						notBefore: first.notBefore + 900_000
					}
				});
			})
		));

	it('fences a failed send from a newer reservation and from a cancelled or resumed job', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				jobs.enqueueInSection(job, source);
				jobs.checkpointInSection(job, hash, true);
				const dispatches = new ArtifactJobDispatchService(context);
				const first = dispatchOf(dispatches.reserveInSection());
				vi.setSystemTime(new Date(first.notBefore));
				const second = dispatchOf(dispatches.reserveInSection());
				const isStaleSend = dispatches.retryInSection(first);
				const isFailedSend = dispatches.retryInSection(second);
				const isRepeated = dispatches.retryInSection(second);
				expect({
					staleSend: isStaleSend,
					failedSend: isFailedSend,
					repeated: isRepeated,
					nextAt: dispatches.nextAtInSection()
				}).toStrictEqual({
					staleSend: false,
					failedSend: true,
					repeated: false,
					nextAt: Date.now() + 30_000
				});
				jobs.cancelInSection(job.id);
				const cancelled = dispatches.nextAtInSection();
				jobs.resumeInSection(job.id);
				const resumed = dispatchOf(dispatches.reserveInSection());
				expect({
					cancelled,
					oldSend: dispatches.retryInSection(second),
					generation: resumed.job.generation
				}).toStrictEqual({
					cancelled: undefined,
					oldSend: false,
					generation: 3
				});
			})
		));

	it('bounds discovery during dispatch and continues the next page after a lost message', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, _source) => {
				seedDiscoverySources(context);
				const job = await jobs.startInSection(defaultCache(), definition);
				const dispatches = new ArtifactJobDispatchService(context);
				const first = dispatchOf(dispatches.reserveInSection());
				const firstSummary = jobs.summaryInSection(job.id);
				vi.setSystemTime(new Date(first.notBefore));
				dispatches.reserveInSection();
				expect({
					first: {
						discovered: firstSummary?.progress.discovered,
						discoveryComplete: firstSummary?.discoveryComplete
					},
					second: {
						discovered: jobs.summaryInSection(job.id)?.progress.discovered,
						discoveryComplete: jobs.summaryInSection(job.id)?.discoveryComplete
					}
				}).toStrictEqual({
					first: { discovered: 32, discoveryComplete: false },
					second: { discovered: 41, discoveryComplete: true }
				});
			})
		));

	it('retires a due job after its cache generation changes', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, _source) => {
				const job = await jobs.startInSection(defaultCache(), definition);
				context.db
					.update(schema.cacheIdentities)
					.set({ generation: cacheGenerationSchema.parse(2) })
					.run();
				const dispatches = new ArtifactJobDispatchService(context);
				expect({
					result: dispatches.reserveInSection(),
					nextAt: dispatches.nextAtInSection(),
					state: jobs.summaryInSection(job.id)?.state
				}).toStrictEqual({
					result: { kind: 'progressed' },
					nextAt: undefined,
					state: 'cancelled'
				});
			})
		));

	it('does not dispatch jobs which finish during empty discovery', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, _source) => {
				context.db.delete(schema.narInfos).run();
				const job = await jobs.startInSection(defaultCache(), definition);
				const dispatches = new ArtifactJobDispatchService(context);
				expect({
					result: dispatches.reserveInSection(),
					nextAt: dispatches.nextAtInSection(),
					state: jobs.summaryInSection(job.id)?.state
				}).toStrictEqual({
					result: { kind: 'progressed' },
					nextAt: undefined,
					state: 'complete'
				});
			})
		));

	it.each(['wake', 'completion', 'deferral', 'resume'] as const)(
		'preserves waiting-job priority after a busy job receives $0',
		(trigger) =>
			withoutAlarmArming(() =>
				withJob(async (jobs, context, source) => {
					const base = context.db.select().from(schema.narInfos).get();
					if (base === undefined) {
						throw new Error('The fairness source fixture is missing');
					}
					const otherHash = storePathHashSchema.parse('d'.repeat(32));
					context.db
						.insert(schema.narInfos)
						.values({
							...base,
							storePathHash: otherHash,
							storePath: storePathSchema.parse(
								`/nix/store/${otherHash}-fairness-source`
							)
						})
						.run();
					const first = await jobs.startInSection(defaultCache(), definition);
					const second = await jobs.startInSection(defaultCache(), definition);
					for (const job of [first, second]) {
						jobs.enqueueInSection(job, source);
						jobs.enqueueInSection(job, { ...source, storePathHash: otherHash });
						jobs.checkpointInSection(job, hash, true);
					}
					const dispatches = new ArtifactJobDispatchService(context);
					const busy = dispatchOf(dispatches.reserveInSection());
					const waiting = busy.job.id === first.id ? second : first;
					const wakeAt = Date.now() + 1000;
					vi.setSystemTime(new Date(wakeAt));
					switch (trigger) {
						case 'wake': {
							dispatches.wakeInSection(busy.job);
							break;
						}
						case 'completion': {
							jobs.finishInSection(
								claimOf(jobs.claimInSection(busy.job.id, owner)),
								'failed'
							);
							break;
						}
						case 'deferral': {
							jobs.deferInSection(
								claimOf(jobs.claimInSection(busy.job.id, owner))
							);
							break;
						}
						case 'resume': {
							jobs.cancelInSection(busy.job.id);
							jobs.resumeInSection(busy.job.id);
							break;
						}
					}
					const resumed = jobs.summaryInSection(busy.job.id);
					if (resumed === undefined) {
						throw new Error('The busy job disappeared');
					}
					vi.setSystemTime(new Date(wakeAt + 1000));
					dispatches.wakeInSection(resumed);
					expect({
						busyAt: context.db
							.select({ at: schema.artifactJobs.nextDispatchAt })
							.from(schema.artifactJobs)
							.where(eq(schema.artifactJobs.id, busy.job.id))
							.get(),
						next: dispatchOf(dispatches.reserveInSection()).job
					}).toStrictEqual({
						busyAt: { at: wakeAt },
						next: { id: waiting.id, generation: waiting.generation }
					});
				})
			)
	);

	it('starts a new job with its actual dispatch age', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context) => {
				const now = Date.now();
				const first = await jobs.startInSection(defaultCache(), definition);
				vi.setSystemTime(new Date(now + 1000));
				const second = await jobs.startInSection(defaultCache(), definition);
				const rows = context.db
					.select({
						id: schema.artifactJobs.id,
						at: schema.artifactJobs.nextDispatchAt
					})
					.from(schema.artifactJobs)
					.orderBy(schema.artifactJobs.nextDispatchAt, schema.artifactJobs.id)
					.all();
				expect(rows).toStrictEqual([
					{ id: first.id, at: now },
					{ id: second.id, at: now + 1000 }
				]);
			})
		));

	it('reserves other due jobs before retrying an unfinished job', () =>
		withoutAlarmArming(() =>
			withJob(async (jobs, context, source) => {
				const first = await jobs.startInSection(defaultCache(), definition);
				const second = await jobs.startInSection(defaultCache(), definition);
				for (const job of [first, second]) {
					jobs.enqueueInSection(job, source);
					jobs.checkpointInSection(job, hash, true);
				}
				const dispatches = new ArtifactJobDispatchService(context);
				const dispatched = [
					dispatchOf(dispatches.reserveInSection()).job.id,
					dispatchOf(dispatches.reserveInSection()).job.id
				];
				expect({
					ids: dispatched.toSorted(byCodeUnit),
					next: dispatches.reserveInSection()
				}).toStrictEqual({
					ids: [first.id, second.id].toSorted(byCodeUnit),
					next: { kind: 'idle' }
				});
			})
		));

	it.each([
		{
			operation: 'next',
			expected:
				'SEARCH artifact_job USING COVERING INDEX artifact_job_dispatch_idx (state=?)'
		},
		{
			operation: 'reserve',
			expected:
				'SEARCH artifact_job USING INDEX artifact_job_dispatch_idx (state=?)'
		}
	])(
		'uses the dispatch deadline index for $operation',
		({ operation, expected }) =>
			withoutAlarmArming(() =>
				withJob(async (jobs, context, _source) => {
					await jobs.startInSection(defaultCache(), definition);
					const execute = vi.spyOn(context.ctx.storage.sql, 'exec');
					let captured: readonly [string, ...unknown[]] | undefined;
					try {
						const dispatches = new ArtifactJobDispatchService(context);
						switch (operation) {
							case 'next': {
								dispatches.nextAtInSection();
								break;
							}
							case 'reserve': {
								dispatches.reserveInSection();
								break;
							}
						}
						captured = execute.mock.calls.find(([query]) =>
							query.includes('order by "artifact_job"."next_dispatch_at"')
						);
					} finally {
						execute.mockRestore();
					}
					if (captured === undefined) {
						throw new Error('The dispatch deadline query was not recorded');
					}
					const [query, ...inputBindings] = captured;
					const bindings = z
						.array(z.union([z.string(), z.number()]))
						.parse(inputBindings);
					const plan = Array.from(
						context.ctx.storage.sql.exec<{ detail: string }>(
							`EXPLAIN QUERY PLAN ${query}`,
							...bindings
						),
						(row) => row.detail
					);
					expect(plan).toStrictEqual([expected]);
				})
			)
	);
});
