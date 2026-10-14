import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { signingKeyIdSchema } from '@cupboard/nix-store/scalars';
import {
	type ArtifactTaskClaim,
	artifactTaskOwnerSchema,
	artifactTaskSourceSchema
} from '@cupboard/protocol/artifact-jobs';
import { artifactGenerationSchema } from '@cupboard/protocol/artifacts';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
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

import { artifactFixtureId, createArtifact } from './artifact.test-support.ts';
import { ArtifactAdmissionService } from './artifact-admission-service.ts';
import { ArtifactJobService } from './artifact-job-service.ts';
import {
	type ArtifactStageLease,
	type ArtifactStageReservation,
	ArtifactStagingService
} from './artifact-staging-service.ts';
import type { ServerContext } from './context.ts';
import { MaintenanceEligibilityService } from './maintenance-eligibility-service.ts';

const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const hash = storePathHashSchema.parse('c'.repeat(32));
const definition = {
	kind: 'listing',
	generatorRevision: currentListingGeneratorRevision
} as const;

function leaseOf(result: ArtifactStageReservation): ArtifactStageLease {
	if (result.kind !== 'reserved') {
		throw new Error('The fixture staging reservation was refused');
	}
	return result.lease;
}

async function withStage<T>(
	body: (
		staging: ArtifactStagingService,
		jobs: ArtifactJobService,
		context: ServerContext,
		claim: ArtifactTaskClaim
	) => Promise<T>
): Promise<T> {
	const token = await initialise();
	const nar = await verifiableNar('artifact-staging-source');
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
	const source = {
		kind: 'nar',
		storePathHash: hash,
		generation: narInfoGenerationSchema.parse(await narInfoGeneration(hash)),
		narHash: nar.narHash
	} as const;
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.criticalSection(async () => {
			const jobs = new ArtifactJobService(instance.context);
			const job = await jobs.startInSection(defaultCache(), definition);
			jobs.enqueueInSection(job, source);
			const result = jobs.claimInSection(job.id, owner);
			if (result.claim === undefined) {
				throw new Error('The fixture source was not claimed');
			}
			return body(
				new ArtifactStagingService(instance.context),
				jobs,
				instance.context,
				result.claim
			);
		})
	);
}

async function completeStage(
	staging: ArtifactStagingService,
	context: ServerContext,
	lease: ArtifactStageLease
) {
	const bytes = new TextEncoder().encode('native listing bytes');
	const upload = await context.env.BLOBS.createMultipartUpload(lease.key);
	const isRegistered = staging.registerMultipartInSection(
		lease,
		upload.uploadId
	);
	if (!isRegistered) {
		throw new Error('The fixture multipart upload was not registered');
	}
	const part = await upload.uploadPart(1, bytes);
	await upload.complete([part]);
	const measurement = {
		digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
		size: bytes.byteLength
	};
	const isSealed = await staging.sealInSection(
		lease,
		upload.uploadId,
		measurement
	);
	return { measurement, sealed: isSealed };
}

describe('durable artifact staging', () => {
	beforeEach(resetTestServer);

	it.each(['recover', 'expire'] as const)(
		'keeps sealed bytes after lease expiry to %s within the recovery window',
		(action) =>
			withoutAlarmArming(async () => {
				const lease = await withStage(
					async (staging, _jobs, context, claim) => {
						const lease = leaseOf(await staging.reserveInSection(claim));
						await completeStage(staging, context, lease);
						return lease;
					}
				);
				vi.setSystemTime(new Date(lease.expiresAt));
				const retained = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const staging = new ArtifactStagingService(instance.context);
						const collected = await staging.collect();
						return {
							collected,
							oldReady: staging.readyInSection(lease),
							oldRetired: staging.retireInSection(lease),
							exists:
								(await instance.context.env.BLOBS.head(lease.key)) !== null,
							states: instance.context.db
								.select()
								.from(schema.artifactStages)
								.all()
								.map((row) => row.state)
						};
					}
				);
				expect(retained).toStrictEqual({
					collected: {
						removed: 0,
						pending: true,
						nextWakeAt: lease.cleanupAfter
					},
					oldReady: undefined,
					oldRetired: false,
					exists: true,
					states: ['ready']
				});
				if (action === 'expire') {
					vi.setSystemTime(new Date(lease.cleanupAfter));
					const expired = await runInDurableObject(
						currentServer(),
						async (instance) => {
							const collected = await new ArtifactStagingService(
								instance.context
							).collect();
							return {
								collected,
								exists:
									(await instance.context.env.BLOBS.head(lease.key)) !== null,
								states: instance.context.db
									.select()
									.from(schema.artifactStages)
									.all()
									.map((row) => row.state)
							};
						}
					);
					expect(expired).toStrictEqual({
						collected: { removed: 1, pending: false },
						exists: false,
						states: []
					});
					return;
				}
				const claimed = await currentServer().claimArtifactTask(
					{ id: lease.claim.jobId, generation: lease.claim.jobGeneration },
					crypto.randomUUID()
				);
				if (claimed.kind !== 'claimed') {
					throw new Error('The expired task was not reclaimed');
				}
				const between = await runInDurableObject(currentServer(), (instance) =>
					new ArtifactStagingService(instance.context).collect()
				);
				expect(between).toStrictEqual({
					removed: 0,
					pending: true,
					nextWakeAt: lease.cleanupAfter
				});
				const recovered = await runInDurableObject(
					currentServer(),
					(instance) =>
						instance.context.criticalSection(() => {
							const reused = new ArtifactStagingService(
								instance.context
							).reuseReadyInSection(claimed.claim);
							return Promise.resolve(
								reused === undefined
									? undefined
									: {
											id: reused.id,
											key: reused.key,
											generation: reused.claim.generation,
											recoveryExtended: reused.cleanupAfter > lease.cleanupAfter
										}
							);
						})
				);
				expect(recovered).toStrictEqual({
					id: lease.id,
					key: lease.key,
					generation: 2,
					recoveryExtended: true
				});
			})
	);

	it.each([
		'cancelled',
		'source-replaced',
		'cache-replaced',
		'offboarding',
		'task-finished',
		'stage-ahead'
	] as const)('does not retain invalid sealed recovery after %s', (change) =>
		withoutAlarmArming(async () => {
			const lease = await withStage(async (staging, jobs, context, claim) => {
				const lease = leaseOf(await staging.reserveInSection(claim));
				await completeStage(staging, context, lease);
				switch (change) {
					case 'cancelled': {
						jobs.cancelInSection(claim.jobId);
						break;
					}
					case 'source-replaced': {
						context.db
							.update(schema.narInfos)
							.set({ generation: narInfoGenerationSchema.parse(2) })
							.run();
						break;
					}
					case 'cache-replaced': {
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
					case 'task-finished': {
						jobs.finishInSection(claim, 'failed');
						break;
					}
					case 'stage-ahead': {
						context.db
							.update(schema.artifactStages)
							.set({ taskGeneration: claim.generation + 1 })
							.run();
						break;
					}
				}
				return lease;
			});
			vi.setSystemTime(new Date(lease.expiresAt));
			const after = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const collected = await new ArtifactStagingService(
						instance.context
					).collect();
					return {
						collected,
						exists: (await instance.context.env.BLOBS.head(lease.key)) !== null,
						stages: instance.context.db
							.select()
							.from(schema.artifactStages)
							.all()
					};
				}
			);
			expect(after).toStrictEqual({
				collected: { removed: 1, pending: false },
				exists: false,
				stages: []
			});
		})
	);

	it('preserves queued sealed recovery without extending the old producer authority', () =>
		withoutAlarmArming(() =>
			withStage(async (staging, _jobs, context, claim) => {
				const lease = leaseOf(await staging.reserveInSection(claim));
				const sealed = await completeStage(staging, context, lease);
				const admission = new ArtifactAdmissionService(
					context
				).requeueInSection(claim);
				const row = context.db.select().from(schema.artifactStages).get();
				if (row?.multipartId === null || row?.multipartId === undefined) {
					throw new Error('The sealed upload ID is missing');
				}
				expect({
					admission: admission.kind,
					ready: staging.readyInSection(lease),
					renewed: staging.renewInSection(lease),
					sealed: await staging.sealInSection(
						lease,
						row.multipartId,
						sealed.measurement
					),
					retired: staging.retireInSection(lease),
					states: context.db
						.select()
						.from(schema.artifactStages)
						.all()
						.map((stage) => stage.state)
				}).toStrictEqual({
					admission: 'admitted',
					ready: undefined,
					renewed: undefined,
					sealed: false,
					retired: false,
					states: ['ready']
				});
			})
		));

	it.each(['sealed', 'abandoned'] as const)(
		'reclaims %s staging through durable alarm passes',
		(kind) =>
			withoutAlarmArming(async () => {
				const lease = await withStage(
					async (staging, _jobs, context, claim) => {
						const lease = leaseOf(await staging.reserveInSection(claim));
						switch (kind) {
							case 'sealed': {
								await completeStage(staging, context, lease);
								break;
							}
							case 'abandoned': {
								await context.env.BLOBS.put(lease.key, 'late bytes');
								break;
							}
						}
						staging.retireInSection(lease);
						return lease;
					}
				);
				const dueAt =
					kind === 'sealed' ? new Date() : new Date(lease.cleanupAfter);
				vi.setSystemTime(dueAt);
				for (let pass = 0; pass < 40; pass += 1) {
					const isPending = await runInDurableObject(
						currentServer(),
						async (instance) => {
							await instance.alarm();
							return (
								instance.context.db.select().from(schema.artifactStages).all()
									.length > 0
							);
						}
					);
					if (!isPending) {
						break;
					}
				}
				const after = await runInDurableObject(
					currentServer(),
					async (instance) => ({
						rows: instance.context.db
							.select()
							.from(schema.artifactStages)
							.all(),
						hasBytes:
							(await instance.context.env.BLOBS.head(lease.key)) !== null
					})
				);
				expect(after).toStrictEqual({ rows: [], hasBytes: false });
			})
	);

	it.each(['sealed', 'abandoned'] as const)(
		'arms the %s cleanup deadline after the retirement RPC',
		(kind) =>
			withoutAlarmArming(async () => {
				const lease = await withStage(
					async (staging, _jobs, context, claim) => {
						const lease = leaseOf(await staging.reserveInSection(claim));
						if (kind === 'sealed') {
							await completeStage(staging, context, lease);
						}
						return lease;
					}
				);
				const deadline =
					kind === 'sealed' ? Date.now() : Date.parse(lease.cleanupAfter);
				await runInDurableObject(currentServer(), async (instance) => {
					const setAlarm = vi.spyOn(instance.context.ctx.storage, 'setAlarm');
					try {
						const isRetired = await instance.retireArtifactStaging(lease);
						expect({ isRetired, wakes: setAlarm.mock.calls }).toStrictEqual({
							isRetired: true,
							wakes: [[deadline]]
						});
					} finally {
						setAlarm.mockRestore();
					}
				});
			})
	);

	it('projects staging expiry into the cron recovery deadline', () =>
		withoutAlarmArming(async () => {
			const lease = await withStage(async (staging, _jobs, _context, claim) =>
				leaseOf(await staging.reserveInSection(claim))
			);
			const projected = await runInDurableObject(
				currentServer(),
				async (instance) => {
					for (let pass = 0; pass < 40; pass += 1) {
						await instance.alarm();
					}
					vi.setSystemTime(new Date(Date.now() + 1));
					await new MaintenanceEligibilityService(instance.context).reconcile();
					const wake = await instance.context.d1
						.select()
						.from(d1Schema.tenantMaintenanceEligibility)
						.get();
					return { wake, tenant: instance.context.requireTenant() };
				}
			);
			expect(projected.wake).toStrictEqual({
				tenant: projected.tenant,
				nextWakeAt: lease.expiresAt,
				reconciledAt: isoTimestamp(new Date())
			});
		}));

	it('reads the cleanup deadline without skipping an invalid admitted source', () =>
		withoutAlarmArming(() =>
			withStage(async (staging, _jobs, context, claim) => {
				const lease = leaseOf(await staging.reserveInSection(claim));
				await completeStage(staging, context, lease);
				vi.setSystemTime(new Date(claim.leaseExpiresAt));
				const admission = new ArtifactAdmissionService(
					context
				).reserveInSection(
					{ id: claim.jobId, generation: claim.jobGeneration },
					claim.id
				);
				expect(admission.kind).toBe('admitted');
				context.db
					.update(schema.narInfos)
					.set({ generation: narInfoGenerationSchema.parse(2) })
					.run();
				const snapshot = () => ({
					tasks: context.db.select().from(schema.artifactTasks).all(),
					jobs: context.db.select().from(schema.artifactJobs).all(),
					stages: context.db.select().from(schema.artifactStages).all(),
					admissions: context.db.select().from(schema.artifactAdmissions).all()
				});
				const before = snapshot();
				const deadline = staging.nextCollectionAtInSection();
				expect({ deadline, after: snapshot() }).toStrictEqual({
					deadline: lease.expiresAt,
					after: before
				});
			})
		));

	it('reserves once for a claimed task and accounts for its maximum output size', () =>
		withoutAlarmArming(() =>
			withStage(async (staging, _jobs, context, claim) => {
				const first = leaseOf(await staging.reserveInSection(claim));
				const repeated = leaseOf(await staging.reserveInSection(claim));
				const rows = context.db.select().from(schema.artifactStages).all();
				expect({
					sameReservation: first.id === repeated.id,
					key: first.key,
					budgets: rows.map((row) => row.maximumBytes),
					deadline: first.expiresAt
				}).toStrictEqual({
					sameReservation: true,
					key: `artifact-staging/${context.requireTenant()}/${first.id}`,
					budgets: [64 * 1024 * 1024],
					deadline: claim.leaseExpiresAt
				});
			})
		));

	it('keeps abandoned reservations in the byte budget until their cleanup horizon', () =>
		withoutAlarmArming(() =>
			withStage(async (staging, jobs, context, claim) => {
				const first = leaseOf(await staging.reserveInSection(claim));
				const secondJob = await jobs.startInSection(defaultCache(), definition);
				jobs.enqueueInSection(secondJob, claim.source);
				const second = jobs.claimInSection(secondJob.id, owner).claim;
				if (second === undefined) {
					throw new Error('The second source was not claimed');
				}
				leaseOf(await staging.reserveInSection(second));
				staging.retireInSection(first);
				const thirdJob = await jobs.startInSection(defaultCache(), definition);
				jobs.enqueueInSection(thirdJob, claim.source);
				const third = jobs.claimInSection(thirdJob.id, owner).claim;
				if (third === undefined) {
					throw new Error('The third source was not claimed');
				}
				const result = await staging.reserveInSection(third);
				expect({
					result,
					budgets: context.db
						.select()
						.from(schema.artifactStages)
						.all()
						.map((row) => row.maximumBytes)
				}).toStrictEqual({
					result: { kind: 'capacity', retryAt: second.leaseExpiresAt },
					budgets: [64 * 1024 * 1024, 64 * 1024 * 1024]
				});
			})
		));

	it('rejects a lease whose captured source was changed', () =>
		withoutAlarmArming(() =>
			withStage(async (staging, _jobs, context, claim) => {
				const lease = leaseOf(await staging.reserveInSection(claim));
				await completeStage(staging, context, lease);
				const changed = {
					...lease,
					claim: {
						...claim,
						source: artifactTaskSourceSchema.parse({
							...claim.source,
							generation: 2
						})
					}
				};
				expect({
					ready: staging.readyInSection(changed),
					retired: staging.retireInSection(changed)
				}).toStrictEqual({ ready: undefined, retired: false });
			})
		));

	it('seals completed multipart bytes and rejects a changed measurement', () =>
		withoutAlarmArming(() =>
			withStage(async (staging, _jobs, context, claim) => {
				const lease = leaseOf(await staging.reserveInSection(claim));
				const { measurement, sealed } = await completeStage(
					staging,
					context,
					lease
				);
				const ready = staging.readyInSection(lease);
				expect({ sealed, ready }).toStrictEqual({
					sealed: true,
					ready: { key: lease.key, ...measurement }
				});
				const row = context.db.select().from(schema.artifactStages).get();
				if (row?.multipartId === null || row?.multipartId === undefined) {
					throw new Error('The completed multipart identity is missing');
				}
				await expect(
					staging.sealInSection(lease, row.multipartId, {
						...measurement,
						size: measurement.size + 1
					})
				).rejects.toThrow('measurement');
			})
		));

	it.each(['cancelled', 'source-replaced', 'cache-replaced'] as const)(
		'refuses a %s producer and retains its cleanup record',
		(change) =>
			withoutAlarmArming(() =>
				withStage(async (staging, jobs, context, claim) => {
					const lease = leaseOf(await staging.reserveInSection(claim));
					switch (change) {
						case 'cancelled': {
							jobs.cancelInSection(claim.jobId);
							break;
						}
						case 'source-replaced': {
							context.db
								.update(schema.narInfos)
								.set({ generation: narInfoGenerationSchema.parse(2) })
								.run();
							break;
						}
						case 'cache-replaced': {
							context.db
								.update(schema.cacheIdentities)
								.set({ generation: cacheGenerationSchema.parse(2) })
								.run();
							break;
						}
					}
					expect({
						renewed: staging.renewInSection(lease),
						ready: staging.readyInSection(lease),
						reserved: await staging.reserveInSection(claim),
						retired: staging.retireInSection(lease),
						records: context.db
							.select()
							.from(schema.artifactStages)
							.all()
							.map((row) => row.state)
					}).toStrictEqual({
						renewed: undefined,
						ready: undefined,
						reserved: { kind: 'unavailable' },
						retired: true,
						records: ['retired']
					});
				})
			)
	);

	it('delays abandoned deletion, retains a failed delete and retries without losing its reservation', () =>
		withoutAlarmArming(async () => {
			const { lease, before } = await withStage(
				async (staging, _jobs, context, claim) => {
					const lease = leaseOf(await staging.reserveInSection(claim));
					await context.env.BLOBS.put(lease.key, 'late bytes');
					staging.retireInSection(lease);
					return { lease, before: await staging.collect() };
				}
			);
			vi.setSystemTime(new Date(Date.parse(lease.cleanupAfter) + 1));
			const failed = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const failedDelete = vi
						.spyOn(env.BLOBS, 'delete')
						.mockRejectedValueOnce(new Error('temporary delete failure'));
					try {
						return await new ArtifactStagingService(instance.context).collect();
					} finally {
						failedDelete.mockRestore();
					}
				}
			);
			const next = failed.nextWakeAt;
			if (next === undefined) {
				throw new Error('The staging cleanup retry is missing');
			}
			vi.setSystemTime(new Date(Date.parse(next) + 1));
			const retried = await runInDurableObject(
				currentServer(),
				async (instance) => ({
					retry: await new ArtifactStagingService(instance.context).collect(),
					rows: instance.context.db.select().from(schema.artifactStages).all(),
					exists: (await instance.context.env.BLOBS.head(lease.key)) !== null
				})
			);
			expect({
				earlyRemoved: before.removed,
				failedRemoved: failed.removed,
				...retried,
				horizon:
					Date.parse(lease.cleanupAfter) -
					(Date.parse(lease.writeUntil) - 15 * 60 * 1000)
			}).toStrictEqual({
				earlyRemoved: 0,
				failedRemoved: 0,
				retry: { removed: 1, pending: false },
				rows: [],
				exists: false,
				horizon: lateWriteTombstoneHorizonMs
			});
		}));

	it('renews staging from the current claim deadline beyond the original expiry', () =>
		withoutAlarmArming(async () => {
			const lease = await withStage(async (staging, _jobs, _context, claim) =>
				leaseOf(await staging.reserveInSection(claim))
			);
			vi.setSystemTime(new Date(Date.parse(lease.expiresAt) - 1));
			const renewed = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() => {
					const taskDeadline = new ArtifactJobService(
						instance.context
					).renewInSection(lease.claim);
					const stageDeadline = new ArtifactStagingService(
						instance.context
					).renewInSection(lease);
					return Promise.resolve({ taskDeadline, stageDeadline });
				})
			);
			vi.setSystemTime(new Date(Date.parse(lease.expiresAt) + 1));
			const collected = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const result = await new ArtifactStagingService(
						instance.context
					).collect();
					return {
						removed: result.removed,
						states: instance.context.db
							.select()
							.from(schema.artifactStages)
							.all()
							.map((row) => row.state)
					};
				}
			);
			const expectedDeadline = isoTimestamp(
				new Date(Date.parse(lease.expiresAt) + 59_999)
			);
			expect({ renewed, collected }).toStrictEqual({
				renewed: {
					taskDeadline: expectedDeadline,
					stageDeadline: expectedDeadline
				},
				collected: { removed: 0, states: ['pending'] }
			});
		}));

	it('clamps staging renewal to its write window even while the task remains leased', () =>
		withoutAlarmArming(async () => {
			const lease = await withStage(async (staging, _jobs, _context, claim) =>
				leaseOf(await staging.reserveInSection(claim))
			);
			vi.setSystemTime(new Date(Date.parse(lease.writeUntil) - 1));
			const renewed = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() => {
					const extended = isoTimestamp(
						new Date(Date.parse(lease.writeUntil) + 60_000)
					);
					instance.context.db
						.update(schema.artifactTasks)
						.set({
							leaseExpiresAt: extended
						})
						.run();
					instance.context.db
						.update(schema.artifactStages)
						.set({ expiresAt: lease.writeUntil })
						.run();
					return Promise.resolve(
						new ArtifactStagingService(instance.context).renewInSection(lease)
					);
				})
			);
			vi.setSystemTime(new Date(Date.parse(lease.writeUntil) + 1));
			const expired = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() => {
					const isTaskLeased =
						new ArtifactJobService(instance.context).claimDeadlineInSection(
							lease.claim
						) !== undefined;
					const stageDeadline = new ArtifactStagingService(
						instance.context
					).renewInSection(lease);
					return Promise.resolve({ taskLeased: isTaskLeased, stageDeadline });
				})
			);
			expect({ renewed, expired }).toStrictEqual({
				renewed: lease.writeUntil,
				expired: { taskLeased: true, stageDeadline: undefined }
			});
		}));

	it('records a late multipart completion for cleanup without making it readable', () =>
		withoutAlarmArming(() =>
			withStage(async (staging, jobs, context, claim) => {
				const lease = leaseOf(await staging.reserveInSection(claim));
				const bytes = new TextEncoder().encode('late completed bytes');
				const upload = await context.env.BLOBS.createMultipartUpload(lease.key);
				staging.registerMultipartInSection(lease, upload.uploadId);
				const part = await upload.uploadPart(1, bytes);
				await upload.complete([part]);
				jobs.cancelInSection(claim.jobId);
				const isSealed = await staging.sealInSection(lease, upload.uploadId, {
					digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
					size: bytes.byteLength
				});
				const ready = staging.readyInSection(lease);
				const collected = await staging.collect();
				expect({
					sealed: isSealed,
					ready,
					collected,
					rows: context.db.select().from(schema.artifactStages).all()
				}).toStrictEqual({
					sealed: false,
					ready: undefined,
					collected: { removed: 1, pending: false },
					rows: []
				});
			})
		));

	it('bounds the number of small reservations independently of their byte budget', () =>
		withoutAlarmArming(() =>
			withStage(async (staging, jobs, context, _claim) => {
				const artifact = await createArtifact(context);
				context.db
					.update(schema.artifacts)
					.set({ state: 'live', completedAt: isoTimestamp(new Date()) })
					.run();
				const source = {
					kind: 'artifact',
					id: artifactFixtureId,
					generation: artifactGenerationSchema.parse(1),
					digest: artifact.digest
				} as const;
				const results = [];
				for (let index = 0; index < 9; index++) {
					const job = await jobs.startInSection(defaultCache(), {
						kind: 'listing-proof',
						signingKeyId: signingKeyIdSchema.parse(
							'00000000-0000-4000-8000-000000000003'
						)
					});
					jobs.enqueueInSection(job, source);
					const claim = jobs.claimInSection(job.id, owner).claim;
					if (claim === undefined) {
						throw new Error('The proof source was not claimed');
					}
					const reservation = await staging.reserveInSection(claim);
					results.push(reservation.kind);
				}
				expect({
					results,
					budgets: context.db
						.select()
						.from(schema.artifactStages)
						.all()
						.map((row) => row.maximumBytes)
				}).toStrictEqual({
					results: [
						'reserved',
						'reserved',
						'reserved',
						'reserved',
						'reserved',
						'reserved',
						'reserved',
						'reserved',
						'capacity'
					],
					budgets: Array.from({ length: 8 }, () => 1024 * 1024)
				});
			})
		));

	it('removes sealed bytes promptly after retirement and refuses a forged object key', () =>
		withoutAlarmArming(() =>
			withStage(async (staging, _jobs, context, claim) => {
				const lease = leaseOf(await staging.reserveInSection(claim));
				await completeStage(staging, context, lease);
				const isForged = staging.retireInSection({
					...lease,
					key: r2ObjectKeySchema.parse('cas/other-object')
				});
				staging.retireInSection(lease);
				const collected = await staging.collect();
				expect({
					forged: isForged,
					collected,
					rows: context.db.select().from(schema.artifactStages).all(),
					exists: (await context.env.BLOBS.head(lease.key)) !== null
				}).toStrictEqual({
					forged: false,
					collected: { removed: 1, pending: false },
					rows: [],
					exists: false
				});
			})
		));

	it('keeps ready bytes available for an admitted replacement at full staging capacity', () =>
		withoutAlarmArming(async () => {
			const snapshot = await withStage(
				async (staging, jobs, context, claim) => {
					const first = leaseOf(await staging.reserveInSection(claim));
					const measured = await completeStage(staging, context, first);
					const secondJob = await jobs.startInSection(
						defaultCache(),
						definition
					);
					jobs.enqueueInSection(secondJob, claim.source);
					const second = jobs.claimInSection(secondJob.id, owner).claim;
					if (second === undefined) {
						throw new Error('The second fixture source was not claimed');
					}
					const secondStage = leaseOf(await staging.reserveInSection(second));
					vi.setSystemTime(new Date(Date.parse(claim.leaseExpiresAt) - 1));
					jobs.renewInSection(second);
					const secondDeadline = staging.renewInSection(secondStage);
					vi.setSystemTime(new Date(Date.parse(claim.leaseExpiresAt) + 1));
					const result = new ArtifactAdmissionService(context).reserveInSection(
						{ id: claim.jobId, generation: claim.jobGeneration },
						claim.id
					);
					if (result.kind !== 'admitted') {
						throw new Error('The ready replacement was not admitted');
					}
					return {
						first,
						admission: result.admission,
						measurement: measured.measurement,
						secondDeadline
					};
				}
			);
			const collected = await runInDurableObject(currentServer(), (instance) =>
				new ArtifactStagingService(instance.context).collect()
			);
			const adopted = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() => {
					const admissions = new ArtifactAdmissionService(instance.context);
					const claim = admissions.claimInSection(
						snapshot.admission,
						artifactTaskOwnerSchema.parse(
							'00000000-0000-4000-8000-000000000002'
						)
					);
					if (claim === undefined) {
						throw new Error('The ready replacement was not claimed');
					}
					const staging = new ArtifactStagingService(instance.context);
					const reused = staging.reuseReadyInSection(claim);
					if (reused === undefined) {
						throw new Error('The ready stage could not be adopted');
					}
					return Promise.resolve({
						sameKey: reused.key === snapshot.first.key,
						oldReady: staging.readyInSection(snapshot.first),
						newReady: staging.readyInSection(reused),
						admissionRows: instance.context.db
							.select()
							.from(schema.artifactAdmissions)
							.all()
					});
				})
			);
			expect({ collected, adopted }).toStrictEqual({
				collected: {
					removed: 0,
					pending: true,
					nextWakeAt: snapshot.secondDeadline
				},
				adopted: {
					sameKey: true,
					oldReady: undefined,
					newReady: { ...snapshot.measurement, key: snapshot.first.key },
					admissionRows: []
				}
			});
		}));
});
