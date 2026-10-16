import {
	sha256HexDigestSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	currentListingGeneratorRevision,
	type ListingGeneratorRevision,
	listingGeneratorRevisionSchema
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ByteBufferPool } from '../blob/byte-buffers.ts';
import { ForwardListingCaptureProducer } from '../blob/forward-listing-capture.ts';
import { NarListingMetadataSink } from '../blob/nar-listing-metadata.ts';
import { NarListingOutput } from '../blob/nar-listing-output.ts';
import { verifyStoredNar } from '../blob/nar-verify.ts';
import { R2RequestAdmission } from '../blob/r2-request-admission.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as schema from '../db/d1-schema.ts';
import { ForwardListingStageStore } from '../db/forward-listing-staging.ts';
import { ListingFactStore } from '../db/listing-facts.ts';
import { casObjectKey } from '../http/http.ts';
import { clearBlobStorage } from '../test-support.ts';

import { sharedListingTaskFixture } from './shared-listing-task-worker.test-support.ts';
import { SharedListingTaskWorker } from './shared-listing-task-worker.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const retryAt = isoTimestamp(new Date(Date.parse(now) + 60_000));
const listing = new TextEncoder().encode(
	'{"version":1,"root":{"type":"regular","size":5,"narOffset":96}}'
);

async function fixture(
	revision: ListingGeneratorRevision = currentListingGeneratorRevision
) {
	const value = await sharedListingTaskFixture();
	const { database } = value;
	await database.insert(schema.deploymentTransition).values({
		id: 'forward-listing-staging',
		state: 'complete',
		updatedAt: now
	});
	if (revision !== currentListingGeneratorRevision) {
		await database
			.update(schema.sharedListingJob)
			.set({ generatorRevision: revision });
	}
	const provisional = new ForwardListingStageStore(database);
	const reservation = await provisional.reserve(
		{
			tenant: tenantIdSchema.parse('discovery-first'),
			uploadId: uploadIdSchema.parse('native-upload'),
			owner: '00000000-0000-4000-8000-000000000002',
			narHash: value.narHash,
			generatorRevision: revision
		},
		now
	);
	if (reservation.kind !== 'writing') {
		throw new Error('The forward listing reservation is missing');
	}
	const lease = reservation.lease;
	const upload = await env.BLOBS.createMultipartUpload(lease.key);
	if (!(await provisional.registerMultipart(lease, upload.uploadId, now))) {
		throw new Error('The native owner could not register its multipart upload');
	}
	const output = new NarListingOutput({
		upload,
		narHash: value.narHash,
		outputBuffers: value.dependencies.outputBuffers
	});
	const sink = new NarListingMetadataSink({
		output,
		seal: async (fact) => {
			const measurement = { digest: fact.digest, size: fact.size };
			if (
				!(await provisional.recordSeal(
					lease,
					upload.uploadId,
					measurement,
					now
				))
			) {
				throw new Error('The native owner could not seal its listing');
			}
		},
		abandon: async () => {
			await provisional.retire(lease, now, upload.uploadId);
		}
	});
	async function capture() {
		const deferred: Promise<void>[] = [];
		const result = await verifyStoredNar(
			env.BLOBS,
			value.source,
			{ narHash: value.narHash, narSize: value.raw.byteLength },
			{
				buffers: value.dependencies.buffers,
				metadata: {
					sink,
					defer: (completion) => {
						deferred.push(completion);
					}
				}
			}
		);
		await Promise.all(deferred);
		if (!result.ok) {
			throw new Error('The native NAR did not verify');
		}
		const row = await database.select().from(schema.forwardListingStage).get();
		if (row?.state !== 'ready') {
			throw new Error('The verified forward listing was not sealed');
		}
		return output.finish();
	}
	const outputBuffers = new ByteBufferPool({
		buffers: 0,
		bufferSize: 5 * 1024 * 1024
	});
	const worker = new SharedListingTaskWorker({
		...value.dependencies,
		outputBuffers
	});
	return { ...value, worker, provisional, lease, upload, sink, capture };
}

describe('global execution of forward listings', () => {
	beforeEach(clearBlobStorage);
	it('adopts owned producer output without rereading the NAR and preserves CAS bytes after late producer cancellation', async () => {
		const value = await sharedListingTaskFixture();
		await value.database.insert(schema.deploymentTransition).values({
			id: 'forward-listing-staging',
			state: 'complete',
			updatedAt: now
		});
		const deferred: Promise<void>[] = [];
		const producer = new ForwardListingCaptureProducer({
			database: env.CUPBOARD_DB,
			blobs: env.BLOBS,
			outputBuffers: value.dependencies.outputBuffers,
			now: () => now,
			defer: (completion) => {
				deferred.push(completion);
			}
		});
		const capture = producer.capture(
			{
				tenant: tenantIdSchema.parse('native-forward-tenant'),
				uploadId: uploadIdSchema.parse('owned-upload'),
				owner: '00000000-0000-4000-8000-000000000003',
				narHash: value.narHash,
				generatorRevision: currentListingGeneratorRevision
			},
			new R2RequestAdmission(6)
		);
		if (capture === undefined) {
			throw new Error('The owned producer declined capture');
		}
		const verified = await verifyStoredNar(
			env.BLOBS,
			value.source,
			{ narHash: value.narHash, narSize: value.raw.byteLength },
			{ buffers: value.dependencies.buffers, metadata: capture }
		);
		await Promise.all(deferred);
		const stage = await value.database
			.select()
			.from(schema.forwardListingStage)
			.get();
		if (!verified.ok || stage?.digest === null || stage?.digest === undefined) {
			throw new Error('The owned capture did not produce a sealed listing');
		}
		const reads = vi.spyOn(env.BLOBS, 'get');
		try {
			const worker = new SharedListingTaskWorker(value.dependencies);
			const result = await worker.run(value.first.request);
			await capture.sink.abort(new Error('late native cancellation'));
			const sourceReads = reads.mock.calls.map(([key]) => key);
			const cas = await value.database.select().from(schema.casObject).get();
			const object =
				cas === undefined
					? undefined
					: await env.BLOBS.head(casObjectKey(stage.digest, cas.incarnation));
			expect({
				result:
					result.kind === 'recorded'
						? { kind: result.kind, outcome: result.outcome.kind }
						: result,
				sourceReads,
				objectBytes: object?.size,
				forward: await value.database.select().from(schema.forwardListingStage),
				retention: await value.database
					.select({
						digest: schema.sharedListingOutputReference.digest,
						size: schema.sharedListingOutputReference.size
					})
					.from(schema.sharedListingOutputReference),
				tenantReferences: await value.database
					.select()
					.from(schema.artifactReference)
			}).toStrictEqual({
				result: { kind: 'recorded', outcome: 'generated' },
				sourceReads: [stage.r2Key],
				objectBytes: listing.byteLength,
				forward: [],
				retention: [{ digest: stage.digest, size: listing.byteLength }],
				tenantReferences: []
			});
		} finally {
			reads.mockRestore();
		}
	});

	it.each([0, 2])(
		'adopts verified forward output with %i free output buffers and no NAR reread',
		async (buffers) => {
			const value = await fixture();
			const { database, lease, provisional } = value;
			const fact = await value.capture();
			const worker = new SharedListingTaskWorker({
				...value.dependencies,
				outputBuffers: new ByteBufferPool({
					buffers,
					bufferSize: 5 * 1024 * 1024
				})
			});
			const reads = vi.spyOn(env.BLOBS, 'get');
			const creates = vi.spyOn(env.BLOBS, 'createMultipartUpload');
			try {
				const result = await worker.run(value.first.request);
				const observedReads = reads.mock.calls.map((call) => call[0]);
				await value.sink.abort(new Error('Late native cancellation'));
				const cas = await database.select().from(schema.casObject).get();
				const object =
					cas === undefined
						? undefined
						: await env.BLOBS.get(casObjectKey(cas.digest, cas.incarnation));
				const summary = await value.jobs.find(value.first.job.id);
				expect({
					kind: result.kind,
					outcome: 'outcome' in result ? result.outcome.kind : undefined,
					reads: observedReads,
					multipartCreates: creates.mock.calls,
					bytes:
						object === undefined || object === null
							? undefined
							: new Uint8Array(await object.arrayBuffer()),
					facts: await database.select().from(schema.listingFact),
					progress: summary?.progress,
					forwardStages: await database
						.select()
						.from(schema.forwardListingStage),
					sharedStages: await database
						.select({
							id: schema.sharedListingStage.id,
							state: schema.sharedListingStage.state
						})
						.from(schema.sharedListingStage),
					retainedOutputs: await database
						.select({
							digest: schema.sharedListingOutputReference.digest,
							size: schema.sharedListingOutputReference.size
						})
						.from(schema.sharedListingOutputReference),
					tenantReferences: await database
						.select()
						.from(schema.artifactReference),
					tenantPresence: await database.select().from(schema.tenantCasBlob),
					oldOwnerCanWrite: await provisional.canWrite(lease, now),
					oldOwnerCanRetire: await provisional.retire(
						lease,
						now,
						value.upload.uploadId
					)
				}).toStrictEqual({
					kind: 'recorded',
					outcome: 'generated',
					reads: [lease.key],
					multipartCreates: [],
					bytes: listing,
					facts: [{ ...fact, createdAt: now }],
					progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
					forwardStages: [],
					sharedStages: [{ id: lease.id, state: 'retired' }],
					retainedOutputs: [{ digest: fact.digest, size: fact.size }],
					tenantReferences: [],
					tenantPresence: [],
					oldOwnerCanWrite: false,
					oldOwnerCanRetire: false
				});
			} finally {
				reads.mockRestore();
				creates.mockRestore();
			}
		}
	);

	it('recovers transferred output after a CAS failure without another multipart upload or NAR read', async () => {
		const value = await fixture();
		await value.capture();
		const head = env.BLOBS.head.bind(env.BLOBS);
		const failure = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation((key) =>
				key.startsWith('cas/')
					? Promise.reject(new Error('CAS storage unavailable'))
					: head(key)
			);
		let result;
		try {
			result = await value.worker.run(value.first.request);
		} finally {
			failure.mockRestore();
		}
		const transferred = await value.database
			.select({
				id: schema.sharedListingStage.id,
				state: schema.sharedListingStage.state,
				sealed: schema.sharedListingStage.writesSealed
			})
			.from(schema.sharedListingStage);
		expect({
			result,
			transferred,
			forwardStages: await value.database
				.select()
				.from(schema.forwardListingStage),
			facts: await value.database.select().from(schema.listingFact)
		}).toStrictEqual({
			result: { kind: 'deferred', reason: 'storage', retryAt },
			transferred: [{ id: value.lease.id, state: 'ready', sealed: true }],
			forwardStages: [],
			facts: []
		});
		vi.setSystemTime(new Date(retryAt));
		const reads = vi.spyOn(env.BLOBS, 'get');
		const creates = vi.spyOn(env.BLOBS, 'createMultipartUpload');
		try {
			const recovered = await value.worker.run(value.first.request);
			expect({
				kind: recovered.kind,
				outcome: 'outcome' in recovered ? recovered.outcome.kind : undefined,
				reads: reads.mock.calls.map((call) => call[0]),
				multipartCreates: creates.mock.calls,
				stages: await value.database
					.select({
						id: schema.sharedListingStage.id,
						state: schema.sharedListingStage.state
					})
					.from(schema.sharedListingStage)
			}).toStrictEqual({
				kind: 'recorded',
				outcome: 'generated',
				reads: [value.lease.key],
				multipartCreates: [],
				stages: [{ id: value.lease.id, state: 'retired' }]
			});
		} finally {
			reads.mockRestore();
			creates.mockRestore();
		}
	});

	it.each(['missing', 'corrupt'] as const)(
		'does not record a fact or retention reference for %s forward bytes',
		async (state) => {
			const value = await fixture();
			await value.capture();
			switch (state) {
				case 'missing': {
					await env.BLOBS.delete(value.lease.key);
					break;
				}
				case 'corrupt': {
					const bytes = new Uint8Array(listing);
					bytes[0] = 0;
					await env.BLOBS.put(value.lease.key, bytes);
					break;
				}
			}
			const reads = vi.spyOn(env.BLOBS, 'get');
			try {
				const result = await value.worker.run(value.first.request);
				expect({
					result,
					reads: reads.mock.calls.map((call) => call[0]),
					facts: await value.database.select().from(schema.listingFact),
					retainedOutputs: await value.database
						.select()
						.from(schema.sharedListingOutputReference)
				}).toStrictEqual({
					result: { kind: 'deferred', reason: 'storage', retryAt },
					reads: [value.lease.key],
					facts: [],
					retainedOutputs: []
				});
			} finally {
				reads.mockRestore();
			}
		}
	);

	it.each(['pending', 'retired', 'expired'] as const)(
		'does not adopt %s forward output',
		async (state) => {
			const value = await fixture();
			if (state !== 'pending') {
				await value.capture();
			}
			if (state === 'retired') {
				await value.provisional.retire(value.lease, now, value.upload.uploadId);
			}
			const at =
				state === 'expired'
					? isoTimestamp(new Date(Date.parse(value.lease.cleanupAfter) + 1))
					: now;
			vi.setSystemTime(new Date(at));
			const before = await value.database
				.select()
				.from(schema.forwardListingStage);
			const reads = vi.spyOn(env.BLOBS, 'get');
			try {
				const result = await value.worker.run(value.first.request);
				const next = isoTimestamp(new Date(Date.parse(at) + 60_000));
				expect({
					result,
					reads: reads.mock.calls,
					facts: await value.database.select().from(schema.listingFact),
					sharedStages: await value.database
						.select()
						.from(schema.sharedListingStage),
					forwardStages: await value.database
						.select()
						.from(schema.forwardListingStage)
				}).toStrictEqual({
					result: { kind: 'deferred', reason: 'local-capacity', retryAt: next },
					reads: [],
					facts: [],
					sharedStages: [],
					forwardStages: before
				});
			} finally {
				reads.mockRestore();
			}
		}
	);

	it.each([undefined, 'expanded'] as const)(
		'does not transfer forward output before its transition is complete (%s)',
		async (state) => {
			const value = await fixture();
			await value.capture();
			await value.database
				.delete(schema.deploymentTransition)
				.where(eq(schema.deploymentTransition.id, 'forward-listing-staging'));
			if (state !== undefined) {
				await value.database.insert(schema.deploymentTransition).values({
					id: 'forward-listing-staging',
					state,
					updatedAt: now
				});
			}
			const before = await value.database
				.select()
				.from(schema.forwardListingStage);
			const result = await value.worker.run(value.first.request);
			expect({
				result,
				forwardStages: await value.database
					.select()
					.from(schema.forwardListingStage),
				sharedStages: await value.database
					.select()
					.from(schema.sharedListingStage)
			}).toStrictEqual({
				result: { kind: 'deferred', reason: 'local-capacity', retryAt },
				forwardStages: before,
				sharedStages: []
			});
		}
	);

	it.each(['absent', 'matching', 'conflicting'] as const)(
		'requires a matching immutable fact for an unknown forward generator (%s)',
		async (known) => {
			const revision = listingGeneratorRevisionSchema.parse('future-revision');
			const value = await fixture(revision);
			const { upload, provisional, lease, database } = value;
			const part = await upload.uploadPart(1, listing);
			await upload.complete([part]);
			const digest = sha256HexDigestSchema.parse(await sha256HexBytes(listing));
			await provisional.recordSeal(
				lease,
				upload.uploadId,
				{
					digest,
					size: listing.byteLength
				},
				now
			);
			const fact = {
				narHash: value.narHash,
				generatorRevision: revision,
				format: 1 as const,
				digest:
					known === 'conflicting'
						? sha256HexDigestSchema.parse('a'.repeat(64))
						: digest,
				size: listing.byteLength
			};
			if (known !== 'absent') {
				await new ListingFactStore(database).record(fact);
			}
			const reads = vi.spyOn(env.BLOBS, 'get');
			try {
				const result = await value.worker.run(value.first.request);
				expect({
					kind: result.kind,
					outcome:
						'outcome' in result
							? {
									kind: result.outcome.kind,
									reason:
										'reason' in result.outcome
											? result.outcome.reason
											: undefined
								}
							: undefined,
					facts: await database.select().from(schema.listingFact),
					retainedOutputs: await database
						.select({
							digest: schema.sharedListingOutputReference.digest,
							size: schema.sharedListingOutputReference.size
						})
						.from(schema.sharedListingOutputReference),
					reads: reads.mock.calls.map((call) => call[0])
				}).toStrictEqual({
					kind: 'recorded',
					outcome:
						known === 'matching'
							? { kind: 'generated', reason: undefined }
							: known === 'absent'
								? { kind: 'skipped', reason: 'unsupported-generator-revision' }
								: { kind: 'failed', reason: 'generation-failed' },
					facts: known === 'absent' ? [] : [{ ...fact, createdAt: now }],
					retainedOutputs:
						known === 'matching' ? [{ digest, size: listing.byteLength }] : [],
					reads: known === 'matching' ? [lease.key] : []
				});
			} finally {
				reads.mockRestore();
			}
		}
	);

	it('rechecks cancellation after reading transferred listing bytes', async () => {
		const value = await fixture();
		await value.capture();
		const get = env.BLOBS.get.bind(env.BLOBS);
		const reads = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation(async (key, options) => {
				if (key === value.lease.key) {
					await value.jobs.cancel(value.first.job, now);
				}
				return get(key, options);
			});
		try {
			const result = await value.worker.run(value.first.request);
			expect({
				result,
				reads: reads.mock.calls.map((call) => call[0]),
				facts: await value.database.select().from(schema.listingFact),
				retainedOutputs: await value.database
					.select()
					.from(schema.sharedListingOutputReference)
			}).toStrictEqual({
				result: { kind: 'unavailable' },
				reads: [value.lease.key],
				facts: [],
				retainedOutputs: []
			});
		} finally {
			reads.mockRestore();
		}
	});
});
