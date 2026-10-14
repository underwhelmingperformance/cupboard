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
