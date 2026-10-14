import {
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type ArtifactJobVersion,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { type ArtifactQueueMessage } from '../routing/artifact-queue-message.ts';
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

import { ArtifactAdmissionService } from './artifact-admission-service.ts';
import { ArtifactJobDispatchService } from './artifact-job-dispatch-service.ts';
import { ArtifactJobService } from './artifact-job-service.ts';
import { ArtifactQueueDispatchService } from './artifact-queue-dispatch-service.ts';
import { ArtifactStagingService } from './artifact-staging-service.ts';
import { type ServerContext } from './context.ts';

async function inSection<T>(
	run: (context: ServerContext) => Promise<T> | T
): Promise<T> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.criticalSection(() =>
			Promise.resolve(run(instance.context))
		)
	);
}

async function fixture(jobCount = 1, taskCount = 3) {
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
			for (const source of sources) {
				jobs.enqueueInSection(job, source);
			}
			jobs.checkpointInSection(job, undefined, true);
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
			await send(Array.from(messages, (message) => message.body));
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

describe('artifact queue dispatch', () => {
	beforeEach(resetTestServer);

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
