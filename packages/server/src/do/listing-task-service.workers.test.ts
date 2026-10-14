import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import {
	type ArtifactTaskClaim,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CasObjectStore } from '../blob/cas-object-store.ts';
import { StoredNarListingGenerator } from '../blob/nar-listing-generation.ts';
import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitPath,
	currentServer,
	defaultCache,
	initialise,
	narInfoGeneration,
	recordTransition,
	resetTestServer,
	uploadMetadata,
	withoutAlarmArming
} from '../test-support.ts';

import { ArtifactJobService } from './artifact-job-service.ts';
import { ArtifactStagingService } from './artifact-staging-service.ts';
import { type ServerContext } from './context.ts';
import {
	type ListingTaskPreparation,
	ListingTaskService
} from './listing-task-service.ts';
import { NarListingReadService } from './nar-listing-read-service.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';

const hash = storePathHashSchema.parse('a'.repeat(32));
const expectedListing = JSON.stringify({
	version: 1,
	root: { type: 'regular', size: 5, narOffset: 96 }
});

async function sourceNar() {
	const parts = [
		'nix-archive-1',
		'(',
		'type',
		'regular',
		'contents',
		'hello',
		')'
	].map((value) => {
		const bytes = new TextEncoder().encode(value);
		const part = new Uint8Array(8 + Math.ceil(bytes.byteLength / 8) * 8);
		new DataView(part.buffer).setBigUint64(0, BigInt(bytes.byteLength), true);
		part.set(bytes, 8);
		return part;
	});
	const raw = new Uint8Array(
		parts.reduce((total, part) => total + part.byteLength, 0)
	);
	let offset = 0;
	for (const part of parts) {
		raw.set(part, offset);
		offset += part.byteLength;
	}
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(raw);
			controller.close();
		}
	});
	const compressed = new Response(input.pipeThrough(zstdCompressionStream()));
	const narBytes = new Uint8Array(await compressed.arrayBuffer());
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
	const fileDigest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', narBytes)
	);
	return {
		narBytes,
		narHash: NixSha256Hash.fromDigest(digest).value,
		narSize: raw.byteLength,
		fileHash: NixSha256Hash.fromDigest(fileDigest).value
	};
}

async function inSection<T>(
	run: (context: ServerContext) => Promise<T>
): Promise<T> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.criticalSection(() => run(instance.context))
	);
}

async function fixture() {
	const token = await initialise();
	await recordTransition('native-artifact-storage', 'expanded');
	await recordTransition('native-artifact-publication', 'complete');
	const nar = await sourceNar();
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
		const jobs = new ArtifactJobService(context);
		const job = await jobs.startInSection(defaultCache(), {
			kind: 'listing',
			generatorRevision: currentListingGeneratorRevision
		});
		jobs.enqueueInSection(job, {
			kind: 'nar',
			storePathHash: hash,
			generation,
			narHash: nar.narHash
		});
		jobs.checkpointInSection(job, undefined, true);
		const claimed = jobs.claimInSection(
			job.id,
			artifactTaskOwnerSchema.parse(crypto.randomUUID())
		);
		if (claimed.claim === undefined) {
			throw new Error('The fixture listing task was not claimed');
		}
		return claimed.claim;
	});
}

function generationOf(result: ListingTaskPreparation) {
	if (result.kind !== 'generate') {
		throw new Error('The fixture listing task could not generate');
	}
	return result;
}

async function generate(claim: ArtifactTaskClaim) {
	const prepared = generationOf(
		await inSection((context) =>
			new ListingTaskService(context).prepareInSection(claim)
		)
	);
	const upload = await env.BLOBS.createMultipartUpload(prepared.lease.key);
	const isRegistered = await inSection((context) =>
		Promise.resolve(
			new ArtifactStagingService(context).registerMultipartInSection(
				prepared.lease,
				upload.uploadId
			)
		)
	);
	if (!isRegistered) {
		throw new Error('The fixture multipart upload was not registered');
	}
	const generated = await new StoredNarListingGenerator({
		objects: env.BLOBS,
		source: prepared.source.key,
		expected: prepared.source.expected,
		upload,
		buffers: new NarReadBufferPool(),
		generatorRevision: prepared.generatorRevision
	}).run();
	if (generated.kind !== 'generated') {
		throw new Error('The fixture NAR did not verify');
	}
	const isSealed = await inSection((context) =>
		new ArtifactStagingService(context).sealInSection(
			prepared.lease,
			upload.uploadId,
			{ digest: generated.fact.digest, size: generated.fact.size }
		)
	);
	if (!isSealed) {
		throw new Error('The fixture listing was not sealed');
	}
	return { ...prepared, fact: generated.fact };
}

async function promote(value: Awaited<ReturnType<typeof generate>>) {
	const objects = new CasObjectStore(
		drizzle(env.CUPBOARD_DB, { schema: d1Schema }),
		env.BLOBS
	);
	await objects.promote(
		{
			...value.fact,
			async open() {
				const object = await env.BLOBS.get(value.lease.key);
				if (object === null) {
					throw new Error('The fixture staging bytes are missing');
				}
				return object.body;
			}
		},
		{ restoreMissingObject: true }
	);
}

async function state(context: ServerContext, claim: ArtifactTaskClaim) {
	return {
		job: new ArtifactJobService(context).summaryInSection(claim.jobId),
		artifacts: context.db.select().from(schema.artifacts).all(),
		stages: context.db.select().from(schema.artifactStages).all(),
		facts: await context.d1.select().from(d1Schema.listingFact).all(),
		references: await context.d1.select().from(d1Schema.artifactReference).all()
	};
}

describe('listing task workflow', () => {
	beforeEach(resetTestServer);
	afterEach(() => vi.restoreAllMocks());

	it('renews the task and staging together while refusing renewal after source revocation', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const prepared = generationOf(
				await inSection((context) =>
					new ListingTaskService(context).prepareInSection(claim)
				)
			);
			vi.setSystemTime(new Date(Date.parse(claim.leaseExpiresAt) - 30_000));
			const expected = new Date(
				Date.parse(claim.leaseExpiresAt) + 30_000
			).toISOString();
			await inSection(async (context) => {
				const workflow = new ListingTaskService(context);
				expect({
					deadline: await workflow.renewInSection(prepared.lease),
					task: context.db
						.select({ deadline: schema.artifactTasks.leaseExpiresAt })
						.from(schema.artifactTasks)
						.get(),
					stage: new ArtifactStagingService(context).deadlineInSection(
						prepared.lease
					)
				}).toStrictEqual({
					deadline: expected,
					task: { deadline: expected },
					stage: expected
				});
				if (claim.source.kind !== 'nar') {
					throw new Error('Expected a NAR source');
				}
				await new PathReadAuthorityService(context).revoke(
					context.cacheRepository.require(defaultCache()),
					[{ storePathHash: hash, generation: claim.source.generation }]
				);
				const before = await state(context, claim);
				expect({
					deadline: await workflow.renewInSection(prepared.lease),
					state: await state(context, claim)
				}).toStrictEqual({ deadline: undefined, state: before });
			});
		}));

	it('resumes a sealed staging object without reading the NAR or allocating another reservation', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const value = await generate(claim);
			await inSection(async (context) => {
				const before = await state(context, claim);
				const get = vi.spyOn(context.env.BLOBS, 'get');
				expect({
					result: await new ListingTaskService(context).prepareInSection(claim),
					state: await state(context, claim),
					reads: get.mock.calls
				}).toStrictEqual({
					result: { kind: 'promote', lease: value.lease, fact: value.fact },
					state: before,
					reads: []
				});
			});
		}));

	it('generates a stored NAR listing, publishes measured CAS bytes and completes its durable task', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const value = await generate(claim);
			await promote(value);
			await inSection(async (context) => {
				expect(
					await new ListingTaskService(context).completeInSection(
						value.lease,
						value.fact
					)
				).toStrictEqual({ kind: 'completed' });
				const current = await state(context, claim);
				const response = await new NarListingReadService(context).serve(
					new Request('https://cache.example/listing'),
					defaultCache(),
					hash
				);
				expect({
					body: await response.text(),
					status: response.status,
					job: current.job,
					artifacts: current.artifacts.map((row) => row.state),
					stages: current.stages.map((row) => ({
						state: row.state,
						sealed: row.writesSealed,
						digest: row.digest,
						size: row.size
					}))
				}).toStrictEqual({
					body: expectedListing,
					status: 200,
					job: {
						...current.job,
						state: 'complete',
						progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
						completedAt: current.job?.updatedAt
					},
					artifacts: ['live'],
					stages: [
						{
							state: 'retired',
							sealed: true,
							digest: value.fact.digest,
							size: value.fact.size
						}
					]
				});
			});
			const cleanup = await runInDurableObject(currentServer(), (instance) =>
				new ArtifactStagingService(instance.context).collect()
			);
			expect(cleanup).toStrictEqual({ removed: 1, pending: false });
		}));

	it('refuses an unpromoted measurement without recording a shared fact or publishing a reference', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const value = await generate(claim);
			await inSection(async (context) => {
				const before = await state(context, claim);
				expect({
					result: await new ListingTaskService(context).completeInSection(
						value.lease,
						value.fact
					),
					state: await state(context, claim)
				}).toStrictEqual({ result: { kind: 'bytes-missing' }, state: before });
			});
		}));

	it.each([
		'cancelled',
		'expired',
		'tenant-stopped',
		'revoked-parent',
		'changed-digest',
		'changed-size',
		'changed-nar'
	] as const)(
		'refuses %s before recording facts or changing task progress',
		(reason) =>
			withoutAlarmArming(async () => {
				const claim = await fixture();
				const value = await generate(claim);
				await promote(value);
				if (reason === 'expired') {
					vi.setSystemTime(new Date(claim.leaseExpiresAt));
				}
				await inSection(async (context) => {
					let fact: NarListingFact = value.fact;
					switch (reason) {
						case 'expired': {
							break;
						}
						case 'tenant-stopped': {
							await context.d1
								.update(d1Schema.tenant)
								.set({ status: 'offboarding' })
								.where(eq(d1Schema.tenant.id, fixtureTenant));
							break;
						}
						case 'cancelled': {
							new ArtifactJobService(context).cancelInSection(claim.jobId);
							break;
						}
						case 'revoked-parent': {
							if (claim.source.kind !== 'nar') {
								throw new Error('Expected a NAR source');
							}
							await new PathReadAuthorityService(context).revoke(
								context.cacheRepository.require(defaultCache()),
								[{ storePathHash: hash, generation: claim.source.generation }]
							);
							break;
						}
						case 'changed-digest': {
							fact = {
								...fact,
								digest: sha256HexDigestSchema.parse('f'.repeat(64))
							};
							break;
						}
						case 'changed-size': {
							fact = { ...fact, size: fact.size + 1 };
							break;
						}
						case 'changed-nar': {
							fact = {
								...fact,
								narHash: NixSha256Hash.fromDigest(new Uint8Array(32)).value
							};
							break;
						}
					}
					const before = await state(context, claim);
					expect({
						result: await new ListingTaskService(context).completeInSection(
							value.lease,
							fact
						),
						state: await state(context, claim)
					}).toStrictEqual({ result: { kind: 'unavailable' }, state: before });
				});
			})
	);

	it('completes a later task by reference without allocating staging or reading NAR bytes', () =>
		withoutAlarmArming(async () => {
			const first = await fixture();
			const value = await generate(first);
			await promote(value);
			await inSection(async (context) => {
				const workflow = new ListingTaskService(context);
				await workflow.completeInSection(value.lease, value.fact);
				const jobs = new ArtifactJobService(context);
				const job = await jobs.startInSection(defaultCache(), {
					kind: 'listing',
					generatorRevision: currentListingGeneratorRevision
				});
				jobs.enqueueInSection(job, first.source);
				jobs.checkpointInSection(job, undefined, true);
				const second = jobs.claimInSection(
					job.id,
					artifactTaskOwnerSchema.parse(crypto.randomUUID())
				).claim;
				if (second === undefined) {
					throw new Error('The second listing task was not claimed');
				}
				const before = await state(context, second);
				const get = vi.spyOn(context.env.BLOBS, 'get');
				expect(await workflow.prepareInSection(second)).toStrictEqual({
					kind: 'reused'
				});
				const after = await state(context, second);
				expect({
					artifacts: after.artifacts,
					stages: after.stages,
					facts: after.facts,
					references: after.references,
					reads: get.mock.calls,
					progress: after.job?.progress
				}).toStrictEqual({
					artifacts: before.artifacts,
					stages: before.stages,
					facts: before.facts,
					references: before.references,
					reads: [],
					progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 }
				});
			});
		}));
});
