import {
	narInfoGenerationSchema,
	predicateTypeSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import { AttestationListRevisionRepository } from '../db/attestation-list-revision.ts';
import * as schema from '../db/schema.ts';
import {
	AttestationListRefreshLeaseLostError,
	SubrequestTimeoutError
} from '../errors.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	clearBlobStorage,
	commitPath,
	currentServer,
	defaultCache,
	initialise,
	narInfoGeneration,
	recordTransition,
	resetTestServer,
	uploadMetadata,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import { AttestationListRefreshService } from './attestation-list-refresh-service.ts';
import { ServerContext } from './context.ts';
import { withDeadlineBudget } from './deadline.ts';

const hash = storePathHashSchema.parse('a'.repeat(32));
const predicate = predicateTypeSchema.parse(
	`https://example.com/${'x'.repeat(460)}λ`
);

async function seedList(count = 12_000, pathHash = hash) {
	const token = await initialise();
	const nar = await verifiableNar(`durable-list-refresh-${pathHash}`);
	await commitPath(
		token,
		uploadMetadata({
			storePathHash: pathHash,
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		}),
		nar
	);
	const generation = narInfoGenerationSchema.parse(
		await narInfoGeneration(pathHash)
	);
	const numbered =
		'WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbered WHERE value < ?)';
	await env.CUPBOARD_DB.batch([
		env.CUPBOARD_DB.prepare(
			`${numbered} INSERT OR IGNORE INTO cas_object_storage (digest,size,incarnation,stored_at)
			SELECT printf('%064x',value), 64, 1, '2026-01-01T00:00:00.000Z' FROM numbered`
		).bind(count),
		env.CUPBOARD_DB.prepare(
			`${numbered} INSERT INTO attestation_ref_storage (tenant,cache_kind,cache_name,store_path_hash,generation,predicate_type,digest)
			SELECT ?, 'default', NULL, ?, ?, ?, printf('%064x',value) FROM numbered`
		).bind(count, fixtureTenant, pathHash, generation, predicate)
	]);
	return {
		identity: { cache: defaultCache(), storePathHash: pathHash, generation },
		parent: { cacheGeneration: 1, narHash: nar.narHash }
	};
}

async function advanceTo(
	context: ServerContext,
	phase: 'uploading' | 'completing' | 'publishing'
) {
	for (let pass = 0; pass < 200; pass++) {
		const job = context.db
			.select()
			.from(schema.attestationListRefreshJobs)
			.where(isNull(schema.attestationListRefreshJobs.cleanupAt))
			.get();
		if (
			job?.phase === phase &&
			(phase !== 'uploading' || job.uploadId !== null)
		) {
			return job;
		}
		await new AttestationListRefreshService(context).advance();
	}
	throw new Error(`The refresh did not reach ${phase}`);
}

describe('durable attestation list refresh', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
		await recordTransition('attestation-list-revision', 'complete');
	});

	it.each([
		{ phase: 'new-job', activation: 'missing' },
		{ phase: 'new-job', activation: 'expanded' },
		{ phase: 'publication', activation: 'missing' },
		{ phase: 'publication', activation: 'expanded' }
	] as const)(
		'refuses $phase while reader activation is $activation',
		({ phase, activation }) =>
			withoutAlarmArming(async () => {
				await recordTransition('attestation-list-revision', 'complete');
				await seedList(1);
				await runInDurableObject(currentServer(), async (instance) => {
					const job =
						phase === 'publication'
							? await advanceTo(instance.context, 'publishing')
							: undefined;
					if (activation === 'missing') {
						await env.CUPBOARD_DB.prepare(
							"DELETE FROM deployment_transition WHERE id = 'attestation-list-revision'"
						).run();
					} else {
						await recordTransition('attestation-list-revision', 'expanded');
					}
					if (job !== undefined) {
						const canPublish = await new AttestationListRevisionRepository(
							instance.context.d1,
							fixtureTenant
						).publish(
							job.source.captured,
							job.source.identity,
							job.source.parent,
							job.key
						);
						expect(canPublish).toBe(false);
						return;
					}
					const progress = await new AttestationListRefreshService(
						instance.context
					).advance();
					const jobs = instance.context.db
						.select({ phase: schema.attestationListRefreshJobs.phase })
						.from(schema.attestationListRefreshJobs)
						.all();
					expect({ progress, jobs }).toStrictEqual({
						progress: 'stalled',
						jobs: []
					});
				});
			})
	);

	it('keeps immutable refresh objects under the tenant object prefix', () =>
		withoutAlarmArming(async () => {
			await seedList(2);
			await runInDurableObject(currentServer(), async (instance) => {
				await new AttestationListRefreshService(instance.context).advance();
				const job = instance.context.db
					.select({
						id: schema.attestationListRefreshJobs.id,
						key: schema.attestationListRefreshJobs.key
					})
					.from(schema.attestationListRefreshJobs)
					.get();
				if (job === undefined) {
					throw new Error('The refresh did not create a job');
				}
				expect(job).toStrictEqual({
					id: job.id,
					key: `t/${fixtureTenant}/attestation-index/${job.id}`
				});
			});
		}));

	it('preserves retirement cleanup across a restart until late completion is safe to remove', () =>
		withoutAlarmArming(async () => {
			await seedList(2);
			await runInDurableObject(currentServer(), async (instance, state) => {
				const job = await advanceTo(instance.context, 'completing');
				if (job.uploadId === null) {
					throw new Error('The upload ID was not persisted');
				}
				const upload = env.BLOBS.resumeMultipartUpload(job.key, job.uploadId);
				const original = upload.complete.bind(upload);
				const released = Promise.withResolvers<undefined>();
				const finished = Promise.withResolvers<undefined>();
				const completionState = { isStarted: false };
				const complete = vi
					.spyOn(upload, 'complete')
					.mockImplementationOnce(async (parts) => {
						completionState.isStarted = true;
						try {
							await released.promise;
							return await original(parts);
						} finally {
							finished.resolve(undefined);
						}
					});
				const resume = vi
					.spyOn(env.BLOBS, 'resumeMultipartUpload')
					.mockReturnValueOnce(upload);
				try {
					await expect(
						withDeadlineBudget(250, () =>
							new AttestationListRefreshService(instance.context).advance()
						)
					).rejects.toBeInstanceOf(SubrequestTimeoutError);
					expect(complete).toHaveBeenCalledOnce();
					await env.CUPBOARD_DB.prepare(
						'UPDATE attestation_ref_storage SET readable = false WHERE tenant = ? AND store_path_hash = ?'
					)
						.bind(fixtureTenant, hash)
						.run();
					const restarted = new ServerContext(state, {
						...instance.context.env,
						BLOBS: env.BLOBS
					});
					await new AttestationListRefreshService(restarted).advance();
					const retired = restarted.db
						.select({
							phase: schema.attestationListRefreshJobs.phase,
							cleanupAt: schema.attestationListRefreshJobs.cleanupAt
						})
						.from(schema.attestationListRefreshJobs)
						.where(eq(schema.attestationListRefreshJobs.id, job.id))
						.get();
					expect({
						phase: retired?.phase,
						delayed: (retired?.cleanupAt ?? 0) > Date.now()
					}).toStrictEqual({ phase: 'cleanup', delayed: true });
					await new AttestationListRefreshService(restarted).advance();
					released.resolve(undefined);
					await Promise.all(
						complete.mock.results
							.filter((result) => result.type === 'return')
							.map((result) => result.value)
					);
					expect(await env.BLOBS.head(job.key)).not.toBeNull();
					vi.useFakeTimers({ toFake: ['Date'] });
					vi.setSystemTime(Date.now() + lateWriteTombstoneHorizonMs + 1);
					for (let pass = 0; pass < 6; pass++) {
						await new AttestationListRefreshService(restarted).advance();
						const remaining = restarted.db
							.select({ id: schema.attestationListRefreshJobs.id })
							.from(schema.attestationListRefreshJobs)
							.where(eq(schema.attestationListRefreshJobs.id, job.id))
							.get();
						if (remaining === undefined) {
							break;
						}
					}
					expect({
						object: (await env.BLOBS.head(job.key)) ?? undefined,
						job: restarted.db
							.select({ id: schema.attestationListRefreshJobs.id })
							.from(schema.attestationListRefreshJobs)
							.where(eq(schema.attestationListRefreshJobs.id, job.id))
							.get()
					}).toStrictEqual({ object: undefined, job: undefined });
				} finally {
					released.resolve(undefined);
					if (completionState.isStarted) {
						await finished.promise;
					}
					resume.mockRestore();
					complete.mockRestore();
					vi.useRealTimers();
				}
			});
		}));

	it('defers deletion of a preceding publication whose completion response was lost', () =>
		withoutAlarmArming(async () => {
			await seedList(2);
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				const oldJob = await advanceTo(context, 'completing');
				if (oldJob.uploadId === null) {
					throw new Error('The upload ID was not persisted');
				}
				const upload = env.BLOBS.resumeMultipartUpload(
					oldJob.key,
					oldJob.uploadId
				);
				const original = upload.complete.bind(upload);
				const complete = vi
					.spyOn(upload, 'complete')
					.mockImplementationOnce(async (parts) => {
						await original(parts);
						throw new Error('Completion response lost');
					});
				const resume = vi
					.spyOn(env.BLOBS, 'resumeMultipartUpload')
					.mockReturnValueOnce(upload);
				try {
					await expect(
						new AttestationListRefreshService(context).advance()
					).rejects.toThrow('Completion response lost');
				} finally {
					resume.mockRestore();
					complete.mockRestore();
				}
				await new AttestationListRefreshService(context).advance();
				await new AttestationListRefreshService(context).advance();
				await env.CUPBOARD_DB.prepare(
					'DELETE FROM attestation_ref_storage WHERE tenant = ? AND store_path_hash = ? AND digest = ?'
				)
					.bind(fixtureTenant, hash, '2'.padStart(64, '0'))
					.run();
				const newJob = await advanceTo(context, 'publishing');
				await new AttestationListRefreshService(context).advance();
				for (let pass = 0; pass < 3; pass++) {
					await new AttestationListRefreshService(context).advance();
				}
				const retained = context.db
					.select({ cleanupAt: schema.attestationListRefreshJobs.cleanupAt })
					.from(schema.attestationListRefreshJobs)
					.where(eq(schema.attestationListRefreshJobs.id, newJob.id))
					.get();
				expect({
					oldPresent: (await env.BLOBS.head(oldJob.key)) !== null,
					replacementCleanupDelayed: (retained?.cleanupAt ?? 0) > Date.now()
				}).toStrictEqual({ oldPresent: true, replacementCleanupDelayed: true });
				vi.useFakeTimers({ toFake: ['Date'] });
				try {
					vi.setSystemTime(Date.now() + lateWriteTombstoneHorizonMs + 1);
					for (let pass = 0; pass < 6; pass++) {
						await new AttestationListRefreshService(context).advance();
					}
					const replacement = await env.BLOBS.get(newJob.key);
					if (replacement === null) {
						throw new Error(
							'The replacement publication was deleted during cleanup'
						);
					}
					expect({
						old: (await env.BLOBS.head(oldJob.key)) ?? undefined,
						body: await replacement.json(),
						jobs: context.db
							.select({ id: schema.attestationListRefreshJobs.id })
							.from(schema.attestationListRefreshJobs)
							.all()
					}).toStrictEqual({
						old: undefined,
						body: {
							attestations: [
								{
									digest: '1'.padStart(64, '0'),
									predicateType: predicate,
									size: 64
								}
							]
						},
						jobs: []
					});
				} finally {
					vi.useRealTimers();
				}
			});
		}));

	it('refuses a completion checkpoint after offboarding begins', () =>
		withoutAlarmArming(async () => {
			await seedList(2);
			await runInDurableObject(currentServer(), async (instance) => {
				const job = await advanceTo(instance.context, 'completing');
				if (job.uploadId === null) {
					throw new Error('The upload ID was not persisted');
				}
				const upload = env.BLOBS.resumeMultipartUpload(job.key, job.uploadId);
				const original = upload.complete.bind(upload);
				const complete = vi
					.spyOn(upload, 'complete')
					.mockImplementationOnce(async (parts) => {
						const object = await original(parts);
						instance.context.offboarding = true;
						return object;
					});
				const resume = vi
					.spyOn(env.BLOBS, 'resumeMultipartUpload')
					.mockReturnValueOnce(upload);
				try {
					await expect(
						new AttestationListRefreshService(instance.context).advance()
					).rejects.toBeInstanceOf(AttestationListRefreshLeaseLostError);
					const result = await new AttestationListRefreshService(
						instance.context
					).advance();
					expect({
						result,
						job: instance.context.db
							.select({ phase: schema.attestationListRefreshJobs.phase })
							.from(schema.attestationListRefreshJobs)
							.where(eq(schema.attestationListRefreshJobs.id, job.id))
							.get()
					}).toStrictEqual({ result: 'stalled', job: { phase: 'completing' } });
				} finally {
					resume.mockRestore();
					complete.mockRestore();
				}
			});
		}));

	it('resumes bounded pages across service restarts and publishes the complete multipart object', async () => {
		const { identity, parent } = await seedList();
		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const repository = new AttestationListRevisionRepository(
					instance.context.d1,
					fixtureTenant
				);
				const states = [];
				for (let pass = 0; pass < 200; pass++) {
					await new AttestationListRefreshService(instance.context).advance();
					const state = await repository.readState(identity, {
						...parent,
						cacheGeneration:
							instance.context.cacheRepository.require(defaultCache())
								.generation
					});
					if (state.status === 'ready') {
						return state;
					}
					states.push(state.status);
				}
				return { status: 'unfinished' as const, states };
			}
		);
		expect(result.status).toBe('ready');
		if (result.status !== 'ready' || result.key === undefined) {
			throw new Error('The complete list was not published');
		}
		const object = await env.BLOBS.get(result.key);
		if (object === null) {
			throw new Error('The published list object is missing');
		}
		expect(await object.json()).toStrictEqual({
			attestations: Array.from({ length: 12_000 }, (_, index) => ({
				digest: (index + 1).toString(16).padStart(64, '0'),
				predicateType: predicate,
				size: 64
			}))
		});
		await runInDurableObject(currentServer(), async (instance) => {
			for (let pass = 0; pass < 10; pass++) {
				await new AttestationListRefreshService(instance.context).advance();
				if (
					instance.context.db
						.select()
						.from(schema.attestationListRefreshJobs)
						.get() === undefined
				) {
					break;
				}
			}
			expect({
				jobs: instance.context.db
					.select()
					.from(schema.attestationListRefreshJobs)
					.all(),
				chunks: instance.context.db
					.select()
					.from(schema.attestationListRefreshChunks)
					.all(),
				parts: instance.context.db
					.select()
					.from(schema.attestationListRefreshParts)
					.all()
			}).toStrictEqual({ jobs: [], chunks: [], parts: [] });
		});
	});
	it.each(['size', 'metadata'] as const)(
		'refuses recovery of a completed object with mismatched %s',
		async (mismatch) => {
			await seedList(2);
			await runInDurableObject(currentServer(), async (instance) => {
				const job = await advanceTo(instance.context, 'completing');
				const size = mismatch === 'size' ? 1 : job.completedBytes;
				await env.BLOBS.put(job.key, new Uint8Array(size));
				await expect(
					new AttestationListRefreshService(instance.context).advance()
				).resolves.toBe('progressed');
				expect(
					instance.context.db
						.select({ phase: schema.attestationListRefreshJobs.phase })
						.from(schema.attestationListRefreshJobs)
						.get()
				).toStrictEqual({ phase: 'cleanup' });
			});
		}
	);

	it('recovers a completed multipart object after the completion response is lost', async () => {
		const { identity, parent } = await seedList(2);
		await runInDurableObject(currentServer(), async (instance) => {
			const job = await advanceTo(instance.context, 'completing');
			if (job.uploadId === null) {
				throw new Error('The upload ID was not persisted');
			}
			const upload = env.BLOBS.resumeMultipartUpload(job.key, job.uploadId);
			const complete = vi
				.spyOn(upload, 'complete')
				.mockImplementationOnce(async (parts) => {
					await env.BLOBS.resumeMultipartUpload(
						job.key,
						job.uploadId ?? ''
					).complete(parts);
					throw new Error('Completion response lost');
				});
			const resume = vi
				.spyOn(env.BLOBS, 'resumeMultipartUpload')
				.mockReturnValueOnce(upload);
			try {
				await expect(
					new AttestationListRefreshService(instance.context).advance()
				).rejects.toThrow('Completion response lost');
			} finally {
				resume.mockRestore();
				complete.mockRestore();
			}
			await new AttestationListRefreshService(instance.context).advance();
			await new AttestationListRefreshService(instance.context).advance();
			const repository = new AttestationListRevisionRepository(
				instance.context.d1,
				fixtureTenant
			);
			const state = await repository.readState(identity, {
				...parent,
				cacheGeneration:
					instance.context.cacheRepository.require(defaultCache()).generation
			});
			expect(state).toStrictEqual({ status: 'ready', key: job.key });
		});
	});

	it('rejects a stale upload checkpoint and retries the same persisted part', async () => {
		await seedList(2);
		await runInDurableObject(currentServer(), async (instance) => {
			const job = await advanceTo(instance.context, 'uploading');
			if (job.uploadId === null) {
				throw new Error('The upload ID was not persisted');
			}
			const upload = env.BLOBS.resumeMultipartUpload(job.key, job.uploadId);
			const original = upload.uploadPart.bind(upload);
			const part = vi
				.spyOn(upload, 'uploadPart')
				.mockImplementationOnce(async (number, body) => {
					const result = await original(number, body);
					instance.context.db
						.update(schema.attestationListRefreshLease)
						.set({ owner: 'replacement', expiresAt: Date.now() + 60_000 })
						.where(eq(schema.attestationListRefreshLease.id, 1))
						.run();
					return result;
				});
			const resume = vi
				.spyOn(env.BLOBS, 'resumeMultipartUpload')
				.mockReturnValueOnce(upload);
			try {
				await expect(
					new AttestationListRefreshService(instance.context).advance()
				).rejects.toBeInstanceOf(AttestationListRefreshLeaseLostError);
			} finally {
				resume.mockRestore();
				part.mockRestore();
			}
			expect({
				job: instance.context.db
					.select({
						nextPart: schema.attestationListRefreshJobs.nextPart,
						completedBytes: schema.attestationListRefreshJobs.completedBytes
					})
					.from(schema.attestationListRefreshJobs)
					.get(),
				parts: instance.context.db
					.select()
					.from(schema.attestationListRefreshParts)
					.all(),
				lease: instance.context.db
					.select({ owner: schema.attestationListRefreshLease.owner })
					.from(schema.attestationListRefreshLease)
					.get()
			}).toStrictEqual({
				job: { nextPart: 1, completedBytes: 0 },
				parts: [],
				lease: { owner: 'replacement' }
			});
			instance.context.db.delete(schema.attestationListRefreshLease).run();
			await new AttestationListRefreshService(instance.context).advance();
			expect(
				instance.context.db
					.select({
						nextPart: schema.attestationListRefreshJobs.nextPart,
						completedBytes: schema.attestationListRefreshJobs.completedBytes
					})
					.from(schema.attestationListRefreshJobs)
					.get()
			).toStrictEqual({ nextPart: 2, completedBytes: job.bufferedBytes });
		});
	});
	it('refuses concurrent advancement while the durable lease is active', async () => {
		await seedList(2);
		await runInDurableObject(currentServer(), async (instance) => {
			await new AttestationListRefreshService(instance.context).advance();
			await new AttestationListRefreshService(instance.context).advance();
			const original = env.BLOBS.createMultipartUpload.bind(env.BLOBS);
			let competing: unknown;
			const create = vi
				.spyOn(env.BLOBS, 'createMultipartUpload')
				.mockImplementationOnce(async (key, options) => {
					competing = await new AttestationListRefreshService(
						instance.context
					).advance();
					return original(key, options);
				});
			try {
				await new AttestationListRefreshService(instance.context).advance();
			} finally {
				create.mockRestore();
			}
			expect(competing).toBe('stalled');
		});
	});

	it('retries the same part after a timed-out response finishes late', () =>
		withoutAlarmArming(async () => {
			await seedList(2);
			await runInDurableObject(currentServer(), async (instance) => {
				const job = await advanceTo(instance.context, 'uploading');
				if (job.uploadId === null) {
					throw new Error('The upload ID was not persisted');
				}
				const upload = env.BLOBS.resumeMultipartUpload(job.key, job.uploadId);
				const original = upload.uploadPart.bind(upload);
				const completion = Promise.withResolvers<undefined>();
				const part = vi
					.spyOn(upload, 'uploadPart')
					.mockImplementationOnce(async (number, body) => {
						const result = await original(number, body);
						await completion.promise;
						return result;
					});
				const resume = vi
					.spyOn(env.BLOBS, 'resumeMultipartUpload')
					.mockReturnValueOnce(upload);
				try {
					await expect(
						withDeadlineBudget(100, () =>
							new AttestationListRefreshService(instance.context).advance()
						)
					).rejects.toBeInstanceOf(SubrequestTimeoutError);
					expect(
						instance.context.db
							.select({ nextPart: schema.attestationListRefreshJobs.nextPart })
							.from(schema.attestationListRefreshJobs)
							.get()
					).toStrictEqual({ nextPart: 1 });
				} finally {
					completion.resolve(undefined);
					resume.mockRestore();
					part.mockRestore();
				}
				await new AttestationListRefreshService(instance.context).advance();
				expect(
					instance.context.db
						.select({
							nextPart: schema.attestationListRefreshJobs.nextPart,
							completedBytes: schema.attestationListRefreshJobs.completedBytes
						})
						.from(schema.attestationListRefreshJobs)
						.get()
				).toStrictEqual({ nextPart: 2, completedBytes: job.bufferedBytes });
			});
		}));

	it('discards a staged list when the source changes during upload and publishes the new empty revision', async () => {
		const { identity, parent } = await seedList(2);
		await runInDurableObject(currentServer(), async (instance) => {
			const job = await advanceTo(instance.context, 'uploading');
			if (job.uploadId === null) {
				throw new Error('The upload ID was not persisted');
			}
			const upload = env.BLOBS.resumeMultipartUpload(job.key, job.uploadId);
			const original = upload.uploadPart.bind(upload);
			const part = vi
				.spyOn(upload, 'uploadPart')
				.mockImplementationOnce(async (number, body) => {
					const result = await original(number, body);
					await env.CUPBOARD_DB.prepare(
						'UPDATE attestation_ref_storage SET readable = 0 WHERE tenant = ? AND store_path_hash = ?'
					)
						.bind(fixtureTenant, hash)
						.run();
					return result;
				});
			const resume = vi
				.spyOn(env.BLOBS, 'resumeMultipartUpload')
				.mockReturnValueOnce(upload);
			try {
				await new AttestationListRefreshService(instance.context).advance();
			} finally {
				resume.mockRestore();
				part.mockRestore();
			}
			const repository = new AttestationListRevisionRepository(
				instance.context.d1,
				fixtureTenant
			);
			const currentParent = {
				...parent,
				cacheGeneration:
					instance.context.cacheRepository.require(defaultCache()).generation
			};
			expect(await repository.readState(identity, currentParent)).toStrictEqual(
				{ status: 'pending' }
			);
			for (let pass = 0; pass < 20; pass++) {
				await new AttestationListRefreshService(instance.context).advance();
				const state = await repository.readState(identity, currentParent);
				if (state.status === 'ready') {
					break;
				}
			}
			expect(await repository.readState(identity, currentParent)).toStrictEqual(
				{ status: 'ready', key: undefined }
			);
			expect(await env.BLOBS.head(job.key)).toBeNull();
		});
	});
	it('allows another source to finish while unavailable metadata waits for retry', async () => {
		const unavailable = await seedList(1);
		const available = await seedList(
			1,
			storePathHashSchema.parse('b'.repeat(32))
		);
		await env.CUPBOARD_DB.prepare(
			'UPDATE attestation_ref_storage SET digest = ? WHERE tenant = ? AND store_path_hash = ?'
		)
			.bind('f'.repeat(64), fixtureTenant, hash)
			.run();
		await runInDurableObject(currentServer(), async (instance) => {
			const repository = new AttestationListRevisionRepository(
				instance.context.d1,
				fixtureTenant
			);
			const cacheGeneration =
				instance.context.cacheRepository.require(defaultCache()).generation;
			for (let pass = 0; pass < 20; pass++) {
				await new AttestationListRefreshService(instance.context).advance();
				const state = await repository.readState(available.identity, {
					...available.parent,
					cacheGeneration
				});
				if (state.status === 'ready') {
					break;
				}
			}
			const states = {
				unavailable: await repository.readState(unavailable.identity, {
					...unavailable.parent,
					cacheGeneration
				}),
				available: await repository.readState(available.identity, {
					...available.parent,
					cacheGeneration
				})
			};
			const availableVersion = await repository.get(available.identity);
			expect(states).toStrictEqual({
				unavailable: { status: 'pending' },
				available: { status: 'ready', key: availableVersion?.publishedKey }
			});
		});
	});
	it('returns at the deadline when an upload has not started consuming the producer stream', async () => {
		await seedList(2);
		await runInDurableObject(currentServer(), async (instance) => {
			const job = await advanceTo(instance.context, 'uploading');
			if (job.uploadId === null) {
				throw new Error('The upload ID was not persisted');
			}
			const upload = env.BLOBS.resumeMultipartUpload(job.key, job.uploadId);
			const started = Promise.withResolvers<undefined>();
			const part = vi
				.spyOn(upload, 'uploadPart')
				.mockImplementationOnce(async (number) => {
					await started.promise;
					return { partNumber: number, etag: 'abandoned-part' };
				});
			const resume = vi
				.spyOn(env.BLOBS, 'resumeMultipartUpload')
				.mockReturnValueOnce(upload);
			const advancing = withDeadlineBudget(100, () =>
				new AttestationListRefreshService(instance.context).advance()
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const watchdog = new Promise<'not-returned'>((resolve) => {
				timer = setTimeout(() => {
					resolve('not-returned');
				}, 500);
			});
			const observed = (async () => {
				try {
					await advancing;
					return 'resolved';
				} catch (error: unknown) {
					return error instanceof SubrequestTimeoutError
						? 'timeout'
						: 'unexpected-error';
				}
			})();
			const outcome = await Promise.race([observed, watchdog]);
			clearTimeout(timer);
			started.resolve(undefined);
			resume.mockRestore();
			part.mockRestore();
			await Promise.allSettled([advancing]);
			expect(outcome).toBe('timeout');
		});
	});
	it('resumes a source after its retry deadline and removes the retry record', async () => {
		const { identity, parent } = await seedList(1);
		await env.CUPBOARD_DB.prepare(
			'DELETE FROM cas_object_storage WHERE digest = ?'
		)
			.bind('1'.padStart(64, '0'))
			.run();
		await runInDurableObject(currentServer(), async (instance) => {
			await new AttestationListRefreshService(instance.context).advance();
			await new AttestationListRefreshService(instance.context).advance();
			const retry = instance.context.db
				.select()
				.from(schema.attestationListRefreshRetries)
				.get();
			if (retry === undefined) {
				throw new Error('The failure did not create a retry record');
			}
			expect({
				revision: retry.revision,
				failure: retry.failure,
				isDelayed: retry.notBefore > Date.now()
			}).toStrictEqual({
				revision: 2,
				failure: {
					reason: 'source-unavailable',
					digest: '1'.padStart(64, '0')
				},
				isDelayed: true
			});
			await env.CUPBOARD_DB.prepare(
				"INSERT INTO cas_object_storage (digest, size, incarnation, stored_at) VALUES (?, 64, 1, '2026-01-01T00:00:00.000Z')"
			)
				.bind('1'.padStart(64, '0'))
				.run();
			instance.context.db
				.update(schema.attestationListRefreshRetries)
				.set({ notBefore: 0 })
				.run();
			const repository = new AttestationListRevisionRepository(
				instance.context.d1,
				fixtureTenant
			);
			const currentParent = {
				...parent,
				cacheGeneration:
					instance.context.cacheRepository.require(defaultCache()).generation
			};
			for (let pass = 0; pass < 20; pass++) {
				await new AttestationListRefreshService(instance.context).advance();
				const state = await repository.readState(identity, currentParent);
				if (state.status === 'ready') {
					break;
				}
			}
			const version = await repository.get(identity);
			expect({
				state: await repository.readState(identity, currentParent),
				retries: instance.context.db
					.select()
					.from(schema.attestationListRefreshRetries)
					.all()
			}).toStrictEqual({
				state: { status: 'ready', key: version?.publishedKey },
				retries: []
			});
		});
	});
});
