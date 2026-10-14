import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import {
	artifactJobGenerationSchema,
	type ArtifactJobVersion,
	artifactTaskGenerationSchema,
	type ArtifactTaskId,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { artifactStageIdSchema } from '../blob/artifact-staging.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
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
	type ArtifactAdmissionReservation,
	ArtifactAdmissionService
} from './artifact-admission-service.ts';
import { ArtifactJobService } from './artifact-job-service.ts';
import { ArtifactStagingService } from './artifact-staging-service.ts';
import type { ServerContext } from './context.ts';

const definition = {
	kind: 'listing',
	generatorRevision: currentListingGeneratorRevision
} as const;
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);
const hash = storePathHashSchema.parse('a'.repeat(32));

function admitted(result: ArtifactAdmissionReservation) {
	if (result.kind !== 'admitted') {
		throw new Error('The fixture admission was refused');
	}
	return result.admission;
}

async function withAdmissions<T>(
	run: (
		context: ServerContext,
		jobs: ArtifactJobService,
		job: ArtifactJobVersion,
		tasks: readonly ArtifactTaskId[]
	) => Promise<T> | T,
	taskCount = 3
) {
	const token = await initialise();
	const nar = await verifiableNar('artifact-admission-source');
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
	const generation = narInfoGenerationSchema.parse(
		await narInfoGeneration(hash)
	);
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.criticalSection(async () => {
			const context = instance.context;
			const base = context.db.select().from(schema.narInfos).get();
			if (base === undefined) {
				throw new Error('The admission NAR fixture is missing');
			}
			const jobs = new ArtifactJobService(context);
			const job = await jobs.startInSection(defaultCache(), definition);
			const tasks: ArtifactTaskId[] = [];
			for (let index = 1; index <= taskCount; index += 1) {
				const storePathHash = storePathHashSchema.parse(
					String(index).padStart(32, '0')
				);
				context.db
					.insert(schema.narInfos)
					.values({
						...base,
						storePathHash,
						storePath: storePathSchema.parse(
							`/nix/store/${storePathHash}-admission-source`
						)
					})
					.run();
				const id = jobs.enqueueInSection(job, {
					kind: 'nar',
					storePathHash,
					generation,
					narHash: nar.narHash
				});
				if (id === undefined) {
					throw new Error('The fixture admission task was not enqueued');
				}
				tasks.push(id);
			}
			jobs.checkpointInSection(job, undefined, true);
			return run(context, jobs, job, tasks);
		})
	);
}

function taskAt(
	tasks: readonly ArtifactTaskId[],
	index: number
): ArtifactTaskId {
	const task = tasks[index];
	if (task === undefined) {
		throw new Error('The fixture admission task is missing');
	}
	return task;
}

describe('durable artifact admission', () => {
	beforeEach(resetTestServer);

	it('requeues only the owned task and repeats the same retry admission after a lost reply', () =>
		withoutAlarmArming(() =>
			withAdmissions((context, jobs, job, tasks) => {
				const admissions = new ArtifactAdmissionService(context);
				const original = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				const claim = admissions.claimInSection(original, owner);
				if (claim === undefined) {
					throw new Error('The fixture retry task was not claimed');
				}
				context.db
					.update(schema.artifactJobs)
					.set({ nextDispatchAt: Date.now() + 1000, dispatchRevision: 7 })
					.where(eq(schema.artifactJobs.id, job.id))
					.run();
				const before = jobs.summaryInSection(job.id);
				const replacement = admitted(admissions.requeueInSection(claim));
				const repeated = new ArtifactAdmissionService(context).requeueInSection(
					claim
				);
				const after = jobs.summaryInSection(job.id);
				const next = admissions.claimInSection(replacement, otherOwner);
				expect({
					fresh: replacement.id !== original.id,
					repeated,
					progress: after,
					dispatch: context.db
						.select({
							at: schema.artifactJobs.nextDispatchAt,
							revision: schema.artifactJobs.dispatchRevision
						})
						.from(schema.artifactJobs)
						.where(eq(schema.artifactJobs.id, job.id))
						.get(),
					oldTicket: admissions.claimInSection(original, owner),
					oldCompletion: jobs.finishInSection(claim, 'completed'),
					lateRetry: admissions.requeueInSection(claim),
					claimed:
						next === undefined
							? undefined
							: { id: next.id, generation: next.generation, owner: next.owner },
					sibling: jobs.inspectDispatchTaskInSection(job, taskAt(tasks, 1))
						?.generation
				}).toStrictEqual({
					fresh: true,
					repeated: { kind: 'admitted', admission: replacement },
					progress: before,
					dispatch: { at: Date.now(), revision: 9 },
					oldTicket: undefined,
					oldCompletion: false,
					lateRetry: { kind: 'unavailable' },
					claimed: { id: claim.id, generation: 2, owner: otherOwner },
					sibling: 0
				});
			})
		));

	it('protects sealed staging for retry while every unstaged admission is occupied', () =>
		withoutAlarmArming(async () => {
			const fixture = await withAdmissions(
				async (context, _jobs, job, tasks) => {
					const admissions = new ArtifactAdmissionService(context);
					const original = admitted(
						admissions.reserveInSection(job, taskAt(tasks, 0))
					);
					const claim = admissions.claimInSection(original, owner);
					if (claim === undefined) {
						throw new Error('The fixture retry task was not claimed');
					}
					const staging = new ArtifactStagingService(context);
					const reserved = await staging.reserveInSection(claim);
					if (reserved.kind !== 'reserved') {
						throw new Error('The fixture retry stage was not reserved');
					}
					const lease = reserved.lease;
					const bytes = new TextEncoder().encode('sealed listing retry');
					const upload = await context.env.BLOBS.createMultipartUpload(
						lease.key
					);
					staging.registerMultipartInSection(lease, upload.uploadId);
					const part = await upload.uploadPart(1, bytes);
					await upload.complete([part]);
					const isSealed = await staging.sealInSection(lease, upload.uploadId, {
						digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
						size: bytes.byteLength
					});
					for (const id of tasks.slice(1, 9)) {
						admitted(admissions.reserveInSection(job, id, 'reuse'));
					}
					const replacement = admitted(admissions.requeueInSection(claim));
					const capacity = admissions.reserveInSection(
						job,
						taskAt(tasks, 9),
						'reuse'
					);
					return { claim, lease, replacement, capacity, sealed: isSealed };
				},
				10
			);
			vi.setSystemTime(new Date(Date.parse(fixture.claim.leaseExpiresAt) + 1));
			const collected = await runInDurableObject(currentServer(), (instance) =>
				new ArtifactStagingService(instance.context).collect()
			);
			const after = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(async () => {
					const context = instance.context;
					const next = new ArtifactAdmissionService(context).claimInSection(
						fixture.replacement,
						otherOwner
					);
					const reused =
						next === undefined
							? undefined
							: new ArtifactStagingService(context).reuseReadyInSection(next);
					const object = await context.env.BLOBS.get(fixture.lease.key);
					return {
						bytes: await object?.text(),
						reused:
							reused === undefined
								? undefined
								: { id: reused.id, taskGeneration: reused.claim.generation },
						progress: new ArtifactJobService(context).summaryInSection(
							fixture.claim.jobId
						)?.progress
					};
				})
			);
			expect({
				sealed: fixture.sealed,
				collected,
				capacity: fixture.capacity,
				...after
			}).toStrictEqual({
				sealed: true,
				collected: {
					removed: 0,
					pending: true,
					nextWakeAt: fixture.replacement.expiresAt
				},
				bytes: 'sealed listing retry',
				reused: { id: fixture.lease.id, taskGeneration: 2 },
				capacity: { kind: 'capacity', retryAt: fixture.replacement.expiresAt },
				progress: { discovered: 10, completed: 0, skipped: 0, failed: 0 }
			});
		}));

	it.each([
		'owner',
		'generation',
		'source',
		'cache',
		'job',
		'completed',
		'expired',
		'offboarding'
	] as const)('fences a retry after $0 changes', (change) =>
		withoutAlarmArming(() =>
			withAdmissions((context, jobs, job, tasks) => {
				const admissions = new ArtifactAdmissionService(context);
				const original = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				const owned = admissions.claimInSection(original, owner);
				if (owned === undefined) {
					throw new Error('The fixture retry task was not claimed');
				}
				const claim = { ...owned };
				switch (change) {
					case 'owner': {
						claim.owner = otherOwner;
						break;
					}
					case 'generation': {
						claim.generation = artifactTaskGenerationSchema.parse(2);
						break;
					}
					case 'source': {
						context.db
							.update(schema.narInfos)
							.set({ generation: narInfoGenerationSchema.parse(2) })
							.run();
						break;
					}
					case 'cache': {
						context.db
							.update(schema.cacheIdentities)
							.set({ generation: cacheGenerationSchema.parse(2) })
							.run();
						break;
					}
					case 'job': {
						jobs.cancelInSection(job.id);
						jobs.resumeInSection(job.id);
						break;
					}
					case 'completed': {
						jobs.finishInSection(owned, 'completed');
						break;
					}
					case 'expired': {
						vi.setSystemTime(new Date(Date.parse(claim.leaseExpiresAt)));
						break;
					}
					case 'offboarding': {
						context.offboarding = true;
						break;
					}
				}
				const before = {
					tasks: context.db.select().from(schema.artifactTasks).all(),
					admissions: context.db.select().from(schema.artifactAdmissions).all(),
					jobs: context.db.select().from(schema.artifactJobs).all()
				};
				expect({
					result: admissions.requeueInSection(claim),
					tasks: context.db.select().from(schema.artifactTasks).all(),
					admissions: context.db.select().from(schema.artifactAdmissions).all(),
					jobs: context.db.select().from(schema.artifactJobs).all()
				}).toStrictEqual({ result: { kind: 'unavailable' }, ...before });
			})
		)
	);

	it('keeps a capacity-blocked retry pending without releasing unfinished staging bytes', () =>
		withoutAlarmArming(() =>
			withAdmissions(async (context, jobs, job, tasks) => {
				const admissions = new ArtifactAdmissionService(context);
				const first = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				const claim = admissions.claimInSection(first, owner);
				if (claim === undefined) {
					throw new Error('The fixture retry task was not claimed');
				}
				const stage = await new ArtifactStagingService(
					context
				).reserveInSection(claim);
				if (stage.kind !== 'reserved') {
					throw new Error('The fixture retry stage was not reserved');
				}
				admitted(admissions.reserveInSection(job, taskAt(tasks, 1)));
				const before = context.db.select().from(schema.artifactStages).all();
				const retry = admissions.requeueInSection(claim);
				const repeated = admissions.requeueInSection(claim);
				const task = jobs.inspectDispatchTaskInSection(job, claim.id);
				expect({
					retry,
					repeated,
					task,
					stages: context.db.select().from(schema.artifactStages).all(),
					progress: jobs.summaryInSection(job.id)?.progress,
					oldCompletion: jobs.finishInSection(claim, 'completed')
				}).toStrictEqual({
					retry: { kind: 'capacity', retryAt: claim.leaseExpiresAt },
					repeated: { kind: 'capacity', retryAt: claim.leaseExpiresAt },
					task: {
						definition,
						cacheGeneration: claim.cacheGeneration,
						generation: 1,
						sourceKey: JSON.stringify(claim.source)
					},
					stages: before,
					progress: { discovered: 3, completed: 0, skipped: 0, failed: 0 },
					oldCompletion: false
				});
			})
		));

	it('rolls back claim deferral when admission persistence fails', () =>
		withoutAlarmArming(() =>
			withAdmissions((context, _jobs, job, tasks) => {
				const admissions = new ArtifactAdmissionService(context);
				const original = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				const claim = admissions.claimInSection(original, owner);
				if (claim === undefined) {
					throw new Error('The fixture retry task was not claimed');
				}
				const before = {
					tasks: context.db.select().from(schema.artifactTasks).all(),
					admissions: context.db.select().from(schema.artifactAdmissions).all(),
					jobs: context.db.select().from(schema.artifactJobs).all()
				};
				const failure = new Error('Retry admission persistence failed');
				const reserve = vi
					.spyOn(admissions, 'reserveInSection')
					.mockImplementation(() => {
						throw failure;
					});
				try {
					expect(() => admissions.requeueInSection(claim)).toThrow(failure);
				} finally {
					reserve.mockRestore();
				}
				expect({
					tasks: context.db.select().from(schema.artifactTasks).all(),
					admissions: context.db.select().from(schema.artifactAdmissions).all(),
					jobs: context.db.select().from(schema.artifactJobs).all()
				}).toStrictEqual(before);
			})
		));

	it('accounts for queued work before consumers claim it', () =>
		withoutAlarmArming(() =>
			withAdmissions((context, _jobs, job, tasks) => {
				vi.setSystemTime(new Date());
				const admissions = new ArtifactAdmissionService(context);
				const first = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				const second = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 1))
				);
				expect({
					repeated: admissions.reserveInSection(job, taskAt(tasks, 0)),
					third: admissions.reserveInSection(job, taskAt(tasks, 2)),
					stages: context.db.select().from(schema.artifactStages).all(),
					taskStates: context.db
						.select({ state: schema.artifactTasks.state })
						.from(schema.artifactTasks)
						.all()
				}).toStrictEqual({
					repeated: { kind: 'admitted', admission: first },
					third: { kind: 'capacity', retryAt: first.expiresAt },
					stages: [],
					taskStates: [
						{ state: 'pending' },
						{ state: 'pending' },
						{ state: 'pending' }
					]
				});
				expect({
					different: first.id !== second.id,
					sameJob: first.job.id === second.job.id
				}).toStrictEqual({ different: true, sameJob: true });
			})
		));

	it('lets independent consumers claim different tasks from one job and exchanges admission for staging', () =>
		withoutAlarmArming(() =>
			withAdmissions(async (context, _jobs, job, tasks) => {
				const admissions = new ArtifactAdmissionService(context);
				const first = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				const second = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 1))
				);
				const claim = admissions.claimInSection(first, owner);
				const parallel = admissions.claimInSection(second, otherOwner);
				if (claim === undefined || parallel === undefined) {
					throw new Error('The admitted tasks were not claimed');
				}
				const staged = await new ArtifactStagingService(
					context
				).reserveInSection(claim);
				expect({
					differentTasks: claim.id !== parallel.id,
					duplicate: admissions.claimInSection(second, owner),
					staged: staged.kind,
					admissionRows: context.db
						.select()
						.from(schema.artifactAdmissions)
						.all().length,
					third: admissions.reserveInSection(job, taskAt(tasks, 2)).kind
				}).toStrictEqual({
					differentTasks: true,
					duplicate: undefined,
					staged: 'reserved',
					admissionRows: 1,
					third: 'capacity'
				});
			})
		));

	it('recovers an expired queued admission without accepting its delayed message', () =>
		withoutAlarmArming(() =>
			withAdmissions((context, _jobs, job, tasks) => {
				const admissions = new ArtifactAdmissionService(context);
				const first = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				vi.setSystemTime(new Date(Date.parse(first.expiresAt)));
				const replacement = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				expect({
					replaced: first.id !== replacement.id,
					oldClaim: admissions.claimInSection(first, owner),
					currentClaim: admissions.claimInSection(replacement, owner)?.id
				}).toStrictEqual({
					replaced: true,
					oldClaim: undefined,
					currentClaim: taskAt(tasks, 0)
				});
			})
		));

	it('fences a cancelled job and admits its resumed generation', () =>
		withoutAlarmArming(() =>
			withAdmissions((context, jobs, job, tasks) => {
				const admissions = new ArtifactAdmissionService(context);
				const first = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				jobs.cancelInSection(job.id);
				jobs.resumeInSection(job.id);
				const resumed = jobs.summaryInSection(job.id);
				if (resumed === undefined) {
					throw new Error('The resumed fixture job is missing');
				}
				const replacement = admitted(
					admissions.reserveInSection(resumed, taskAt(tasks, 0))
				);
				expect({
					oldClaim: admissions.claimInSection(first, owner),
					generation: replacement.job.generation,
					rows: context.db.select().from(schema.artifactAdmissions).all().length
				}).toStrictEqual({ oldClaim: undefined, generation: 3, rows: 1 });
			})
		));

	it('allows reuse work at full staging capacity but requires capacity before writing new bytes', () =>
		withoutAlarmArming(() =>
			withAdmissions(async (context, _jobs, job, tasks) => {
				const admissions = new ArtifactAdmissionService(context);
				const first = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				const second = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 1))
				);
				const reuse = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 2), 'reuse')
				);
				const claim = admissions.claimInSection(reuse, owner);
				if (claim === undefined) {
					throw new Error('The reuse task was not admitted');
				}
				expect({
					reuse: reuse.taskId,
					stage: await new ArtifactStagingService(context).reserveInSection(
						claim
					),
					existing: [first.taskId, second.taskId]
				}).toStrictEqual({
					reuse: taskAt(tasks, 2),
					stage: { kind: 'capacity', retryAt: first.expiresAt },
					existing: [taskAt(tasks, 0), taskAt(tasks, 1)]
				});
			})
		));

	it.each(['source', 'cache', 'offboarding'] as const)(
		'releases stale admission after $0 changes',
		(change) =>
			withoutAlarmArming(() =>
				withAdmissions((context, _jobs, job, tasks) => {
					const admissions = new ArtifactAdmissionService(context);
					const first = admitted(
						admissions.reserveInSection(job, taskAt(tasks, 0))
					);
					switch (change) {
						case 'source': {
							context.db
								.update(schema.narInfos)
								.set({ generation: narInfoGenerationSchema.parse(2) })
								.run();
							break;
						}
						case 'cache': {
							context.db
								.update(schema.cacheIdentities)
								.set({ generation: cacheGenerationSchema.parse(2) })
								.run();
							break;
						}
						case 'offboarding': {
							context.offboarding = true;
							break;
						}
					}
					expect({
						claim: admissions.claimInSection(first, owner),
						capacity: admissions.stagingCapacityInSection(),
						rows: context.db.select().from(schema.artifactAdmissions).all()
					}).toStrictEqual({
						claim: undefined,
						capacity: { reservations: 0, bytes: 0, retryAt: undefined },
						rows: []
					});
				})
			)
	);

	it('keeps renewed claims admitted beyond their original deadline', () =>
		withoutAlarmArming(() =>
			withAdmissions((context, jobs, job, tasks) => {
				const admissions = new ArtifactAdmissionService(context);
				const first = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				const claim = admissions.claimInSection(first, owner);
				if (claim === undefined) {
					throw new Error('The fixture task was not claimed');
				}
				vi.setSystemTime(new Date(Date.parse(claim.leaseExpiresAt) - 1));
				const renewed = jobs.renewInSection(claim);
				vi.setSystemTime(new Date(Date.parse(claim.leaseExpiresAt) + 1));
				const retained = admissions.claimInSection(first, owner);
				expect({
					retained,
					capacity: admissions.stagingCapacityInSection(),
					rows: context.db
						.select({ expiresAt: schema.artifactAdmissions.expiresAt })
						.from(schema.artifactAdmissions)
						.all()
				}).toStrictEqual({
					retained: claim,
					capacity: {
						reservations: 1,
						bytes: 64 * 1024 * 1024,
						retryAt: renewed
					},
					rows: [{ expiresAt: renewed }]
				});
			})
		));

	it('reclaims an expired consumer without accepting its completion', () =>
		withoutAlarmArming(() =>
			withAdmissions((context, jobs, job, tasks) => {
				const admissions = new ArtifactAdmissionService(context);
				const first = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				const claim = admissions.claimInSection(first, owner);
				if (claim === undefined) {
					throw new Error('The fixture task was not claimed');
				}
				vi.setSystemTime(new Date(Date.parse(claim.leaseExpiresAt)));
				const replacement = admitted(
					admissions.reserveInSection(job, taskAt(tasks, 0))
				);
				const current = admissions.claimInSection(replacement, otherOwner);
				expect({
					replaced: first.id !== replacement.id,
					generation: current?.generation,
					stale: jobs.finishInSection(claim, 'completed')
				}).toStrictEqual({ replaced: true, generation: 2, stale: false });
			})
		));

	it.each(['job', 'cache', 'task'] as const)(
		'refuses an admission presented for another $0 without consuming it',
		(scope) =>
			withoutAlarmArming(() =>
				withAdmissions((context, _jobs, job, tasks) => {
					const admissions = new ArtifactAdmissionService(context);
					const first = admitted(
						admissions.reserveInSection(job, taskAt(tasks, 0))
					);
					const before = context.db
						.select()
						.from(schema.artifactAdmissions)
						.all();
					const wrong = { ...first };
					switch (scope) {
						case 'job': {
							wrong.job = {
								...first.job,
								generation: artifactJobGenerationSchema.parse(2)
							};
							break;
						}
						case 'cache': {
							wrong.cacheGeneration = cacheGenerationSchema.parse(2);
							break;
						}
						case 'task': {
							wrong.taskId = taskAt(tasks, 1);
							break;
						}
					}
					expect({
						claim: admissions.claimInSection(wrong, owner),
						rows: context.db.select().from(schema.artifactAdmissions).all()
					}).toStrictEqual({ claim: undefined, rows: before });
				})
			)
	);

	it.each([
		{
			operation: 'capacity',
			clause: 'order by "artifact_admission"."expires_at"',
			expected:
				'SCAN artifact_admission USING INDEX artifact_admission_expiry_idx'
		},
		{
			operation: 'stage',
			clause: '"artifact_admission"."stage_id" = ?',
			expected:
				'SEARCH artifact_admission USING INDEX artifact_admission_stage_idx (stage_id=?)'
		}
	])(
		'uses the admission index for $operation',
		({ operation, clause, expected }) =>
			withoutAlarmArming(() =>
				withAdmissions((context, _jobs, _job, _tasks) => {
					const execute = vi.spyOn(context.ctx.storage.sql, 'exec');
					let captured: readonly [string, ...unknown[]] | undefined;
					try {
						const admissions = new ArtifactAdmissionService(context);
						switch (operation) {
							case 'capacity': {
								admissions.stagingCapacityInSection();
								break;
							}
							case 'stage': {
								admissions.protectedStageDeadlineInSection(
									artifactStageIdSchema.parse(
										'00000000-0000-4000-8000-000000000099'
									)
								);
								break;
							}
						}
						captured = execute.mock.calls.find(([query]) =>
							query.includes(clause)
						);
					} finally {
						execute.mockRestore();
					}
					if (captured === undefined) {
						throw new Error('The admission query was not recorded');
					}
					const [query, ...rawBindings] = captured;
					const bindings = z
						.array(z.union([z.string(), z.number()]))
						.parse(rawBindings);
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
