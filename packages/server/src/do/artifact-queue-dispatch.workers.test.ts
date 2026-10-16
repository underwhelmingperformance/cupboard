import { rootLogger } from '@cupboard/logger';
import {
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	artifactJobIdSchema,
	type ArtifactJobVersion,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env as tenantEnv } from 'cloudflare:workers';
import { and, eq, lte } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	type ArtifactQueueMessage,
	artifactQueueMessageSchema
} from '../routing/artifact-queue-message.ts';
import { executeMaintenanceQueueMessage } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitPath,
	currentServer,
	defaultCache,
	initialise,
	narInfoGeneration,
	resetTestServer,
	tenantMaintenanceFailureRow,
	testControlEnv,
	uploadMetadata,
	useTestServer,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import { ArtifactAdmissionService } from './artifact-admission-service.ts';
import { ArtifactCapacityService } from './artifact-capacity-service.ts';
import { ArtifactJobDispatchService } from './artifact-job-dispatch-service.ts';
import { ArtifactJobService } from './artifact-job-service.ts';
import { ArtifactQueueDispatchService } from './artifact-queue-dispatch-service.ts';
import { ArtifactStagingService } from './artifact-staging-service.ts';
import { type ServerContext } from './context.ts';
import { type DatabaseCost, withRequestCost } from './database-cost-meter.ts';
import { MaintenanceEligibilityService } from './maintenance-eligibility-service.ts';
import { maintenancePassCursorKey } from './server.ts';

async function inSection<T>(
	run: (context: ServerContext) => Promise<T> | T
): Promise<T> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.criticalSection(() =>
			Promise.resolve(run(instance.context))
		)
	);
}

async function fixture(jobCount = 1, taskCount = 3, shouldDiscover = false) {
	const token = await initialise();
	const nar = await verifiableNar('artifact-dispatch-source');
	const hash = storePathHashSchema.parse('a'.repeat(32));
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
	return inSection(async (context) => {
		const base = context.db.select().from(schema.narInfos).get();
		if (base === undefined) {
			throw new Error('The dispatch NAR fixture is missing');
		}
		const sources = [];
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
						`/nix/store/${storePathHash}-dispatch-source`
					)
				})
				.run();
			sources.push({
				kind: 'nar' as const,
				storePathHash,
				generation,
				narHash: nar.narHash
			});
		}
		const jobs = new ArtifactJobService(context);
		const versions: ArtifactJobVersion[] = [];
		for (let index = 0; index < jobCount; index += 1) {
			const job = await jobs.startInSection(defaultCache(), {
				kind: 'listing',
				generatorRevision: currentListingGeneratorRevision
			});
			if (!shouldDiscover) {
				for (const source of sources) {
					jobs.enqueueInSection(job, source);
				}
				jobs.checkpointInSection(job, undefined, true);
			}
			versions.push({ id: job.id, generation: job.generation });
		}
		return versions;
	});
}

function queue(
	send: (messages: readonly ArtifactQueueMessage[]) => Promise<void> | void
) {
	return {
		sendBatch: async (
			messages: Iterable<MessageSendRequest<ArtifactQueueMessage>>
		) => {
			await send(
				Array.from(messages, (message) =>
					artifactQueueMessageSchema.parse(message.body)
				)
			);
			return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
		}
	};
}

async function dispatch(
	send: (
		messages: readonly ArtifactQueueMessage[],
		context: ServerContext,
		isInsideCritical: boolean
	) => Promise<void> | void
) {
	return runInDurableObject(currentServer(), async (instance) => {
		const context = instance.context;
		let isInsideCritical = false;
		const critical = context.criticalSection.bind(context);
		const gate = vi
			.spyOn(context, 'criticalSection')
			.mockImplementation(async <T>(run: () => Promise<T>): Promise<T> => {
				isInsideCritical = true;
				try {
					return await critical(run);
				} finally {
					isInsideCritical = false;
				}
			});
		try {
			return await new ArtifactQueueDispatchService(
				context,
				queue((messages) => send(messages, context, isInsideCritical))
			).run();
		} finally {
			gate.mockRestore();
		}
	});
}

async function idleFixture() {
	const versions = await fixture(1, 1);
	const job = versions[0];
	if (job === undefined) {
		throw new Error('The wake fixture job is missing');
	}
	await inSection((context) => {
		context.db
			.update(schema.artifactJobs)
			.set({ nextDispatchAt: Date.now() + 60 * 60 * 1000 })
			.run();
	});
	for (let pass = 0; pass < 40; pass += 1) {
		await runInDurableObject(currentServer(), (instance) => instance.alarm());
	}
	vi.setSystemTime(new Date(Date.now() + 1));
	return job;
}

describe('artifact queue dispatch', () => {
	beforeEach(resetTestServer);

	it.each(['legacy', 'admitted'] as const)(
		'arms and projects the %s claim deadline',
		(mode) =>
			withoutAlarmArming(async () => {
				const job = await idleFixture();
				const admission = await inSection((context) => {
					const dispatches = new ArtifactJobDispatchService(context);
					dispatches.wakeInSection(job);
					dispatches.reserveInSection();
					const task = context.db.select().from(schema.artifactTasks).get();
					if (task === undefined) {
						throw new Error('The wake task is missing');
					}
					const reserved = new ArtifactAdmissionService(
						context
					).reserveInSection(job, task.id);
					if (reserved.kind !== 'admitted') {
						throw new Error('The wake task was not admitted');
					}
					return reserved.admission;
				});
				const after = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const alarm = vi.spyOn(instance.context.ctx.storage, 'setAlarm');
						try {
							const owner = crypto.randomUUID();
							const result =
								mode === 'legacy'
									? await instance.claimArtifactTask(job, owner, 'listing')
									: await instance.claimAdmittedArtifactTask(
											admission,
											owner,
											'listing'
										);
							if (result.kind !== 'claimed') {
								throw new Error('The wake RPC refused its claim');
							}
							const projection = await instance.context.d1
								.select()
								.from(d1Schema.tenantMaintenanceEligibility)
								.get();
							return {
								deadline: result.claim.leaseExpiresAt,
								wakes: alarm.mock.calls,
								projection: projection?.nextWakeAt
							};
						} finally {
							alarm.mockRestore();
						}
					}
				);
				expect(after).toStrictEqual({
					deadline: after.deadline,
					wakes: [[Date.parse(after.deadline)]],
					projection: after.deadline
				});
			})
	);

	it('dispatches due jobs through a bounded alarm turn', () =>
		withoutAlarmArming(async () => {
			const job = await idleFixture();
			await inSection((context) =>
				new ArtifactJobDispatchService(context).wakeInSection(job)
			);
			const after = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const sent: ArtifactQueueMessage[] = [];
					const send = vi
						.spyOn(instance.context.env.ARTIFACT_QUEUE, 'sendBatch')
						.mockImplementation((messages) => {
							sent.push(
								...Array.from(messages, (message) =>
									artifactQueueMessageSchema.parse(message.body)
								)
							);
							return Promise.resolve({
								metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } }
							});
						});
					try {
						await instance.alarm();
						return {
							pass: await instance.context.ctx.storage.get(
								maintenancePassCursorKey
							),
							jobs: sent.map((message) => message.job),
							admissions: instance.context.db
								.select()
								.from(schema.artifactAdmissions)
								.all().length
						};
					} finally {
						send.mockRestore();
					}
				}
			);
			expect(after).toStrictEqual({
				pass: 'artifact-job-dispatch',
				jobs: [job],
				admissions: 1
			});
		}));

	it('dispatches due jobs through the cron maintenance queue', async () => {
		await useTestServer(fixtureTenant);
		await withoutAlarmArming(async () => {
			const job = await idleFixture();
			expect(await currentServer().requestArtifactDispatch(job)).toBe(true);
			const projected = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const projection = await instance.context.d1
						.select()
						.from(d1Schema.tenantMaintenanceEligibility)
						.get();
					return projection?.nextWakeAt;
				}
			);
			expect(projected).toBe(new Date(0).toISOString());
			const sent = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const messages: ArtifactQueueMessage[] = [];
					const send = vi
						.spyOn(instance.context.env.ARTIFACT_QUEUE, 'sendBatch')
						.mockImplementation((batch) => {
							messages.push(
								...Array.from(batch, (message) =>
									artifactQueueMessageSchema.parse(message.body)
								)
							);
							return Promise.resolve({
								metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } }
							});
						});
					try {
						const decision = await executeMaintenanceQueueMessage(
							rootLogger(),
							Object.assign({}, tenantEnv, testControlEnv),
							new NarReadBufferPool(),
							{
								kind: 'tenant-maintenance',
								tenant: instance.context.requireTenant()
							}
						);
						expect(decision).toStrictEqual({ action: 'ack' });
						return messages.map((message) => message.job);
					} finally {
						send.mockRestore();
					}
				}
			);
			expect({
				sent,
				maintenance: await tenantMaintenanceFailureRow(
					fixtureTenant,
					'maintenance'
				)
			}).toStrictEqual({
				sent: [job],
				maintenance: {
					consecutiveFailures: 0,
					lastError: undefined,
					lastFailedAt: undefined,
					lastSuccessAt: new Date().toISOString()
				}
			});
		});
	});

	it('projects lost-alarm recovery and dispatches after tenant reactivation', () =>
		withoutAlarmArming(async () => {
			const job = await idleFixture();
			const after = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const context = instance.context;
					new ArtifactJobDispatchService(context).wakeInSection(job);
					await context.d1
						.update(d1Schema.tenant)
						.set({ status: 'suspended' })
						.where(eq(d1Schema.tenant.id, context.requireTenant()))
						.run();
					await new MaintenanceEligibilityService(context).reconcile();
					const projection = await context.d1
						.select()
						.from(d1Schema.tenantMaintenanceEligibility)
						.get();
					const sent: ArtifactQueueMessage[] = [];
					const send = vi
						.spyOn(context.env.ARTIFACT_QUEUE, 'sendBatch')
						.mockImplementation((messages) => {
							sent.push(
								...Array.from(messages, (message) =>
									artifactQueueMessageSchema.parse(message.body)
								)
							);
							return Promise.resolve({
								metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } }
							});
						});
					const alarm = vi.spyOn(context.ctx.storage, 'setAlarm');
					try {
						await instance.alarm();
						const suspended = {
							messages: sent.length,
							immediateWakes: alarm.mock.calls.filter(
								([at]) => Number(at) <= Date.now() + 30_000
							)
						};
						await context.d1
							.update(d1Schema.tenant)
							.set({ status: 'active' })
							.where(eq(d1Schema.tenant.id, context.requireTenant()))
							.run();
						await instance.alarm();
						return {
							projection: projection?.nextWakeAt,
							suspended,
							resumed: sent.map((message) => message.job)
						};
					} finally {
						send.mockRestore();
						alarm.mockRestore();
					}
				}
			);
			expect(after).toStrictEqual({
				projection: new Date(0).toISOString(),
				suspended: { messages: 0, immediateWakes: [] },
				resumed: [job]
			});
		}));

	it('bounds discovery during dispatch and continues the next page after a lost message', () =>
		withoutAlarmArming(async () => {
			const versions = await fixture(1, 40, true);
			const job = versions[0];
			if (job === undefined) {
				throw new Error('The paged dispatch fixture is missing');
			}
			const send = vi.fn<Parameters<typeof dispatch>[0]>();
			await dispatch(send);
			const first = await inSection((context) => ({
				job: new ArtifactJobService(context).summaryInSection(job.id),
				deadline: new ArtifactJobDispatchService(context).nextAtInSection()
			}));
			if (first.deadline === undefined) {
				throw new Error('The lost-message recovery deadline is missing');
			}
			vi.setSystemTime(new Date(first.deadline));
			await dispatch(send);
			const second = await inSection((context) =>
				new ArtifactJobService(context).summaryInSection(job.id)
			);
			expect({
				first: {
					discovered: first.job?.progress.discovered,
					discoveryComplete: first.job?.discoveryComplete
				},
				second: {
					discovered: second?.progress.discovered,
					discoveryComplete: second?.discoveryComplete
				}
			}).toStrictEqual({
				first: { discovered: 32, discoveryComplete: false },
				second: { discovered: 41, discoveryComplete: true }
			});
		}));

	it('does not dispatch jobs which finish during empty discovery', () =>
		withoutAlarmArming(async () => {
			const versions = await fixture(1, 0, true);
			const job = versions[0];
			if (job === undefined) {
				throw new Error('The empty discovery fixture is missing');
			}
			await inSection((context) => context.db.delete(schema.narInfos).run());
			const send = vi.fn<Parameters<typeof dispatch>[0]>();
			const result = await dispatch(send);
			const after = await inSection((context) => ({
				nextAt: new ArtifactJobDispatchService(context).nextAtInSection(),
				state: new ArtifactJobService(context).summaryInSection(job.id)?.state
			}));
			expect({ result, after, deliveries: send.mock.calls }).toStrictEqual({
				result: { selectedJobs: 0, sent: 0, failed: 0 },
				after: { nextAt: undefined, state: 'complete' },
				deliveries: []
			});
		}));

	it('reserves independent same-job tasks before sending outside the tenant critical section', () =>
		withoutAlarmArming(async () => {
			await fixture();
			const sent: ArtifactQueueMessage[] = [];
			const snapshots: unknown[] = [];
			const result = await dispatch((messages, context, isInsideCritical) => {
				snapshots.push({
					isInsideCritical,
					admissions: context.db.select().from(schema.artifactAdmissions).all()
						.length,
					stages: context.db.select().from(schema.artifactStages).all(),
					tasks: context.db
						.select({ state: schema.artifactTasks.state })
						.from(schema.artifactTasks)
						.all()
				});
				sent.push(...messages);
			});
			const claims = await inSection((context) =>
				sent.map((message) =>
					message.admission === undefined
						? undefined
						: new ArtifactAdmissionService(context).claimInSection(
								message.admission,
								artifactTaskOwnerSchema.parse(crypto.randomUUID())
							)?.id
				)
			);
			expect({
				result,
				snapshots,
				distinctTasks: new Set(claims).size,
				claimed: claims.every((claim) => claim !== undefined),
				sentKinds: sent.map((message) => message.artifactKind)
			}).toStrictEqual({
				result: { selectedJobs: 1, sent: 2, failed: 0 },
				snapshots: [
					{
						isInsideCritical: false,
						admissions: 2,
						stages: [],
						tasks: [
							{ state: 'pending' },
							{ state: 'pending' },
							{ state: 'pending' }
						]
					}
				],
				distinctTasks: 2,
				claimed: true,
				sentKinds: ['listing', 'listing']
			});
		}));

	it('distributes storage credits across due jobs before admitting another task from one job', () =>
		withoutAlarmArming(async () => {
			const jobs = await fixture(2);
			const sent: ArtifactQueueMessage[] = [];
			const result = await dispatch((messages) => {
				sent.push(...messages);
			});
			expect({
				result,
				jobs: sent.map((message) => message.job.id).toSorted(byCodeUnit),
				uniqueTasks: new Set(sent.map((message) => message.admission?.taskId))
					.size
			}).toStrictEqual({
				result: { selectedJobs: 2, sent: 2, failed: 0 },
				jobs: jobs.map((job) => job.id).toSorted(byCodeUnit),
				uniqueTasks: 2
			});
		}));

	it.each(['finish', 'defer'] as const)(
		'wakes another waiting job immediately when %s releases the last admission',
		(operation) =>
			withoutAlarmArming(async () => {
				const jobs = await fixture(3, 1);
				const initial: ArtifactQueueMessage[] = [];
				await dispatch((messages) => {
					initial.push(...messages);
				});
				const waiting = jobs.find((job) =>
					initial.every((message) => message.job.id !== job.id)
				);
				const admission = initial[0]?.admission;
				if (waiting === undefined || admission === undefined) {
					throw new Error('The capacity release fixture is missing');
				}
				const claimed = await currentServer().claimAdmittedArtifactTask(
					admission,
					crypto.randomUUID(),
					'listing'
				);
				if (claimed.kind !== 'claimed') {
					throw new Error('The capacity release fixture was not claimed');
				}
				const now = Date.now();
				const wake = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const alarm = vi.spyOn(instance.context.ctx.storage, 'setAlarm');
						try {
							if (operation === 'finish') {
								await instance.finishArtifactTask(claimed.claim, 'failed');
							} else {
								await instance.requeueArtifactTaskWithDeadline(
									claimed.claim,
									isoTimestamp(new Date(now + 60_000))
								);
							}
							const projection = await instance.context.d1
								.select()
								.from(d1Schema.tenantMaintenanceEligibility)
								.get();
							return {
								at: new ArtifactJobDispatchService(
									instance.context
								).nextAtInSection(),
								alarms: alarm.mock.calls,
								projection: projection?.nextWakeAt
							};
						} finally {
							alarm.mockRestore();
						}
					}
				);
				const sent: ArtifactQueueMessage[] = [];
				const result = await dispatch((messages) => {
					sent.push(...messages);
				});
				expect({
					wake,
					result,
					jobs: sent.map((message) => message.job)
				}).toStrictEqual({
					wake: {
						at: now,
						alarms: [[now]],
						projection: new Date(0).toISOString()
					},
					result: { selectedJobs: 1, sent: 1, failed: 0 },
					jobs: [waiting]
				});
			})
	);

	it.each(['finish', 'cancel'] as const)(
		'rolls back %s and released capacity when the waiter wake cannot commit',
		(operation) =>
			withoutAlarmArming(async () => {
				await fixture(3, 1);
				const sent: ArtifactQueueMessage[] = [];
				await dispatch((messages) => {
					sent.push(...messages);
				});
				const admission = sent[0]?.admission;
				if (admission === undefined) {
					throw new Error('The rollback fixture was not admitted');
				}
				await inSection((context) => {
					const jobs = new ArtifactJobService(context);
					const claim = new ArtifactAdmissionService(context).claimInSection(
						admission,
						artifactTaskOwnerSchema.parse(crypto.randomUUID())
					);
					if (claim === undefined) {
						throw new Error('The rollback fixture was not claimed');
					}
					const snapshot = () => ({
						jobs: context.db.select().from(schema.artifactJobs).all(),
						tasks: context.db.select().from(schema.artifactTasks).all(),
						admissions: context.db
							.select()
							.from(schema.artifactAdmissions)
							.all()
					});
					const before = snapshot();
					const release = () => {
						if (operation === 'finish') {
							expect(jobs.finishInSection(claim, 'failed')).toBe(true);
							return;
						}
						expect(jobs.cancelInSection(claim.jobId)).toBe(true);
					};
					context.ctx.storage.sql.exec(
						"CREATE TRIGGER refuse_capacity_wake BEFORE UPDATE OF capacity_wait_at ON artifact_job WHEN OLD.capacity_wait_at IS NOT NULL AND NEW.capacity_wait_at IS NULL BEGIN SELECT RAISE(ABORT, 'capacity wake refused'); END"
					);
					try {
						expect(release).toThrow('capacity wake refused');
					} finally {
						context.ctx.storage.sql.exec('DROP TRIGGER refuse_capacity_wake');
					}
					expect(snapshot()).toStrictEqual(before);
					release();
					expect(
						new ArtifactJobDispatchService(context).nextAtInSection()
					).toBe(Date.now());
				});
				const send = vi.fn<Parameters<typeof dispatch>[0]>();
				const after = await dispatch(send);
				expect(send).toHaveBeenCalledOnce();
				expect(after).toStrictEqual({ selectedJobs: 1, sent: 1, failed: 0 });
			})
	);

	it('keeps retired staging charged through a failed delete and wakes another job after physical cleanup', () =>
		withoutAlarmArming(async () => {
			const jobs = await fixture(3, 1);
			const sent: ArtifactQueueMessage[] = [];
			await dispatch((messages) => {
				sent.push(...messages);
			});
			const waiting = jobs.find((job) =>
				sent.every((message) => message.job.id !== job.id)
			);
			if (waiting === undefined) {
				throw new Error('The staging waiter is missing');
			}
			const blockedAt = Date.now();
			const leases = await inSection(async (context) => {
				const admissions = new ArtifactAdmissionService(context);
				const staging = new ArtifactStagingService(context);
				const leases = [];
				for (const message of sent) {
					if (message.admission === undefined) {
						throw new Error('The staging fixture was not admitted');
					}
					const claim = admissions.claimInSection(
						message.admission,
						artifactTaskOwnerSchema.parse(crypto.randomUUID())
					);
					if (claim === undefined) {
						throw new Error('The staging fixture was not claimed');
					}
					const reserved = await staging.reserveInSection(claim);
					if (reserved.kind !== 'reserved') {
						throw new Error('The staging fixture could not reserve bytes');
					}
					leases.push(reserved.lease);
				}
				const first = leases[0];
				if (first === undefined) {
					throw new Error('The first staging fixture is missing');
				}
				const bytes = new TextEncoder().encode('capacity cleanup');
				const upload = await context.env.BLOBS.createMultipartUpload(first.key);
				staging.registerMultipartInSection(first, upload.uploadId);
				const part = await upload.uploadPart(1, bytes);
				await upload.complete([part]);
				await staging.sealInSection(first, upload.uploadId, {
					digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
					size: bytes.byteLength
				});
				return leases;
			});
			const first = leases[0];
			if (first === undefined) {
				throw new Error('The sealed staging fixture is missing');
			}
			await currentServer().finishArtifactTask(first.claim, 'failed');
			await currentServer().retireArtifactStaging(first);
			await inSection((context) => {
				context.db
					.update(schema.artifactJobs)
					.set({ nextDispatchAt: blockedAt + 120_000 })
					.where(eq(schema.artifactJobs.id, waiting.id))
					.run();
			});
			const failed = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const remove = vi
						.spyOn(instance.context.env.BLOBS, 'delete')
						.mockRejectedValueOnce(new Error('temporary delete failure'));
					try {
						return {
							collection: await instance.collectArtifactStaging(),
							capacity: new ArtifactAdmissionService(
								instance.context
							).stagingCapacityInSection(),
							nextAt: new ArtifactJobDispatchService(
								instance.context
							).nextAtInSection()
						};
					} finally {
						remove.mockRestore();
					}
				}
			);
			const retryAt = isoTimestamp(new Date(blockedAt + 30_000));
			expect(failed).toStrictEqual({
				collection: { removed: 0, pending: true, nextWakeAt: retryAt },
				capacity: { reservations: 2, bytes: 128 * 1024 * 1024, retryAt },
				nextAt: Date.parse(first.claim.leaseExpiresAt)
			});
			vi.setSystemTime(new Date(retryAt));
			const after = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const alarm = vi.spyOn(instance.context.ctx.storage, 'setAlarm');
					try {
						const collection = await instance.collectArtifactStaging();
						return {
							removed: collection.removed,
							at: new ArtifactJobDispatchService(
								instance.context
							).nextAtInSection(),
							alarms: alarm.mock.calls
						};
					} finally {
						alarm.mockRestore();
					}
				}
			);
			const delivered: ArtifactQueueMessage[] = [];
			await dispatch((messages) => {
				delivered.push(...messages);
			});
			expect({
				after,
				jobs: delivered.map((message) => message.job)
			}).toStrictEqual({
				after: {
					removed: 1,
					at: blockedAt,
					alarms: [[Date.parse(first.claim.leaseExpiresAt)], [blockedAt]]
				},
				jobs: [waiting]
			});
		}));

	it('wakes at most eight oldest capacity waiters with indexed selection', () =>
		withoutAlarmArming(async () => {
			const versions = await fixture(20, 1);
			await inSection((context) => {
				const admissions = new ArtifactAdmissionService(context);
				const accepted = [];
				for (const job of versions) {
					vi.setSystemTime(new Date(Date.now() + 1));
					const task = context.db
						.select()
						.from(schema.artifactTasks)
						.where(eq(schema.artifactTasks.jobId, job.id))
						.get();
					if (task === undefined) {
						throw new Error('The bounded wake task is missing');
					}
					const result = admissions.reserveInSection(job, task.id);
					if (result.kind === 'admitted') {
						accepted.push(result.admission);
					}
				}
				context.db
					.update(schema.artifactJobs)
					.set({ nextDispatchAt: Date.now() + 120_000 })
					.run();
				const first = accepted[0];
				if (first === undefined) {
					throw new Error('The bounded wake admission is missing');
				}
				const claim = admissions.claimInSection(
					first,
					artifactTaskOwnerSchema.parse(crypto.randomUUID())
				);
				if (claim === undefined) {
					throw new Error('The bounded wake claim is missing');
				}
				const execute = vi.spyOn(context.ctx.storage.sql, 'exec');
				let captured: readonly [string, ...unknown[]] | undefined;
				try {
					new ArtifactJobService(context).finishInSection(claim, 'failed');
					captured = execute.mock.calls.find(([query]) =>
						query.includes('order by "artifact_job"."capacity_wait_at"')
					);
				} finally {
					execute.mockRestore();
				}
				if (captured === undefined) {
					throw new Error('The capacity waiter query was not captured');
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
				const now = Date.now();
				const due = context.db
					.select({ id: schema.artifactJobs.id })
					.from(schema.artifactJobs)
					.where(
						and(
							eq(schema.artifactJobs.state, 'running'),
							lte(schema.artifactJobs.nextDispatchAt, now)
						)
					)
					.orderBy(schema.artifactJobs.nextDispatchAt, schema.artifactJobs.id)
					.all();
				expect({ due, plan }).toStrictEqual({
					due: versions.slice(2, 10).map((job) => ({ id: job.id })),
					plan: [
						'SEARCH artifact_job USING INDEX artifact_job_capacity_idx (state=? AND capacity_wait_bytes=? AND capacity_wait_staged=? AND capacity_wait_at>?)'
					]
				});
			});
		}));

	it('checks for capacity waiters at constant cost without reading idle job backlogs', () =>
		withoutAlarmArming(async () => {
			await fixture(3, 1);
			await inSection(async (context) => {
				const measure = async () => {
					const execute = vi.spyOn(context.ctx.storage.sql, 'exec');
					let cost: DatabaseCost | undefined;
					try {
						const woken = await withRequestCost(
							() =>
								Promise.resolve(
									new ArtifactCapacityService(context).wakeInSection()
								),
							(observed) => {
								cost = observed;
							}
						);
						return { woken, cost, queries: execute.mock.calls.length };
					} finally {
						execute.mockRestore();
					}
				};
				const small = await measure();
				const template = context.db.select().from(schema.artifactJobs).get();
				if (template === undefined) {
					throw new Error('The idle job fixture is missing');
				}
				for (let index = 0; index < 1000; index += 1) {
					context.db
						.insert(schema.artifactJobs)
						.values({
							...template,
							id: artifactJobIdSchema.parse(crypto.randomUUID()),
							discovered: 0,
							discoveryComplete: false
						})
						.run();
				}
				const large = await measure();
				expect({ small, large }).toStrictEqual({
					small: {
						woken: 0,
						cost: { rowsRead: 0, rowsWritten: 0 },
						queries: 1
					},
					large: { woken: 0, cost: { rowsRead: 0, rowsWritten: 0 }, queries: 1 }
				});
			});
		}));

	it('waits for the renewed claim expiry when every task is active', () =>
		withoutAlarmArming(async () => {
			await fixture(1, 1);
			const sent: ArtifactQueueMessage[] = [];
			await dispatch((messages) => {
				sent.push(...messages);
			});
			const admission = sent[0]?.admission;
			if (admission === undefined) {
				throw new Error('The claim fixture was not dispatched');
			}
			const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
			const claim = await inSection((context) =>
				new ArtifactAdmissionService(context).claimInSection(admission, owner)
			);
			if (claim === undefined) {
				throw new Error('The dispatched task was not claimed');
			}
			vi.setSystemTime(new Date(Date.parse(claim.leaseExpiresAt) - 1));
			const renewed = await inSection((context) =>
				new ArtifactJobService(context).renewInSection(claim)
			);
			if (renewed === undefined) {
				throw new Error('The dispatched claim was not renewed');
			}
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const followup: ArtifactQueueMessage[] = [];
			const result = await dispatch((messages) => {
				followup.push(...messages);
			});
			expect({
				result,
				followup,
				nextAt: await inSection((context) =>
					new ArtifactJobDispatchService(context).nextAtInSection()
				)
			}).toStrictEqual({
				result: { selectedJobs: 1, sent: 0, failed: 0 },
				followup: [],
				nextAt: Date.parse(renewed)
			});
		}));

	it('preserves specific admissions after a failed send and reuses them for redispatch', () =>
		withoutAlarmArming(async () => {
			await fixture();
			const attempted: ArtifactQueueMessage[] = [];
			const failed = await dispatch((messages) => {
				attempted.push(...messages);
				throw new Error('Queue unavailable');
			});
			const deadline = await inSection((context) =>
				new ArtifactJobDispatchService(context).nextAtInSection()
			);
			if (deadline === undefined) {
				throw new Error('The failed dispatch retry is missing');
			}
			vi.setSystemTime(new Date(deadline));
			const sent: ArtifactQueueMessage[] = [];
			const retried = await dispatch((messages) => {
				sent.push(...messages);
			});
			expect({
				failed,
				retried,
				sent,
				admissionCount: await inSection(
					(context) =>
						context.db.select().from(schema.artifactAdmissions).all().length
				)
			}).toStrictEqual({
				failed: { selectedJobs: 1, sent: 0, failed: 2 },
				retried: { selectedJobs: 1, sent: 2, failed: 0 },
				sent: attempted,
				admissionCount: 2
			});
		}));

	it('does not let an older failed send postpone a newer wake', () =>
		withoutAlarmArming(async () => {
			const jobs = await fixture();
			const job = jobs[0];
			if (job === undefined) {
				throw new Error('The dispatch job is missing');
			}
			const now = Date.now();
			const result = await dispatch(async (_messages, context) => {
				await context.criticalSection(() =>
					Promise.resolve(
						new ArtifactJobDispatchService(context).wakeInSection(job)
					)
				);
				throw new Error('Late failed send');
			});
			expect({
				result,
				nextAt: await inSection((context) =>
					new ArtifactJobDispatchService(context).nextAtInSection()
				)
			}).toStrictEqual({
				result: { selectedJobs: 1, sent: 0, failed: 2 },
				nextAt: now
			});
		}));

	it('bounds the number of reserved jobs in one dispatch invocation', () =>
		withoutAlarmArming(async () => {
			await fixture(10, 1);
			const sent: ArtifactQueueMessage[] = [];
			const result = await dispatch((messages) => {
				sent.push(...messages);
			});
			expect({
				result,
				due: await inSection(
					(context) =>
						context.db
							.select()
							.from(schema.artifactJobs)
							.all()
							.filter((job) => job.nextDispatchAt <= Date.now()).length
				)
			}).toStrictEqual({
				result: { selectedJobs: 8, sent: 2, failed: 0 },
				due: 2
			});
		}));

	it('prioritises sealed recovery beyond the first pending page at full staging capacity', () =>
		withoutAlarmArming(async () => {
			const versions = await fixture(1, 10);
			const job = versions[0];
			if (job === undefined) {
				throw new Error('The recovery job is missing');
			}
			const staged = await inSection(async (context) => {
				const tasks = context.db
					.select()
					.from(schema.artifactTasks)
					.orderBy(schema.artifactTasks.id)
					.all()
					.slice(-2);
				const admissions = new ArtifactAdmissionService(context);
				const staging = new ArtifactStagingService(context);
				const deadlines: string[] = [];
				for (const task of tasks) {
					const reserved = admissions.reserveInSection(job, task.id);
					if (reserved.kind !== 'admitted') {
						throw new Error('The recovery task was not admitted');
					}
					const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
					const claim = admissions.claimInSection(reserved.admission, owner);
					if (claim === undefined) {
						throw new Error('The recovery task was not claimed');
					}
					const stage = await staging.reserveInSection(claim);
					if (stage.kind !== 'reserved') {
						throw new Error('The recovery stage was not reserved');
					}
					const bytes = new TextEncoder().encode('sealed listing');
					const upload = await context.env.BLOBS.createMultipartUpload(
						stage.lease.key
					);
					staging.registerMultipartInSection(stage.lease, upload.uploadId);
					const part = await upload.uploadPart(1, bytes);
					await upload.complete([part]);
					await staging.sealInSection(stage.lease, upload.uploadId, {
						digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
						size: bytes.byteLength
					});
					const retry = admissions.requeueInSection(claim);
					if (retry.kind !== 'admitted') {
						throw new Error('The sealed recovery was not requeued');
					}
					deadlines.push(claim.leaseExpiresAt);
				}
				return {
					taskIds: tasks.map((task) => task.id),
					deadline: deadlines.toSorted(byCodeUnit).at(-1)
				};
			});
			if (staged.deadline === undefined) {
				throw new Error('The recovery lease deadline is missing');
			}
			vi.setSystemTime(new Date(staged.deadline));
			const sent: ArtifactQueueMessage[] = [];
			const result = await dispatch((messages) => {
				sent.push(...messages);
			});
			expect({
				result,
				tasks: sent
					.flatMap((message) =>
						message.admission === undefined ? [] : [message.admission.taskId]
					)
					.toSorted(byCodeUnit),
				charges: await inSection((context) =>
					context.db
						.select({ bytes: schema.artifactAdmissions.maximumBytes })
						.from(schema.artifactAdmissions)
						.all()
				)
			}).toStrictEqual({
				result: { selectedJobs: 1, sent: 2, failed: 0 },
				tasks: staged.taskIds.toSorted(byCodeUnit),
				charges: [{ bytes: 0 }, { bytes: 0 }]
			});
		}));

	it('bounds a delivery batch to eight existing reuse admissions', () =>
		withoutAlarmArming(async () => {
			const versions = await fixture(1, 12);
			const job = versions[0];
			if (job === undefined) {
				throw new Error('The reuse job is missing');
			}
			await inSection((context) => {
				const tasks = context.db
					.select()
					.from(schema.artifactTasks)
					.orderBy(schema.artifactTasks.id)
					.all()
					.slice(0, 8);
				for (const task of tasks) {
					new ArtifactAdmissionService(context).reserveInSection(
						job,
						task.id,
						'reuse'
					);
				}
			});
			const sizes: number[] = [];
			const result = await dispatch((messages) => {
				sizes.push(messages.length);
			});
			expect({ result, sizes }).toStrictEqual({
				result: { selectedJobs: 1, sent: 8, failed: 0 },
				sizes: [8]
			});
		}));

	it('rolls back job deadlines and partial admissions when reservation fails', () =>
		withoutAlarmArming(async () => {
			await fixture();
			const before = await inSection((context) => ({
				jobs: context.db.select().from(schema.artifactJobs).all(),
				admissions: context.db.select().from(schema.artifactAdmissions).all()
			}));
			await inSection((context) => {
				context.ctx.storage.sql.exec(
					"CREATE TRIGGER fail_second_admission BEFORE INSERT ON artifact_admission WHEN (SELECT count(*) FROM artifact_admission) >= 1 BEGIN SELECT RAISE(ABORT, 'Admission write failed'); END"
				);
			});
			const sent: ArtifactQueueMessage[] = [];
			try {
				await expect(
					dispatch((messages) => {
						sent.push(...messages);
					})
				).rejects.toThrow();
			} finally {
				await inSection((context) => {
					context.ctx.storage.sql.exec('DROP TRIGGER fail_second_admission');
				});
			}
			expect({
				sent,
				state: await inSection((context) => ({
					jobs: context.db.select().from(schema.artifactJobs).all(),
					admissions: context.db.select().from(schema.artifactAdmissions).all()
				}))
			}).toStrictEqual({ sent: [], state: before });
		}));

	it('does not send work from a suspended tenant', () =>
		withoutAlarmArming(async () => {
			await fixture();
			await inSection(async (context) => {
				await context.d1
					.update(d1Schema.tenant)
					.set({ status: 'suspended' })
					.where(eq(d1Schema.tenant.id, context.requireTenant()))
					.run();
			});
			const sent: ArtifactQueueMessage[] = [];
			const result = await dispatch((messages) => {
				sent.push(...messages);
			});
			expect({ result, sent }).toStrictEqual({
				result: { selectedJobs: 0, sent: 0, failed: 0 },
				sent: []
			});
		}));

	it('does not reserve or send work during offboarding', () =>
		withoutAlarmArming(async () => {
			await fixture();
			await inSection((context) => {
				context.offboarding = true;
			});
			const sent: ArtifactQueueMessage[] = [];
			const result = await dispatch((messages) => {
				sent.push(...messages);
			});
			expect({ result, sent }).toStrictEqual({
				result: { selectedJobs: 0, sent: 0, failed: 0 },
				sent: []
			});
		}));
});
