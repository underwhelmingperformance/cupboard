import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import {
	artifactJobGenerationSchema,
	type ArtifactTaskClaim,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	listingGeneratorRevisionSchema,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactOutputBuffer } from '../blob/artifact-multipart-writer.ts';
import {
	ByteBufferPool,
	type ByteBufferPoolState
} from '../blob/byte-buffers.ts';
import { CasObjectStore } from '../blob/cas-object-store.ts';
import { StoredNarListingGenerator } from '../blob/nar-listing-generation.ts';
import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { casObjectKey } from '../http/http.ts';
import {
	ArtifactQueueConsumer,
	type ArtifactQueueDependencies
} from '../routing/artifact-queue-consumer.ts';
import { type ArtifactQueueMessage } from '../routing/artifact-queue-message.ts';
import { tenantServer } from '../routing/durable-object.ts';
import {
	ArtifactTaskOwnershipLostError,
	ListingTaskWorker,
	type ListingTaskWorkerDependencies
} from '../routing/listing-task-worker.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	adminGrants,
	commitPath,
	currentServer,
	defaultCache,
	initialise,
	issueTokenForTenant,
	namedCache,
	narInfoGeneration,
	provisionNamedTenant,
	pushPath,
	pushPathToTenant,
	putTestCache,
	recordTransition,
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

async function sourceNar(contents = 'hello') {
	const parts = [
		'nix-archive-1',
		'(',
		'type',
		'regular',
		'contents',
		contents,
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
	run: (context: ServerContext) => Promise<T> | T
): Promise<T> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.criticalSection(() =>
			Promise.resolve(run(instance.context))
		)
	);
}

async function fixture(
	input?: Awaited<ReturnType<typeof sourceNar>>,
	hasSibling = false
) {
	const token = await initialise();
	await recordTransition('native-artifact-storage', 'expanded');
	await recordTransition('native-artifact-publication', 'complete');
	const nar = input ?? (await sourceNar());
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
	const siblingNar = hasSibling ? await sourceNar('world') : undefined;
	const siblingHash = storePathHashSchema.parse('b'.repeat(32));
	if (siblingNar !== undefined) {
		await commitPath(
			token,
			uploadMetadata({
				storePathHash: siblingHash,
				narHash: siblingNar.narHash,
				narSize: siblingNar.narSize,
				fileHash: siblingNar.fileHash,
				fileSize: siblingNar.narBytes.byteLength
			}),
			siblingNar
		);
	}
	const siblingGeneration = hasSibling
		? narInfoGenerationSchema.parse(await narInfoGeneration(siblingHash))
		: undefined;

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
		if (siblingGeneration !== undefined && siblingNar !== undefined) {
			jobs.enqueueInSection(job, {
				kind: 'nar',
				storePathHash: siblingHash,
				generation: siblingGeneration,
				narHash: siblingNar.narHash
			});
		}

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

interface ListingTenantFixture {
	readonly tenant: TenantId;
	readonly server: ReturnType<typeof currentServer>;
	readonly claim: ArtifactTaskClaim;
}

async function withOtherListingTenant(
	nar: Awaited<ReturnType<typeof sourceNar>>,
	run: (fixture: ListingTenantFixture) => Promise<void>
): Promise<void> {
	const tenant = tenantIdSchema.parse('listing-generation-other');
	const server = tenantServer(env, tenant);
	await withoutAlarmArming(async () => {
		const issuer = await provisionNamedTenant(tenant);
		const token = await issueTokenForTenant(server, issuer, adminGrants());
		await pushPathToTenant(
			tenant,
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
		const claim = await runInDurableObject(server, (instance) =>
			instance.context.criticalSection(async () => {
				const context = instance.context;
				const cache = context.cacheRepository.require(defaultCache());
				const source = context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							eq(schema.narInfos.storePathHash, hash)
						)
					)
					.get();
				if (source === undefined) {
					throw new Error('The second tenant did not publish its NAR');
				}
				const jobs = new ArtifactJobService(context);
				const job = await jobs.startInSection(defaultCache(), {
					kind: 'listing',
					generatorRevision: currentListingGeneratorRevision
				});
				jobs.enqueueInSection(job, {
					kind: 'nar',
					storePathHash: hash,
					generation: source.generation,
					narHash: source.narHash
				});
				jobs.checkpointInSection(job, undefined, true);
				const result = jobs.claimInSection(
					job.id,
					artifactTaskOwnerSchema.parse(crypto.randomUUID())
				);
				if (result.claim === undefined) {
					throw new Error('The second tenant listing task was not claimed');
				}
				return result.claim;
			})
		);
		await run({ tenant, server, claim });
	}, server);
}

async function fullStagingReuseFixture(
	mode: 'queued' | 'discovered' = 'queued'
) {
	const original = await fixture(undefined, true);
	const generated = await generate(original);
	await promote(generated);
	await currentServer().completeListingTask(generated.lease, generated.fact);
	await currentServer().collectArtifactStaging();
	const blockerCache = namedCache('staging-blocker');
	const blockerHash = storePathHashSchema.parse('c'.repeat(32));
	const blockerNar = await sourceNar('blocker');
	const token = await initialise();
	await putTestCache(token, blockerCache);
	await pushPath(
		token,
		uploadMetadata({
			storePathHash: blockerHash,
			narHash: blockerNar.narHash,
			narSize: blockerNar.narSize,
			fileHash: blockerNar.fileHash,
			fileSize: blockerNar.narBytes.byteLength
		}),
		blockerCache,
		blockerNar
	);
	const blockers = await inSection(async (context) => {
		const jobs = new ArtifactJobService(context);
		const dispatches = new ArtifactJobDispatchService(context);
		dispatches.reserveInSection();
		const first = jobs.claimInSection(
			original.jobId,
			artifactTaskOwnerSchema.parse(crypto.randomUUID())
		).claim;
		if (first === undefined) {
			throw new Error('The first staging blocker was not claimed');
		}
		const cache = context.cacheRepository.require(blockerCache);
		const source = context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, blockerHash)
				)
			)
			.get();
		if (source === undefined) {
			throw new Error('The independent staging blocker was not published');
		}
		const job = await jobs.startInSection(blockerCache, {
			kind: 'listing',
			generatorRevision: currentListingGeneratorRevision
		});
		jobs.enqueueInSection(job, {
			kind: 'nar',
			storePathHash: blockerHash,
			generation: source.generation,
			narHash: blockerNar.narHash
		});
		jobs.checkpointInSection(job, undefined, true);
		dispatches.reserveInSection();
		const second = jobs.claimInSection(
			job.id,
			artifactTaskOwnerSchema.parse(crypto.randomUUID())
		).claim;
		if (second === undefined) {
			throw new Error('The second staging blocker was not claimed');
		}
		return [first, second];
	});
	for (const claim of blockers) {
		generationOf(await currentServer().prepareListingTask(claim));
	}
	const candidate = await inSection(async (context) => {
		const jobs = new ArtifactJobService(context);
		const job = await jobs.startInSection(defaultCache(), {
			kind: 'listing',
			generatorRevision: currentListingGeneratorRevision
		});
		if (mode === 'queued') {
			jobs.enqueueInSection(job, original.source);
			jobs.checkpointInSection(job, undefined, true);
		}
		return { id: job.id, generation: job.generation };
	});
	return { candidate, blockers, generated };
}

function generationOf(result: ListingTaskPreparation) {
	if (result.kind !== 'generate') {
		throw new Error('The fixture listing task could not generate');
	}
	return result;
}

async function generate(
	claim: ArtifactTaskClaim,
	outputBuffer?: ArtifactOutputBuffer
) {
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
		outputBuffer,
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

async function promote(
	value: Pick<Awaited<ReturnType<typeof generate>>, 'lease' | 'fact'>
) {
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

function taskRetryState(context: ServerContext) {
	return {
		jobs: context.db.select().from(schema.artifactJobs).all(),
		tasks: context.db.select().from(schema.artifactTasks).all(),
		admissions: context.db.select().from(schema.artifactAdmissions).all()
	};
}

function taskExecutionState(task: typeof schema.artifactTasks.$inferSelect) {
	const { leaseExpiresAt, ...state } = task;
	return { ...state, hasLease: leaseExpiresAt !== null };
}

function workerRpc(
	overrides: Partial<ListingTaskWorkerDependencies['server']>
): ListingTaskWorkerDependencies['server'] {
	const real = currentServer();
	return {
		prepareListingTaskWithCapacity: (claim, canGenerate) =>
			real.prepareListingTaskWithCapacity(claim, canGenerate),
		registerArtifactMultipart: (lease, id) =>
			real.registerArtifactMultipart(lease, id),
		sealArtifactStaging: (lease, id, measurement) =>
			real.sealArtifactStaging(lease, id, measurement),
		renewListingTask: (lease) => real.renewListingTask(lease),
		completeListingTask: (lease, fact) => real.completeListingTask(lease, fact),
		retireArtifactStaging: (lease) => real.retireArtifactStaging(lease),
		finishArtifactTask: (claim, outcome) =>
			real.finishArtifactTask(claim, outcome),
		...overrides
	};
}

function artifactMessage(body: unknown, actions: unknown[]): Message {
	return {
		id: 'artifact-message',
		timestamp: new Date(),
		attempts: 1,
		body,
		ack: () => {
			actions.push({ action: 'ack' });
		},
		retry: (options) => {
			actions.push({ action: 'retry', delaySeconds: options?.delaySeconds });
		}
	};
}

type ArtifactQueueRpc = ReturnType<ArtifactQueueDependencies['serverFor']>;

function consumerRpc(overrides: Partial<ArtifactQueueRpc>): ArtifactQueueRpc {
	const real = currentServer();
	return {
		...workerRpc({}),
		claimArtifactTask: (job, owner, kind) =>
			real.claimArtifactTask(job, owner, kind),
		claimAdmittedArtifactTask: (admission, owner, kind) =>
			real.claimAdmittedArtifactTask(admission, owner, kind),
		requestArtifactDispatch: (job) => real.requestArtifactDispatch(job),
		requeueArtifactTask: (claim) => real.requeueArtifactTask(claim),
		requeueArtifactTaskWithDeadline: (claim, deadline) =>
			real.requeueArtifactTaskWithDeadline(claim, deadline),
		...overrides
	};
}

function artifactConsumer(
	sent: ArtifactQueueMessage[],
	executeTask?: ArtifactQueueDependencies['executeTask'],
	overrides: Partial<ArtifactQueueRpc> = {}
) {
	return new ArtifactQueueConsumer({
		blobs: env.BLOBS,
		database: env.CUPBOARD_DB,
		buffers: new NarReadBufferPool(),
		serverFor: () => consumerRpc(overrides),
		queue: {
			send: (body) => {
				sent.push(body);
				return Promise.resolve({
					metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } }
				});
			}
		},
		executeTask
	});
}

async function deliverArtifactBatch(shouldFail = false) {
	return runInDurableObject(currentServer(), async (instance) => {
		const messages: ArtifactQueueMessage[] = [];
		const result = await new ArtifactQueueDispatchService(instance.context, {
			sendBatch: (batch) => {
				if (shouldFail) {
					return Promise.reject(new Error('artifact queue unavailable'));
				}
				messages.push(...Array.from(batch, (message) => message.body));
				return Promise.resolve({
					metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } }
				});
			}
		}).run();
		return {
			result,
			messages,
			admissions: instance.context.db
				.select()
				.from(schema.artifactAdmissions)
				.all()
				.map((row) => row.id)
		};
	});
}

function jobMessage(claim: ArtifactTaskClaim): ArtifactQueueMessage {
	return {
		kind: 'artifact-job',
		tenant: fixtureTenant,
		job: { id: claim.jobId, generation: claim.jobGeneration },
		artifactKind: 'listing'
	};
}

async function admittedMessage(
	claim: ArtifactTaskClaim,
	mode: 'generate' | 'reuse' = 'generate'
) {
	const body = jobMessage(claim);
	const admission = await inSection((context) => {
		const result = new ArtifactAdmissionService(context).reserveInSection(
			body.job,
			claim.id,
			mode
		);
		if (result.kind !== 'admitted') {
			throw new Error('The queue fixture admission was refused');
		}
		return Promise.resolve(result.admission);
	});
	return { ...body, admission };
}

describe('listing task workflow', () => {
	beforeEach(resetTestServer);
	afterEach(() => vi.restoreAllMocks());

	it('coalesces native generation across tenants and publishes the result by reference in both caches', () =>
		withoutAlarmArming(async () => {
			const nar = await sourceNar();
			const first = await fixture(nar);
			await withOtherListingTenant(nar, async (other) => {
				const prepared = generationOf(
					await currentServer().prepareListingTask(first)
				);
				const waiting = await other.server.prepareListingTask(other.claim);
				const stages = await runInDurableObject(other.server, (instance) =>
					instance.context.db.select().from(schema.artifactStages).all()
				);
				const retryAt = isoTimestamp(new Date(Date.now() + 60_000));
				expect({ waiting, stages }).toStrictEqual({
					waiting: {
						kind: 'generation-busy',
						retryAt
					},
					stages: []
				});
				const get = vi.spyOn(env.BLOBS, 'get');
				const dependencies = {
					database: env.CUPBOARD_DB,
					blobs: env.BLOBS,
					buffers: new NarReadBufferPool()
				};
				const firstResult = await new ListingTaskWorker({
					...dependencies,
					server: currentServer()
				}).run(first);
				const secondResult = await new ListingTaskWorker({
					...dependencies,
					server: other.server
				}).run(other.claim);
				const firstProgress = await inSection(
					(context) =>
						new ArtifactJobService(context).summaryInSection(first.jobId)
							?.progress
				);
				const secondProgress = await runInDurableObject(
					other.server,
					(instance) =>
						new ArtifactJobService(instance.context).summaryInSection(
							other.claim.jobId
						)?.progress
				);
				const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
				const references = await database
					.select({ tenant: d1Schema.artifactReference.tenant })
					.from(d1Schema.artifactReference)
					.orderBy(d1Schema.artifactReference.tenant);
				expect({
					firstResult,
					secondResult,
					firstProgress,
					secondProgress,
					narReads: get.mock.calls.filter(
						([key]) => key === prepared.source.key
					).length,
					references,
					secondStages: await runInDurableObject(other.server, (instance) =>
						instance.context.db.select().from(schema.artifactStages).all()
					)
				}).toStrictEqual({
					firstResult: { kind: 'completed' },
					secondResult: { kind: 'reused' },
					firstProgress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
					secondProgress: {
						discovered: 1,
						completed: 1,
						skipped: 0,
						failed: 0
					},
					narReads: 1,
					references: [{ tenant: other.tenant }, { tenant: fixtureTenant }],
					secondStages: []
				});
			});
		}));

	it('defers a shared-generation waiter until the recorded lease deadline without retaining an admission', () =>
		withoutAlarmArming(async () => {
			const nar = await sourceNar();
			const first = await fixture(nar);
			await withOtherListingTenant(nar, async (other) => {
				await currentServer().prepareListingTask(first);
				const retryAt = isoTimestamp(new Date(Date.now() + 60_000));
				vi.setSystemTime(new Date(Date.now() + 15_000));
				const queued = await other.server.requeueArtifactTask(other.claim);
				if (queued.kind !== 'admitted') {
					throw new Error('The shared-generation waiter was not admitted');
				}
				const body = {
					...jobMessage(other.claim),
					tenant: other.tenant,
					admission: queued.admission
				};
				const actions: unknown[] = [];
				const sent: ArtifactQueueMessage[] = [];
				const get = vi.spyOn(env.BLOBS, 'get');
				const consumer = new ArtifactQueueConsumer({
					database: env.CUPBOARD_DB,
					blobs: env.BLOBS,
					buffers: new NarReadBufferPool(),
					queue: {
						send(message) {
							sent.push(message);
							return Promise.resolve({
								metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } }
							});
						}
					},
					serverFor: () => other.server
				});
				await consumer.handleMessage(artifactMessage(body, actions));
				const state = await runInDurableObject(other.server, (instance) => ({
					task: instance.context.db
						.select({
							state: schema.artifactTasks.state,
							retryAt: schema.artifactTasks.nextAttemptAt
						})
						.from(schema.artifactTasks)
						.where(eq(schema.artifactTasks.id, other.claim.id))
						.get(),
					admissions: instance.context.db
						.select()
						.from(schema.artifactAdmissions)
						.all(),
					stages: instance.context.db.select().from(schema.artifactStages).all()
				}));
				expect({ actions, sent, reads: get.mock.calls, state }).toStrictEqual({
					actions: [{ action: 'ack' }],
					sent: [],
					reads: [],
					state: {
						task: { state: 'pending', retryAt },
						admissions: [],
						stages: []
					}
				});
			});
		}));

	it('does not revive sealed output after its recovery deadline when cleanup has not run', () =>
		withoutAlarmArming(async () => {
			const original = await fixture();
			const sealed = await generate(original);
			vi.setSystemTime(new Date(sealed.lease.cleanupAfter));
			const replacement = await inSection((context) => {
				const result = new ArtifactJobService(context).claimInSection(
					original.jobId,
					artifactTaskOwnerSchema.parse(crypto.randomUUID())
				);
				if (result.claim === undefined) {
					throw new Error('The expired listing task was not reclaimed');
				}
				return result.claim;
			});
			const prepared = await currentServer().prepareListingTask(replacement);
			expect({
				kind: prepared.kind,
				isFresh:
					prepared.kind === 'generate' && prepared.lease.id !== sealed.lease.id
			}).toStrictEqual({ kind: 'generate', isFresh: true });
		}));

	it.each(['claim', 'source'] as const)(
		'refuses renewal and completion after the shared %s is replaced',
		(mode) =>
			withoutAlarmArming(async () => {
				const original = await fixture();
				const generated = await generate(original);
				await promote(generated);
				const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
				if (mode === 'claim') {
					await env.CUPBOARD_DB.prepare(
						'UPDATE listing_generation SET generation = generation + 1'
					).run();
				}
				if (mode === 'source' && original.source.kind === 'nar') {
					await database
						.update(d1Schema.blobState)
						.set({ incarnation: sql`incarnation + 1` })
						.where(eq(d1Schema.blobState.narHash, original.source.narHash));
					await database
						.update(d1Schema.objectIncarnation)
						.set({ incarnation: sql`incarnation + 1` })
						.where(
							and(
								eq(d1Schema.objectIncarnation.kind, 'nar'),
								eq(d1Schema.objectIncarnation.objectId, original.source.narHash)
							)
						);
				}
				const before = await inSection((context) => state(context, original));
				expect({
					renewed: await currentServer().renewListingTask(generated.lease),
					completed: await currentServer().completeListingTask(
						generated.lease,
						generated.fact
					),
					state: await inSection((context) => state(context, original))
				}).toStrictEqual({
					renewed: undefined,
					completed: { kind: 'unavailable' },
					state: before
				});
			})
	);

	it.each([
		'missing',
		'owner',
		'tenant',
		'nar',
		'revision',
		'generation',
		'incarnation'
	] as const)(
		'refuses a staging RPC packet with an invalid shared %s token',
		(mode) =>
			withoutAlarmArming(async () => {
				const original = await fixture();
				const generated = await generate(original);
				await promote(generated);
				const token = generated.lease.listingGeneration;
				if (token === undefined) {
					throw new Error('The producer has no captured computation token');
				}
				let packet = generated.lease;
				switch (mode) {
					case 'missing': {
						packet = { ...packet, listingGeneration: undefined };
						break;
					}
					case 'owner': {
						packet = {
							...packet,
							listingGeneration: {
								...token,
								owner: artifactTaskOwnerSchema.parse(crypto.randomUUID())
							}
						};
						break;
					}
					case 'tenant': {
						packet = {
							...packet,
							listingGeneration: {
								...token,
								tenant: tenantIdSchema.parse('another-tenant')
							}
						};
						break;
					}
					case 'nar': {
						packet = {
							...packet,
							listingGeneration: {
								...token,
								narHash: NixSha256Hash.fromDigest(new Uint8Array(32)).value
							}
						};
						break;
					}
					case 'revision': {
						packet = {
							...packet,
							listingGeneration: {
								...token,
								generatorRevision: listingGeneratorRevisionSchema.parse('other')
							}
						};
						break;
					}
					case 'generation': {
						packet = {
							...packet,
							listingGeneration: { ...token, generation: token.generation + 1 }
						};
						break;
					}
					case 'incarnation': {
						packet = {
							...packet,
							listingGeneration: {
								...token,
								sourceIncarnation: token.sourceIncarnation + 1
							}
						};
						break;
					}
				}
				vi.setSystemTime(new Date(Date.now() + 15_000));
				const snapshot = () =>
					inSection(async (context) => ({
						local: await state(context, original),
						shared: await context.d1.select().from(d1Schema.listingGeneration)
					}));
				const before = await snapshot();
				expect({
					renewed: await currentServer().renewListingTask(packet),
					completed: await currentServer().completeListingTask(
						packet,
						generated.fact
					),
					state: await snapshot()
				}).toStrictEqual({
					renewed: undefined,
					completed: { kind: 'unavailable' },
					state: before
				});
			})
	);

	it('uses a preleased output buffer for native listing generation', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			if (claim.source.kind !== 'nar') {
				throw new Error('The listing source is not a NAR');
			}
			const pool = new ByteBufferPool({
				buffers: 1,
				bufferSize: 5 * 1024 * 1024
			});
			const buffer = ArtifactOutputBuffer.tryAcquire(pool);
			if (buffer === undefined) {
				throw new Error('The output buffer was not reserved');
			}
			try {
				const generated = await generate(claim, buffer);
				const listingBytes = new TextEncoder().encode(expectedListing);
				const digest = sha256HexDigestSchema.parse(
					await sha256HexBytes(listingBytes)
				);
				expect({ fact: generated.fact, pool: pool.state }).toStrictEqual({
					fact: {
						narHash: claim.source.narHash,
						generatorRevision: currentListingGeneratorRevision,
						format: 1,
						digest,
						size: listingBytes.byteLength
					},
					pool: { free: 1, allocations: 1 }
				});
			} finally {
				buffer.release();
			}
		}));

	it('defers a delayed retry through RPC without reserving admission credits', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const retryAt = isoTimestamp(new Date(Date.now() + 120_000));
			const result = await currentServer().requeueArtifactTaskWithDeadline(
				claim,
				retryAt
			);
			const later = isoTimestamp(new Date(Date.now() + 240_000));
			const repeated = await currentServer().requeueArtifactTaskWithDeadline(
				claim,
				later
			);
			const immediate = await currentServer().requeueArtifactTask(claim);
			const early = await currentServer().claimArtifactTask(
				{ id: claim.jobId, generation: claim.jobGeneration },
				crypto.randomUUID(),
				'listing'
			);
			const admissions = await inSection((context) =>
				Promise.resolve(
					context.db.select().from(schema.artifactAdmissions).all()
				)
			);
			expect({ result, repeated, immediate, early, admissions }).toStrictEqual({
				result: { kind: 'deferred', retryAt },
				repeated: result,
				immediate: { kind: 'unavailable' },
				early: { kind: 'idle', pending: true },
				admissions: []
			});
		}));

	it('requeues one owned task idempotently through the trusted RPC', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture(undefined, true);
			const first = await currentServer().requeueArtifactTask(claim);
			if (first.kind !== 'admitted') {
				throw new Error('The owned retry was not admitted');
			}
			const repeated = await currentServer().requeueArtifactTask(claim);
			const pending = await inSection((context) =>
				Promise.resolve({
					admissions: context.db
						.select()
						.from(schema.artifactAdmissions)
						.all()
						.map((row) => row.id),
					states: context.db
						.select()
						.from(schema.artifactTasks)
						.all()
						.map((row) => row.state),
					progress: new ArtifactJobService(context).summaryInSection(
						claim.jobId
					)?.progress
				})
			);
			expect({ repeated, pending }).toStrictEqual({
				repeated: first,
				pending: {
					admissions: [first.admission.id],
					states: ['pending', 'pending'],
					progress: { discovered: 2, completed: 0, skipped: 0, failed: 0 }
				}
			});
			const replacement = await currentServer().claimAdmittedArtifactTask(
				first.admission,
				crypto.randomUUID(),
				'listing'
			);
			expect({
				kind: replacement.kind,
				taskId:
					replacement.kind === 'claimed' ? replacement.claim.id : undefined,
				oldRetry: await currentServer().requeueArtifactTask(claim)
			}).toStrictEqual({
				kind: 'claimed',
				taskId: claim.id,
				oldRetry: { kind: 'unavailable' }
			});
		}));

	it.each(['suspended', 'offboarding', 'local-offboarding'] as const)(
		'refuses the requeue RPC while the tenant is %s without changing task state',
		(status) =>
			withoutAlarmArming(async () => {
				const claim = await fixture();
				if (status === 'local-offboarding') {
					await inSection((context) => {
						context.offboarding = true;
						return Promise.resolve();
					});
				} else {
					await drizzle(env.CUPBOARD_DB)
						.update(d1Schema.tenant)
						.set({ status })
						.where(eq(d1Schema.tenant.id, fixtureTenant));
				}
				const before = await inSection((context) =>
					Promise.resolve(taskRetryState(context))
				);
				const result = await currentServer().requeueArtifactTask(claim);
				const after = await inSection((context) =>
					Promise.resolve(taskRetryState(context))
				);
				expect({ result, after }).toStrictEqual({
					result: { kind: 'unavailable' },
					after: before
				});
			})
	);

	it('rejects malformed ownership at the requeue RPC boundary', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const before = await inSection((context) =>
				Promise.resolve(taskRetryState(context))
			);
			await expect(
				runInDurableObject(currentServer(), (instance) =>
					instance.requeueArtifactTask(
						Object.assign({}, claim, { extra: true })
					)
				)
			).rejects.toThrow(/Unrecognized key/);
			expect(
				await inSection((context) => Promise.resolve(taskRetryState(context)))
			).toStrictEqual(before);
		}));

	it('keeps a capacity-refused requeue RPC pending without releasing unsealed staging', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture(undefined, true);
			const leases = await inSection(async (context) => {
				const next = new ArtifactJobService(context).claimInSection(
					claim.jobId,
					artifactTaskOwnerSchema.parse(crypto.randomUUID())
				).claim;
				if (next === undefined) {
					throw new Error('The capacity fixture sibling was not claimed');
				}
				const listings = new ListingTaskService(context);
				return [
					generationOf(await listings.prepareInSection(claim)).lease,
					generationOf(await listings.prepareInSection(next)).lease
				];
			});
			const result = await currentServer().requeueArtifactTask(claim);
			const after = await inSection((context) =>
				Promise.resolve({
					stages: context.db
						.select()
						.from(schema.artifactStages)
						.orderBy(schema.artifactStages.id)
						.all()
						.map((row) => row.id),
					admissions: context.db.select().from(schema.artifactAdmissions).all(),
					states: context.db
						.select()
						.from(schema.artifactTasks)
						.all()
						.map((row) => ({ id: row.id, state: row.state }))
						.toSorted((a, b) => byCodeUnit(a.id, b.id)),
					progress: new ArtifactJobService(context).summaryInSection(
						claim.jobId
					)?.progress
				})
			);
			expect({ result, after }).toStrictEqual({
				result: { kind: 'capacity', retryAt: claim.leaseExpiresAt },
				after: {
					stages: leases.map((lease) => lease.id).toSorted(byCodeUnit),
					admissions: [],
					states: leases
						.map((lease, index) => ({
							id: lease.claim.id,
							state: index === 0 ? 'pending' : 'claimed'
						}))
						.toSorted((a, b) => byCodeUnit(a.id, b.id)),
					progress: { discovered: 2, completed: 0, skipped: 0, failed: 0 }
				}
			});
		}));

	it.each([
		'local-capacity',
		'transport',
		'unavailable',
		'bytes-missing',
		'over-quota'
	] as const)(
		'durably defers admitted %s and acknowledges its spent message',
		(reason) =>
			withoutAlarmArming(async () => {
				const claim = await fixture(undefined, true);
				vi.setSystemTime(new Date(claim.leaseExpiresAt));
				const body = await admittedMessage(claim);
				const before = await inSection((context) =>
					Promise.resolve(taskRetryState(context))
				);
				const actions: unknown[] = [];
				const sent: ArtifactQueueMessage[] = [];
				const execute = vi.fn<
					NonNullable<ArtifactQueueDependencies['executeTask']>
				>(() =>
					reason === 'transport'
						? Promise.reject(new Error('transient source read'))
						: Promise.resolve({ kind: reason })
				);
				await artifactConsumer(sent, execute).handleMessage(
					artifactMessage(body, actions)
				);
				await artifactConsumer(sent, execute).handleMessage(
					artifactMessage(body, actions)
				);
				const owned = execute.mock.calls[0]?.[1];
				if (owned === undefined) {
					throw new Error('The admitted retry task was not executed');
				}
				const after = await inSection((context) =>
					Promise.resolve(taskRetryState(context))
				);
				const retryAt = isoTimestamp(new Date(Date.now() + 60_000));
				expect({
					actions,
					sent,
					executions: execute.mock.calls.map(([, task]) => task.id),
					tasks: after.tasks.map((task) => taskExecutionState(task)),
					admissions: after.admissions
				}).toStrictEqual({
					actions: [{ action: 'ack' }, { action: 'ack' }],
					sent: [],
					executions: [claim.id],
					admissions: [],
					tasks: before.tasks.map((task) =>
						task.id === claim.id
							? {
									...taskExecutionState(task),
									state: 'pending',
									claimGeneration: claim.generation + 1,
									jobGeneration: claim.jobGeneration,
									owner: owned.owner,
									hasLease: false,
									nextAttemptAt: retryAt
								}
							: taskExecutionState(task)
					)
				});
			})
	);

	it('requeues admitted staging-capacity refusal immediately without reusing its ticket', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const body = await admittedMessage(claim);
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			const predictedExpiry = isoTimestamp(new Date(Date.now() + 120_000));
			const execute = vi.fn(() =>
				Promise.resolve({ kind: 'capacity' as const, retryAt: predictedExpiry })
			);
			await artifactConsumer(sent, execute).handleMessage(
				artifactMessage(body, actions)
			);
			const after = await inSection((context) =>
				Promise.resolve({
					tasks: context.db
						.select()
						.from(schema.artifactTasks)
						.all()
						.map((row) => ({
							id: row.id,
							state: row.state,
							nextAttemptAt: row.nextAttemptAt
						})),
					admissions: context.db
						.select()
						.from(schema.artifactAdmissions)
						.all()
						.map((row) => ({
							taskId: row.taskId,
							replacement: row.id !== body.admission.id,
							claimed: row.claim !== null
						}))
				})
			);
			expect({ actions, sent, after }).toStrictEqual({
				actions: [{ action: 'ack' }],
				sent: [],
				after: {
					tasks: [
						{
							id: claim.id,
							state: 'pending',
							nextAttemptAt: isoTimestamp(new Date())
						}
					],
					admissions: [{ taskId: claim.id, replacement: true, claimed: false }]
				}
			});
		}));

	it('keeps admitted staging-capacity pending at a full pool', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture(undefined, true);
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const body = await admittedMessage(claim);
			const execute = vi.fn<
				NonNullable<ArtifactQueueDependencies['executeTask']>
			>(async (server, owned) => {
				const prepared = generationOf(
					await server.prepareListingTaskWithCapacity(owned, true)
				);
				await inSection(async (context) => {
					const sibling = new ArtifactJobService(context).claimInSection(
						owned.jobId,
						artifactTaskOwnerSchema.parse(crypto.randomUUID())
					).claim;
					if (sibling === undefined) {
						throw new Error('The capacity consumer sibling was not claimed');
					}
					generationOf(
						await new ListingTaskService(context).prepareInSection(sibling)
					);
				});
				return { kind: 'capacity', retryAt: prepared.lease.expiresAt };
			});
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			await artifactConsumer(sent, execute).handleMessage(
				artifactMessage(body, actions)
			);
			const after = await inSection((context) =>
				Promise.resolve({
					task: context.db
						.select()
						.from(schema.artifactTasks)
						.where(eq(schema.artifactTasks.id, claim.id))
						.get()?.state,
					admissions: context.db.select().from(schema.artifactAdmissions).all(),
					stages: context.db
						.select()
						.from(schema.artifactStages)
						.all()
						.map((row) => row.state),
					progress: new ArtifactJobService(context).summaryInSection(
						claim.jobId
					)?.progress
				})
			);
			expect({ actions, sent, after }).toStrictEqual({
				actions: [{ action: 'ack' }],
				sent: [],
				after: {
					task: 'pending',
					admissions: [],
					stages: ['pending', 'pending'],
					progress: { discovered: 2, completed: 0, skipped: 0, failed: 0 }
				}
			});
		}));

	it('does not requeue admitted work after its execution budget expires', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const body = await admittedMessage(claim);
			const started = Promise.withResolvers<undefined>();
			const real = currentServer();
			const retry = vi.fn<ArtifactQueueRpc['requeueArtifactTask']>((owned) =>
				real.requeueArtifactTask(owned)
			);
			const delayed = vi.fn<
				ArtifactQueueRpc['requeueArtifactTaskWithDeadline']
			>((owned, deadline) =>
				real.requeueArtifactTaskWithDeadline(owned, deadline)
			);
			const execute = vi.fn<
				NonNullable<ArtifactQueueDependencies['executeTask']>
			>((_server, _owned, options) => {
				const work = Promise.withResolvers<never>();
				options.signal?.addEventListener(
					'abort',
					() => {
						work.reject(options.signal?.reason);
					},
					{ once: true }
				);
				started.resolve(undefined);
				return work.promise;
			});
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
			try {
				const handling = artifactConsumer(sent, execute, {
					requeueArtifactTask: retry,
					requeueArtifactTaskWithDeadline: delayed
				}).handleMessage(artifactMessage(body, actions));
				await started.promise;
				await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
				await handling;
				expect({
					actions,
					sent,
					retries: retry.mock.calls,
					delayed: delayed.mock.calls,
					aborted: execute.mock.calls[0]?.[2].signal?.aborted
				}).toStrictEqual({
					actions: [{ action: 'retry', delaySeconds: 60 }],
					sent: [],
					retries: [],
					delayed: [],
					aborted: true
				});
			} finally {
				vi.useFakeTimers({ toFake: ['Date'] });
			}
		}));

	it.each(['lost-reply', 'older-tenant', 'invalid-reply'] as const)(
		'recovers an admitted retry after %s without claiming a sibling',
		(mode) =>
			withoutAlarmArming(async () => {
				const claim = await fixture(undefined, true);
				vi.setSystemTime(new Date(claim.leaseExpiresAt));
				const body = await admittedMessage(claim);
				const real = currentServer();
				const expectedDeadline = isoTimestamp(new Date(Date.now() + 60_000));
				const retry = vi.fn<
					ArtifactQueueRpc['requeueArtifactTaskWithDeadline']
				>(async (owned, deadline) => {
					if (mode === 'lost-reply') {
						await real.requeueArtifactTaskWithDeadline(owned, deadline);
						throw new Error('retry reply lost');
					}
					if (mode === 'older-tenant') {
						throw new Error(
							'The RPC receiver does not implement requeueArtifactTaskWithDeadline'
						);
					}
					return { kind: 'deferred', retryAt: deadline, extra: true };
				});
				const actions: unknown[] = [];
				const sent: ArtifactQueueMessage[] = [];
				const execute = vi.fn(() =>
					Promise.resolve({ kind: 'local-capacity' as const })
				);
				const overrides = { requeueArtifactTaskWithDeadline: retry };
				await artifactConsumer(sent, execute, overrides).handleMessage(
					artifactMessage(body, actions)
				);
				const beforeReplay = await inSection((context) =>
					Promise.resolve(taskRetryState(context))
				);
				await artifactConsumer(sent, execute, overrides).handleMessage(
					artifactMessage(body, actions)
				);
				const afterReplay = await inSection((context) =>
					Promise.resolve(taskRetryState(context))
				);
				expect({
					actions,
					sent,
					calls: retry.mock.calls.map(([owned, deadline]) => ({
						taskId: owned.id,
						deadline
					})),
					executions: execute.mock.calls.length,
					changedByReplay: afterReplay,
					originalState: beforeReplay.tasks.find((task) => task.id === claim.id)
						?.state,
					siblingGenerations: beforeReplay.tasks
						.filter((task) => task.id !== claim.id)
						.map((task) => task.claimGeneration),
					admissionCount: beforeReplay.admissions.length
				}).toStrictEqual({
					actions: [{ action: 'retry', delaySeconds: 60 }, { action: 'ack' }],
					sent: [],
					calls: [
						{
							taskId: claim.id,
							deadline: expectedDeadline
						}
					],
					executions: 1,
					changedByReplay: beforeReplay,
					originalState: mode === 'lost-reply' ? 'pending' : 'claimed',
					siblingGenerations: [0],
					admissionCount: mode === 'lost-reply' ? 0 : 1
				});
			})
	);

	it.each(['reclaimed', 'cancelled'] as const)(
		'acknowledges an admitted retry whose task was %s during execution',
		(mode) =>
			withoutAlarmArming(async () => {
				const claim = await fixture(undefined, true);
				vi.setSystemTime(new Date(claim.leaseExpiresAt));
				const body = await admittedMessage(claim);
				const before = await inSection((context) =>
					Promise.resolve(context.db.select().from(schema.artifactTasks).all())
				);
				const real = currentServer();
				const retry = vi.fn<
					ArtifactQueueRpc['requeueArtifactTaskWithDeadline']
				>((owned, deadline) =>
					real.requeueArtifactTaskWithDeadline(owned, deadline)
				);
				const replacementOwner = artifactTaskOwnerSchema.parse(
					crypto.randomUUID()
				);
				const execute = vi.fn<
					NonNullable<ArtifactQueueDependencies['executeTask']>
				>(async (_server, owned) => {
					if (mode === 'reclaimed') {
						vi.setSystemTime(new Date(owned.leaseExpiresAt));
					}
					await inSection((context) => {
						const jobs = new ArtifactJobService(context);
						if (mode === 'cancelled') {
							jobs.cancelInSection(owned.jobId);
							return Promise.resolve();
						}
						const next = jobs.claimTaskInSection(
							{ id: owned.jobId, generation: owned.jobGeneration },
							owned.id,
							owned.generation,
							replacementOwner
						);
						if (next === undefined) {
							throw new Error(
								'The ownership replacement fixture did not claim its task'
							);
						}
						return Promise.resolve();
					});
					return { kind: 'local-capacity' };
				});
				const actions: unknown[] = [];
				const sent: ArtifactQueueMessage[] = [];
				await artifactConsumer(sent, execute, {
					requeueArtifactTaskWithDeadline: retry
				}).handleMessage(artifactMessage(body, actions));
				await artifactConsumer(sent, execute).handleMessage(
					artifactMessage(body, actions)
				);
				const after = await inSection((context) =>
					Promise.resolve({
						tasks: context.db
							.select()
							.from(schema.artifactTasks)
							.all()
							.map((row) => ({ id: row.id, generation: row.claimGeneration })),
						job: new ArtifactJobService(context).summaryInSection(claim.jobId)
					})
				);
				expect({
					actions,
					sent,
					retryCalls: retry.mock.calls.length,
					executions: execute.mock.calls.length,
					tasks: after.tasks,
					state: after.job?.state,
					progress: after.job?.progress
				}).toStrictEqual({
					actions: [{ action: 'ack' }, { action: 'ack' }],
					sent: [],
					retryCalls: 1,
					executions: 1,
					tasks: before.map((task) => ({
						id: task.id,
						generation:
							task.id === claim.id
								? claim.generation + (mode === 'reclaimed' ? 2 : 1)
								: task.claimGeneration
					})),
					state: mode === 'cancelled' ? 'cancelled' : 'running',
					progress: { discovered: 2, completed: 0, skipped: 0, failed: 0 }
				});
			})
	);

	it('recovers a deferred admitted task after replacement queue delivery fails', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const body = await admittedMessage(claim);
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			const outputs: Awaited<ReturnType<typeof generate>>[] = [];
			await artifactConsumer(sent, async (_server, owned) => {
				outputs.push(await generate(owned));
				return { kind: 'bytes-missing' };
			}).handleMessage(artifactMessage(body, actions));
			const produced = outputs[0];
			if (produced === undefined) {
				throw new Error('The retry fixture did not seal its output');
			}
			const retained = await currentServer().collectArtifactStaging();
			vi.setSystemTime(new Date(Date.now() + 60_000));
			const failed = await deliverArtifactBatch(true);
			vi.setSystemTime(new Date(Date.now() + 30_000));
			const delivered = await deliverArtifactBatch();
			const replacement = delivered.messages[0];
			if (replacement === undefined) {
				throw new Error('The replacement artifact message was not delivered');
			}
			const reads = vi.spyOn(env.BLOBS, 'get');
			let sourceReads: readonly unknown[];
			try {
				await artifactConsumer(sent).handleMessage(
					artifactMessage(replacement, actions)
				);
				await artifactConsumer(sent).handleMessage(
					artifactMessage(body, actions)
				);
				sourceReads = reads.mock.calls.filter(
					([key]) => key === produced.source.key
				);
			} finally {
				reads.mockRestore();
			}
			const progress = await inSection((context) =>
				Promise.resolve(
					new ArtifactJobService(context).summaryInSection(claim.jobId)
						?.progress
				)
			);
			expect({
				actions,
				sent,
				failed,
				reusedTicket: delivered.admissions,
				delivery: delivered.result,
				progress,
				retained,
				sourceReads
			}).toStrictEqual({
				actions: [{ action: 'ack' }, { action: 'ack' }, { action: 'ack' }],
				sent: [],
				failed: {
					result: { selectedJobs: 1, sent: 0, failed: 1 },
					messages: [],
					admissions: failed.admissions
				},
				reusedTicket: failed.admissions,
				delivery: { selectedJobs: 1, sent: 1, failed: 0 },
				progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
				retained: {
					removed: 0,
					pending: true,
					nextWakeAt: produced.lease.cleanupAfter
				},
				sourceReads: []
			});
		}));

	it('consumes an admitted listing without allowing its replay to claim a sibling task', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture(undefined, true);
			const initialDispatchAt = Date.now();
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const body = await admittedMessage(claim);
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			await artifactConsumer(sent).handleMessage(
				artifactMessage(body, actions)
			);
			await artifactConsumer(sent).handleMessage(
				artifactMessage(body, actions)
			);
			const after = await inSection((context) => state(context, claim));
			const queueState = await inSection((context) =>
				Promise.resolve({
					admissions: context.db.select().from(schema.artifactAdmissions).all(),
					job: context.db
						.select({ nextDispatchAt: schema.artifactJobs.nextDispatchAt })
						.from(schema.artifactJobs)
						.get()
				})
			);
			expect({
				actions,
				sent,
				progress: after.job?.progress,
				queueState
			}).toStrictEqual({
				actions: [{ action: 'ack' }, { action: 'ack' }],
				sent: [],
				progress: { discovered: 2, completed: 1, skipped: 0, failed: 0 },
				queueState: {
					admissions: [],
					job: { nextDispatchAt: initialDispatchAt }
				}
			});
		}));

	it('claims the specific admitted task through the trusted RPC', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const body = await admittedMessage(claim);
			const owner = crypto.randomUUID();
			const expectedDeadline = isoTimestamp(new Date(Date.now() + 60_000));
			const result = await currentServer().claimAdmittedArtifactTask(
				body.admission,
				owner,
				'listing'
			);
			expect(result).toStrictEqual({
				kind: 'claimed',
				claim: {
					...claim,
					generation: 2,
					owner,
					leaseExpiresAt: expectedDeadline
				},
				definition: {
					kind: 'listing',
					generatorRevision: currentListingGeneratorRevision
				}
			});
		}));

	it('does not consume admission for a different artifact kind', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const body = await admittedMessage(claim);
			const before = await inSection((context) =>
				Promise.resolve(
					context.db.select().from(schema.artifactAdmissions).all()
				)
			);
			const result = await currentServer().claimAdmittedArtifactTask(
				body.admission,
				crypto.randomUUID(),
				'build-log'
			);
			expect({
				result,
				admissions: await inSection((context) =>
					Promise.resolve(
						context.db.select().from(schema.artifactAdmissions).all()
					)
				)
			}).toStrictEqual({
				result: { kind: 'idle', pending: false },
				admissions: before
			});
		}));

	it('releases admitted work when a failed task finishes', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const body = await admittedMessage(claim);
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			await artifactConsumer(sent, async (server, current) => {
				await server.finishArtifactTask(current, 'failed');
				return { kind: 'failed', reason: 'invalid-nar' };
			}).handleMessage(artifactMessage(body, actions));
			const after = await inSection((context) => state(context, claim));
			expect({
				actions,
				sent,
				progress: after.job?.progress,
				admissions: await inSection((context) =>
					Promise.resolve(
						context.db.select().from(schema.artifactAdmissions).all()
					)
				)
			}).toStrictEqual({
				actions: [{ action: 'ack' }],
				sent: [],
				progress: { discovered: 1, completed: 0, skipped: 0, failed: 1 },
				admissions: []
			});
		}));

	it.each(['expired', 'cancelled', 'suspended'] as const)(
		'acknowledges %s admission without executing another task',
		(reason) =>
			withoutAlarmArming(async () => {
				const claim = await fixture();
				vi.setSystemTime(new Date(claim.leaseExpiresAt));
				const body = await admittedMessage(claim);
				switch (reason) {
					case 'expired': {
						vi.setSystemTime(new Date(body.admission.expiresAt));
						break;
					}
					case 'cancelled': {
						await inSection((context) =>
							Promise.resolve(
								new ArtifactJobService(context).cancelInSection(claim.jobId)
							)
						);
						break;
					}
					case 'suspended': {
						await drizzle(env.CUPBOARD_DB, { schema: d1Schema })
							.update(d1Schema.tenant)
							.set({ status: 'suspended' })
							.where(eq(d1Schema.tenant.id, fixtureTenant))
							.run();
						break;
					}
				}
				const actions: unknown[] = [];
				const sent: ArtifactQueueMessage[] = [];
				const execute = vi.fn(() =>
					Promise.resolve({ kind: 'completed' } as const)
				);
				await artifactConsumer(sent, execute).handleMessage(
					artifactMessage(body, actions)
				);
				expect({ actions, sent, executions: execute.mock.calls }).toStrictEqual(
					{ actions: [{ action: 'ack' }], sent: [], executions: [] }
				);
			})
	);

	it('runs independent admitted tasks from the same job concurrently', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture(undefined, true);
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const bodies = await inSection((context) => {
				const tasks = context.db.select().from(schema.artifactTasks).all();
				const admissions = new ArtifactAdmissionService(context);
				return Promise.resolve(
					tasks.map((task) => {
						const message = jobMessage(claim);
						const result = admissions.reserveInSection(message.job, task.id);
						if (result.kind !== 'admitted') {
							throw new Error('The concurrent task was not admitted');
						}
						return { ...message, admission: result.admission };
					})
				);
			});
			const barrier = Promise.withResolvers<undefined>();
			const claims: ArtifactTaskClaim[] = [];
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			const execute: NonNullable<
				ArtifactQueueDependencies['executeTask']
			> = async (server, current) => {
				claims.push(current);
				if (claims.length === bodies.length) {
					barrier.resolve(undefined);
				}
				await barrier.promise;
				await server.finishArtifactTask(current, 'failed');
				return { kind: 'failed', reason: 'invalid-nar' };
			};
			await Promise.all(
				bodies.map((body) =>
					artifactConsumer(sent, execute).handleMessage(
						artifactMessage(body, actions)
					)
				)
			);
			const after = await inSection((context) => state(context, claim));
			expect({
				actions,
				sent,
				claimed: claims
					.map((current) => current.id)
					.toSorted((left, right) => left.localeCompare(right)),
				progress: after.job?.progress
			}).toStrictEqual({
				actions: [{ action: 'ack' }, { action: 'ack' }],
				sent: [],
				claimed: bodies
					.map((body) => body.admission.taskId)
					.toSorted((left, right) => left.localeCompare(right)),
				progress: { discovered: 2, completed: 0, skipped: 0, failed: 2 }
			});
		}));

	it.each(['queued', 'discovered'] as const)(
		'dispatches a %s shared listing at full staging capacity without reading NAR bytes',
		(mode) =>
			withoutAlarmArming(async () => {
				const { candidate, blockers } = await fullStagingReuseFixture(mode);
				const before = await inSection((context) =>
					new ArtifactAdmissionService(context).stagingCapacityInSection()
				);
				const reads = vi.spyOn(env.BLOBS, 'get');
				const uploads = vi.spyOn(env.BLOBS, 'createMultipartUpload');
				const delivered = await deliverArtifactBatch();
				expect({
					result: delivered.result,
					jobs: delivered.messages.map((message) => message.job)
				}).toStrictEqual({
					result: { selectedJobs: 1, sent: 1, failed: 0 },
					jobs: [candidate]
				});
				const message = delivered.messages[0];
				if (message === undefined) {
					throw new Error('The reusable listing was not dispatched');
				}
				const actions: unknown[] = [];
				const sent: ArtifactQueueMessage[] = [];
				await artifactConsumer(sent).handleMessage(
					artifactMessage(message, actions)
				);
				const after = await inSection((context) => ({
					capacity: new ArtifactAdmissionService(
						context
					).stagingCapacityInSection(),
					progress: new ArtifactJobService(context).summaryInSection(
						candidate.id
					)?.progress,
					admissions: context.db.select().from(schema.artifactAdmissions).all()
				}));
				expect({
					before,
					after,
					actions,
					sent,
					reads: reads.mock.calls,
					uploads: uploads.mock.calls
				}).toStrictEqual({
					before: {
						reservations: 2,
						bytes: 128 * 1024 * 1024,
						retryAt: blockers[0]?.leaseExpiresAt
					},
					after: {
						capacity: before,
						progress: {
							discovered: mode === 'queued' ? 1 : 2,
							completed: 1,
							skipped: 0,
							failed: 0
						},
						admissions: []
					},
					actions: [{ action: 'ack' }],
					sent: [],
					reads: [],
					uploads: []
				});
			})
	);

	it('does not admit reuse work when the tenant is suspended during its byte probe', () =>
		withoutAlarmArming(async () => {
			const { generated } = await fullStagingReuseFixture();
			const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
			const object = await database
				.select()
				.from(d1Schema.casObject)
				.where(eq(d1Schema.casObject.digest, generated.fact.digest))
				.get();
			if (object === undefined) {
				throw new Error('The reusable CAS fixture is missing');
			}
			const key = casObjectKey(generated.fact.digest, object.incarnation);
			const before = await inSection((context) =>
				context.db.select().from(schema.artifactJobs).all()
			);
			const readHead = env.BLOBS.head.bind(env.BLOBS);
			const probe = vi
				.spyOn(env.BLOBS, 'head')
				.mockImplementation(async (requested) => {
					const head = await readHead(requested);
					if (requested === key) {
						await database
							.update(d1Schema.tenant)
							.set({ status: 'suspended' })
							.where(eq(d1Schema.tenant.id, fixtureTenant));
					}
					return head;
				});
			try {
				const delivered = await deliverArtifactBatch();
				const after = await inSection((context) =>
					context.db.select().from(schema.artifactJobs).all()
				);
				expect({ delivered, after }).toStrictEqual({
					delivered: {
						result: { selectedJobs: 0, sent: 0, failed: 0 },
						messages: [],
						admissions: []
					},
					after: before
				});
			} finally {
				probe.mockRestore();
			}
		}));

	it.each([
		'missing-bytes',
		'wrong-size',
		'absent-incarnation',
		'other-generator'
	] as const)(
		'does not admit a stale shared listing at full staging capacity after %s',
		(condition) =>
			withoutAlarmArming(async () => {
				const { candidate, generated } = await fullStagingReuseFixture();
				const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
				const object = await database
					.select()
					.from(d1Schema.casObject)
					.where(eq(d1Schema.casObject.digest, generated.fact.digest))
					.get();
				if (object === undefined) {
					throw new Error('The stale CAS fixture is missing');
				}
				const key = casObjectKey(generated.fact.digest, object.incarnation);
				const changedRevision =
					listingGeneratorRevisionSchema.parse('other-generator');
				const saved = await env.BLOBS.get(key);
				if (saved === null) {
					throw new Error('The original CAS bytes are missing');
				}
				const bytes = await saved.arrayBuffer();
				try {
					switch (condition) {
						case 'missing-bytes': {
							await env.BLOBS.delete(key);
							break;
						}
						case 'wrong-size': {
							await env.BLOBS.put(key, 'corrupt');
							break;
						}
						case 'absent-incarnation': {
							await database
								.update(d1Schema.objectIncarnation)
								.set({ state: 'absent' })
								.where(
									eq(d1Schema.objectIncarnation.objectId, generated.fact.digest)
								);
							break;
						}
						case 'other-generator': {
							await database
								.update(d1Schema.listingFact)
								.set({
									generatorRevision: changedRevision
								})
								.where(
									eq(d1Schema.listingFact.narHash, generated.fact.narHash)
								);
							break;
						}
					}
					const before = await inSection((context) => ({
						capacity: new ArtifactAdmissionService(
							context
						).stagingCapacityInSection(),
						tasks: context.db
							.select()
							.from(schema.artifactTasks)
							.where(eq(schema.artifactTasks.jobId, candidate.id))
							.all()
					}));
					const reads = vi.spyOn(env.BLOBS, 'get');
					const delivered = await deliverArtifactBatch();
					const after = await inSection((context) => ({
						capacity: new ArtifactAdmissionService(
							context
						).stagingCapacityInSection(),
						tasks: context.db
							.select()
							.from(schema.artifactTasks)
							.where(eq(schema.artifactTasks.jobId, candidate.id))
							.all()
					}));
					expect({ delivered, after, reads: reads.mock.calls }).toStrictEqual({
						delivered: {
							result: { selectedJobs: 1, sent: 0, failed: 0 },
							messages: [],
							admissions: []
						},
						after: before,
						reads: []
					});
				} finally {
					await env.BLOBS.put(key, bytes, { sha256: generated.fact.digest });
					switch (condition) {
						case 'absent-incarnation': {
							await database
								.update(d1Schema.objectIncarnation)
								.set({ state: 'live' })
								.where(
									and(
										eq(d1Schema.objectIncarnation.kind, 'cas'),
										eq(
											d1Schema.objectIncarnation.objectId,
											generated.fact.digest
										)
									)
								);

							break;
						}
						case 'other-generator': {
							await database
								.update(d1Schema.listingFact)
								.set({ generatorRevision: generated.fact.generatorRevision })
								.where(
									and(
										eq(d1Schema.listingFact.narHash, generated.fact.narHash),
										eq(d1Schema.listingFact.generatorRevision, changedRevision)
									)
								);

							break;
						}
						default: {
							break;
						}
					}
				}
			})
	);

	it('does not immediately readmit reuse after bytes disappear between dispatch and execution', () =>
		withoutAlarmArming(async () => {
			const { candidate, generated } = await fullStagingReuseFixture();
			const initial = await deliverArtifactBatch();
			const message = initial.messages[0];
			if (message === undefined) {
				throw new Error('The raced reuse fixture was not admitted');
			}
			const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
			const object = await database
				.select()
				.from(d1Schema.casObject)
				.where(eq(d1Schema.casObject.digest, generated.fact.digest))
				.get();
			if (object === undefined) {
				throw new Error('The raced CAS fixture is missing');
			}
			const key = casObjectKey(generated.fact.digest, object.incarnation);
			const saved = await env.BLOBS.get(key);
			if (saved === null) {
				throw new Error('The original raced CAS bytes are missing');
			}
			const bytes = await saved.arrayBuffer();
			try {
				await env.BLOBS.delete(
					casObjectKey(generated.fact.digest, object.incarnation)
				);
				const reads = vi.spyOn(env.BLOBS, 'get');
				const uploads = vi.spyOn(env.BLOBS, 'createMultipartUpload');
				const sent: ArtifactQueueMessage[] = [];
				const actions: unknown[] = [];
				await artifactConsumer(sent).handleMessage(
					artifactMessage(message, actions)
				);
				const repeated = await deliverArtifactBatch();
				const after = await inSection((context) => ({
					progress: new ArtifactJobService(context).summaryInSection(
						candidate.id
					)?.progress,
					admissions: context.db.select().from(schema.artifactAdmissions).all(),
					capacity: new ArtifactAdmissionService(
						context
					).stagingCapacityInSection().bytes,
					tasks: context.db
						.select({ state: schema.artifactTasks.state })
						.from(schema.artifactTasks)
						.where(eq(schema.artifactTasks.jobId, candidate.id))
						.all()
				}));
				expect({
					repeated,
					after,
					sent,
					actions,
					reads: reads.mock.calls,
					uploads: uploads.mock.calls
				}).toStrictEqual({
					repeated: {
						result: { selectedJobs: 1, sent: 0, failed: 0 },
						messages: [],
						admissions: []
					},
					after: {
						progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 },
						admissions: [],
						capacity: 128 * 1024 * 1024,
						tasks: [{ state: 'pending' }]
					},
					sent: [],
					actions: [{ action: 'ack' }],
					reads: [],
					uploads: []
				});
			} finally {
				await env.BLOBS.put(key, bytes, { sha256: generated.fact.digest });
			}
		}));

	it('releases a reuse admission after publishing a shared listing fact', () =>
		withoutAlarmArming(async () => {
			const original = await fixture();
			const generated = await generate(original);
			await promote(generated);
			await currentServer().completeListingTask(
				generated.lease,
				generated.fact
			);
			const claim = await inSection(async (context) => {
				const jobs = new ArtifactJobService(context);
				const job = await jobs.startInSection(defaultCache(), {
					kind: 'listing',
					generatorRevision: currentListingGeneratorRevision
				});
				jobs.enqueueInSection(job, original.source);
				jobs.checkpointInSection(job, undefined, true);
				const result = jobs.claimInSection(
					job.id,
					artifactTaskOwnerSchema.parse(crypto.randomUUID())
				);
				if (result.claim === undefined) {
					throw new Error('The reuse task was not claimed');
				}
				return result.claim;
			});
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const body = await admittedMessage(claim, 'reuse');
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			await artifactConsumer(sent).handleMessage(
				artifactMessage(body, actions)
			);
			const after = await inSection((context) => state(context, claim));
			expect({
				actions,
				sent,
				progress: after.job?.progress,
				admissions: await inSection((context) =>
					Promise.resolve(
						context.db.select().from(schema.artifactAdmissions).all()
					)
				)
			}).toStrictEqual({
				actions: [{ action: 'ack' }],
				sent: [],
				progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
				admissions: []
			});
		}));

	it('rejects an invalid admitted RPC owner before changing the task', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const body = await admittedMessage(claim);
			const before = await inSection((context) => state(context, claim));
			await expect(
				runInDurableObject(currentServer(), (instance) =>
					instance.claimAdmittedArtifactTask(
						body.admission,
						'invalid',
						'listing'
					)
				)
			).rejects.toThrow();
			expect(await inSection((context) => state(context, claim))).toStrictEqual(
				before
			);
		}));

	it('fences dispatch wakes by the current job generation', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const job = { id: claim.jobId, generation: claim.jobGeneration };
			const isCurrent = await currentServer().requestArtifactDispatch(job);
			const isStale = await currentServer().requestArtifactDispatch({
				...job,
				generation: artifactJobGenerationSchema.parse(job.generation + 1)
			});
			await inSection((context) =>
				Promise.resolve(new ArtifactJobService(context).cancelInSection(job.id))
			);
			const isCancelled = await currentServer().requestArtifactDispatch(job);
			expect({ isCurrent, isStale, isCancelled }).toStrictEqual({
				isCurrent: true,
				isStale: false,
				isCancelled: false
			});
		}));

	it('does not claim a queue task whose requested kind differs from its job', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const before = await inSection((context) => state(context, claim));
			const owner = crypto.randomUUID();
			const result = await currentServer().claimArtifactTask(
				{ id: claim.jobId, generation: claim.jobGeneration },
				owner,
				'build-log'
			);
			expect({
				result,
				state: await inSection((context) => state(context, claim))
			}).toStrictEqual({
				result: { kind: 'idle', pending: false },
				state: before
			});
		}));

	it('consumes a listing job and sends its continuation only after completion', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const body = jobMessage(claim);
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			await artifactConsumer(sent).handleMessage(
				artifactMessage(body, actions)
			);
			const after = await inSection((context) => state(context, claim));
			expect({
				actions,
				sent,
				progress: after.job?.progress,
				artifacts: after.artifacts.map((row) => row.state)
			}).toStrictEqual({
				actions: [{ action: 'ack' }],
				sent: [body],
				progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
				artifacts: ['live']
			});
		}));

	it('acknowledges malformed artifact messages without claiming or executing work', async () => {
		const actions: unknown[] = [];
		const sent: ArtifactQueueMessage[] = [];
		const execute = vi.fn(() =>
			Promise.resolve({ kind: 'completed' } as const)
		);
		await artifactConsumer(sent, execute).handleMessage(
			artifactMessage({ kind: 'artifact-job' }, actions)
		);
		expect({ actions, sent, executions: execute.mock.calls }).toStrictEqual({
			actions: [{ action: 'ack' }],
			sent: [],
			executions: []
		});
	});

	it('defers a second valid artifact message in the same consumer invocation', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			const consumer = artifactConsumer(sent);
			await consumer.handleMessage(artifactMessage(jobMessage(claim), actions));
			await consumer.handleMessage(artifactMessage(jobMessage(claim), actions));
			expect({ actions, sent }).toStrictEqual({
				actions: [{ action: 'ack' }, { action: 'retry', delaySeconds: 60 }],
				sent: [jobMessage(claim)]
			});
		}));

	it('ignores a cancelled job generation in the artifact queue', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			await inSection((context) => {
				const jobs = new ArtifactJobService(context);
				jobs.cancelInSection(claim.jobId);
				jobs.resumeInSection(claim.jobId);
				return Promise.resolve();
			});
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			const execute = vi.fn(() =>
				Promise.resolve({ kind: 'completed' } as const)
			);
			await artifactConsumer(sent, execute).handleMessage(
				artifactMessage(jobMessage(claim), actions)
			);
			expect({ actions, sent, executions: execute.mock.calls }).toStrictEqual({
				actions: [{ action: 'ack' }],
				sent: [],
				executions: []
			});
		}));

	it.each([
		'capacity',
		'generation-busy',
		'transport',
		'unavailable',
		'bytes-missing',
		'over-quota'
	] as const)('retries %s without counting a completed task', (reason) =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const actions: unknown[] = [];
			const sent: ArtifactQueueMessage[] = [];
			const delaySeconds = reason === 'generation-busy' ? 20 : 120;
			const retryAt = isoTimestamp(new Date(Date.now() + delaySeconds * 1000));
			const execute = () => {
				if (reason === 'transport') {
					return Promise.reject(new Error('R2 temporarily unavailable'));
				}
				return reason === 'capacity' || reason === 'generation-busy'
					? Promise.resolve({ kind: reason, retryAt })
					: Promise.resolve({ kind: reason });
			};
			await artifactConsumer(sent, execute).handleMessage(
				artifactMessage(jobMessage(claim), actions)
			);
			const after = await inSection((context) => state(context, claim));
			expect({
				actions,
				sent,
				progress: after.job?.progress,
				artifacts: after.artifacts
			}).toStrictEqual({
				actions: [
					{
						action: 'retry',
						delaySeconds:
							reason === 'capacity' || reason === 'generation-busy'
								? delaySeconds
								: 60
					}
				],
				sent: [],
				progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 },
				artifacts: []
			});
		})
	);

	it('defers generation at full output capacity before staging, then retries the same task', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const pool = new ByteBufferPool({
				buffers: 1,
				bufferSize: 5 * 1024 * 1024
			});
			const occupied = pool.tryAcquire();
			if (occupied === undefined) {
				throw new Error('The fixture output buffer was not occupied');
			}
			const get = vi.spyOn(env.BLOBS, 'get');
			const multipart = vi.spyOn(env.BLOBS, 'createMultipartUpload');
			const worker = new ListingTaskWorker({
				server: currentServer(),
				database: env.CUPBOARD_DB,
				blobs: env.BLOBS,
				buffers: new NarReadBufferPool(),
				outputBuffers: pool
			});
			try {
				let result: unknown;
				try {
					result = await worker.run(claim);
				} catch (error) {
					result = error;
				}
				const after = await inSection((context) => state(context, claim));
				expect({
					result,
					reads: get.mock.calls,
					uploads: multipart.mock.calls,
					stages: after.stages,
					progress: after.job?.progress
				}).toStrictEqual({
					result: { kind: 'local-capacity' },
					reads: [],
					uploads: [],
					stages: [],
					progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 }
				});
			} finally {
				occupied.release();
			}
			const next = await inSection((context) => {
				const admissions = new ArtifactAdmissionService(context);
				const retry = admissions.requeueInSection(claim, 'reuse');
				if (retry.kind !== 'admitted') {
					throw new Error('The deferred listing task was not admitted');
				}
				const nextOwner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
				return Promise.resolve(
					admissions.claimInSection(retry.admission, nextOwner)
				);
			});
			if (next === undefined) {
				throw new Error('The deferred listing task was not reclaimed');
			}
			expect({
				taskId: next.id,
				result: await worker.run(next),
				buffers: pool.state
			}).toStrictEqual({
				taskId: claim.id,
				result: { kind: 'completed' },
				buffers: { free: 1, allocations: 1 }
			});
		}));

	it.each([
		{ kind: 'shared', capacity: 'busy' },
		{ kind: 'sealed', capacity: 'busy' },
		{ kind: 'shared', capacity: 'free' },
		{ kind: 'sealed', capacity: 'free' }
	] as const)(
		'reuses $kind listing bytes with $capacity output capacity',
		({ kind, capacity }) =>
			withoutAlarmArming(async () => {
				const original = await fixture();
				const generated = await generate(original);
				if (kind === 'shared') {
					await promote(generated);
					await currentServer().completeListingTask(
						generated.lease,
						generated.fact
					);
				}
				const claim = await inSection(async (context) => {
					const jobs = new ArtifactJobService(context);
					if (kind === 'sealed') {
						const retry = new ArtifactAdmissionService(
							context
						).requeueInSection(original);
						if (retry.kind !== 'admitted') {
							throw new Error('The sealed retry was not admitted');
						}
						return new ArtifactAdmissionService(context).claimInSection(
							retry.admission,
							artifactTaskOwnerSchema.parse(crypto.randomUUID())
						);
					}
					const job = await jobs.startInSection(defaultCache(), {
						kind: 'listing',
						generatorRevision: currentListingGeneratorRevision
					});
					jobs.enqueueInSection(job, original.source);
					jobs.checkpointInSection(job, undefined, true);
					return jobs.claimInSection(
						job.id,
						artifactTaskOwnerSchema.parse(crypto.randomUUID())
					).claim;
				});
				if (claim === undefined) {
					throw new Error('The reuse listing task was not claimed');
				}
				const pool = new ByteBufferPool({
					buffers: 1,
					bufferSize: 5 * 1024 * 1024
				});
				const occupied = capacity === 'busy' ? pool.tryAcquire() : undefined;
				if (capacity === 'busy' && occupied === undefined) {
					throw new Error('The fixture output buffer was not occupied');
				}
				const preparation: {
					readonly canGenerate: boolean;
					readonly buffers: ByteBufferPoolState;
				}[] = [];
				const promotionBuffers: ByteBufferPoolState[] = [];
				const server = workerRpc({
					prepareListingTaskWithCapacity: (current, canGenerate) => {
						preparation.push({ canGenerate, buffers: pool.state });
						return currentServer().prepareListingTaskWithCapacity(
							current,
							canGenerate
						);
					},
					completeListingTask: (lease, fact) => {
						promotionBuffers.push(pool.state);
						return currentServer().completeListingTask(lease, fact);
					}
				});
				const get = vi.spyOn(env.BLOBS, 'get');
				const create = vi.spyOn(env.BLOBS, 'createMultipartUpload');
				try {
					const result = await new ListingTaskWorker({
						server,
						database: env.CUPBOARD_DB,
						blobs: env.BLOBS,
						buffers: new NarReadBufferPool(),
						outputBuffers: pool
					}).run(claim);
					const after = await inSection((context) => state(context, claim));
					expect({
						result,
						preparation,
						promotionBuffers,
						sourceReads: get.mock.calls.filter(
							([key]) => key === generated.source.key
						),
						uploads: create.mock.calls,
						progress: after.job?.progress,
						buffers: pool.state
					}).toStrictEqual({
						result: { kind: kind === 'shared' ? 'reused' : 'completed' },
						preparation: [
							{
								canGenerate: capacity === 'free',
								buffers: { free: 0, allocations: 1 }
							}
						],
						promotionBuffers:
							kind === 'sealed'
								? [{ free: capacity === 'free' ? 1 : 0, allocations: 1 }]
								: [],
						sourceReads: [],
						uploads: [],
						progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
						buffers: { free: capacity === 'free' ? 1 : 0, allocations: 1 }
					});
				} finally {
					occupied?.release();
				}
			})
	);

	it('executes a claimed listing in the Worker without entering the tenant gate for byte transfers', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const result = await new ListingTaskWorker({
				server: currentServer(),
				database: env.CUPBOARD_DB,
				blobs: env.BLOBS,
				buffers: new NarReadBufferPool()
			}).run(claim);
			const after = await inSection((context) => state(context, claim));
			expect({
				result,
				progress: after.job?.progress,
				artifacts: after.artifacts.map((row) => row.state),
				stages: after.stages.map((row) => ({
					state: row.state,
					sealed: row.writesSealed
				})),
				facts: after.facts.map((row) => row.narHash),
				references: after.references.map((row) => row.digest)
			}).toStrictEqual({
				result: { kind: 'completed' },
				progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
				artifacts: ['live'],
				stages: [{ state: 'retired', sealed: true }],
				facts: [claim.source.kind === 'nar' ? claim.source.narHash : undefined],
				references: after.facts.map((row) => row.digest)
			});
		}));

	it('reuses sealed output in the Worker after producer expiry without opening the NAR', () =>
		withoutAlarmArming(async () => {
			const original = await fixture();
			const value = await generate(original);
			vi.setSystemTime(new Date(original.leaseExpiresAt));
			const claimed = await currentServer().claimArtifactTask(
				{ id: original.jobId, generation: original.jobGeneration },
				crypto.randomUUID()
			);
			if (claimed.kind !== 'claimed') {
				throw new Error('The expired listing was not reclaimed');
			}
			const source = value.source;
			const blobs = env.BLOBS;
			const existing = await blobs.list({ prefix: `cas/${value.fact.digest}` });
			await blobs.delete(existing.objects.map((object) => object.key));
			const get = vi.spyOn(blobs, 'get');
			const result = await new ListingTaskWorker({
				server: currentServer(),
				database: env.CUPBOARD_DB,
				blobs,
				buffers: new NarReadBufferPool()
			}).run(claimed.claim);
			expect({
				result,
				sourceReads: get.mock.calls.filter(([key]) => key === source.key),
				stagingReads: get.mock.calls.filter(([key]) => key === value.lease.key)
			}).toStrictEqual({
				result: { kind: 'completed' },
				sourceReads: [],
				stagingReads: [[value.lease.key]]
			});
		}));

	it('preserves ready staging when the Worker loses the sealing acknowledgement', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const real = currentServer();
			const failure = new Error('sealing acknowledgement lost');
			const server = workerRpc({
				sealArtifactStaging: async (lease, multipartId, measurement) => {
					await real.sealArtifactStaging(lease, multipartId, measurement);
					throw failure;
				}
			});
			await expect(
				new ListingTaskWorker({
					server,
					database: env.CUPBOARD_DB,
					blobs: env.BLOBS,
					buffers: new NarReadBufferPool()
				}).run(claim)
			).rejects.toBe(failure);
			const after = await inSection((context) => state(context, claim));
			expect({
				progress: after.job?.progress,
				stages: after.stages.map((row) => ({
					state: row.state,
					sealed: row.writesSealed
				})),
				facts: after.facts,
				references: after.references
			}).toStrictEqual({
				progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 },
				stages: [{ state: 'ready', sealed: true }],
				facts: [],
				references: []
			});
		}));

	it('releases its output reservation when preparation fails', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const before = await inSection((context) => state(context, claim));
			const pool = new ByteBufferPool({
				buffers: 1,
				bufferSize: 5 * 1024 * 1024
			});
			const failure = new Error('Preparation RPC unavailable');
			const server = workerRpc({
				prepareListingTaskWithCapacity: () => Promise.reject(failure)
			});
			await expect(
				new ListingTaskWorker({
					server,
					database: env.CUPBOARD_DB,
					blobs: env.BLOBS,
					buffers: new NarReadBufferPool(),
					outputBuffers: pool
				}).run(claim)
			).rejects.toBe(failure);
			expect({
				state: await inSection((context) => state(context, claim)),
				buffers: pool.state
			}).toStrictEqual({ state: before, buffers: { free: 1, allocations: 1 } });
		}));

	it('bounds a stalled preparation RPC without writing artifact bytes', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const before = await inSection((context) => state(context, claim));
			const pool = new ByteBufferPool({
				buffers: 1,
				bufferSize: 5 * 1024 * 1024
			});
			const preparation = Promise.withResolvers<ListingTaskPreparation>();
			const server = workerRpc({
				prepareListingTaskWithCapacity: () => preparation.promise
			});
			await expect(
				new ListingTaskWorker({
					server,
					database: env.CUPBOARD_DB,
					blobs: env.BLOBS,
					buffers: new NarReadBufferPool(),
					outputBuffers: pool
				}).run(claim, { budgetMs: 50 })
			).rejects.toBeInstanceOf(SubrequestTimeoutError);
			preparation.reject(new Error('late preparation failure'));
			expect({
				state: await inSection((context) => state(context, claim)),
				buffers: pool.state
			}).toStrictEqual({ state: before, buffers: { free: 1, allocations: 1 } });
		}));

	it('does not retire another multipart producer using the same claim', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const prepared = generationOf(
				await currentServer().prepareListingTask(claim)
			);
			const upload = await env.BLOBS.createMultipartUpload(prepared.lease.key);
			await currentServer().registerArtifactMultipart(
				prepared.lease,
				upload.uploadId
			);
			const before = await inSection((context) => state(context, claim));
			try {
				await expect(
					new ListingTaskWorker({
						server: currentServer(),
						database: env.CUPBOARD_DB,
						blobs: env.BLOBS,
						buffers: new NarReadBufferPool()
					}).run(claim)
				).rejects.toBeInstanceOf(ArtifactTaskOwnershipLostError);
				expect(
					await inSection((context) => state(context, claim))
				).toStrictEqual(before);
			} finally {
				await upload.abort();
			}
		}));

	it('records an invalid archive as a failed optional listing task', () =>
		withoutAlarmArming(async () => {
			const nar = await verifiableNar('invalid-listing-source');
			const claim = await fixture({
				...nar,
				narBytes: new Uint8Array(nar.narBytes)
			});
			const result = await new ListingTaskWorker({
				server: currentServer(),
				database: env.CUPBOARD_DB,
				blobs: env.BLOBS,
				buffers: new NarReadBufferPool()
			}).run(claim);
			const after = await inSection((context) => state(context, claim));
			expect({
				result,
				progress: after.job?.progress,
				stages: after.stages.map((row) => ({
					state: row.state,
					sealed: row.writesSealed
				})),
				facts: after.facts,
				references: after.references
			}).toStrictEqual({
				result: { kind: 'failed', reason: 'invalid-nar' },
				progress: { discovered: 1, completed: 0, skipped: 0, failed: 1 },
				stages: [{ state: 'retired', sealed: false }],
				facts: [],
				references: []
			});
		}));

	it('does not prepare or write a listing after caller cancellation', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const before = await inSection((context) => state(context, claim));
			const controller = new AbortController();
			const failure = new Error('caller cancelled');
			controller.abort(failure);
			await expect(
				new ListingTaskWorker({
					server: currentServer(),
					database: env.CUPBOARD_DB,
					blobs: env.BLOBS,
					buffers: new NarReadBufferPool()
				}).run(claim, { signal: controller.signal })
			).rejects.toBe(failure);
			expect(await inSection((context) => state(context, claim))).toStrictEqual(
				before
			);
		}));

	it('generates, seals and publishes through the internal RPC boundary', () =>
		withoutAlarmArming(async () => {
			const original = await fixture();
			const version = {
				id: original.jobId,
				generation: original.jobGeneration
			};
			const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
			expect(
				await currentServer().claimArtifactTask(version, owner)
			).toStrictEqual({
				kind: 'idle',
				pending: true
			});
			vi.setSystemTime(new Date(original.leaseExpiresAt));
			const claimed = await currentServer().claimArtifactTask(version, owner);
			if (claimed.kind !== 'claimed') {
				throw new Error('The expired RPC task was not reclaimed');
			}
			expect({
				definition: claimed.definition,
				source: claimed.claim.source,
				owner: claimed.claim.owner,
				generation: claimed.claim.generation
			}).toStrictEqual({
				definition: {
					kind: 'listing',
					generatorRevision: currentListingGeneratorRevision
				},
				source: original.source,
				owner,
				generation: original.generation + 1
			});
			const prepared = generationOf(
				await currentServer().prepareListingTask(claimed.claim)
			);
			const upload = await env.BLOBS.createMultipartUpload(prepared.lease.key);
			expect(
				await currentServer().registerArtifactMultipart(
					prepared.lease,
					upload.uploadId
				)
			).toBe(true);
			const generated = await new StoredNarListingGenerator({
				objects: env.BLOBS,
				source: prepared.source.key,
				expected: prepared.source.expected,
				upload,
				buffers: new NarReadBufferPool(),
				generatorRevision: prepared.generatorRevision
			}).run();
			if (generated.kind !== 'generated') {
				throw new Error('The RPC fixture NAR did not verify');
			}
			expect(
				await currentServer().sealArtifactStaging(
					prepared.lease,
					upload.uploadId,
					{ digest: generated.fact.digest, size: generated.fact.size }
				)
			).toBe(true);
			expect(
				await currentServer().completeListingTask(
					prepared.lease,
					generated.fact
				)
			).toStrictEqual({ kind: 'bytes-missing' });
			await promote({ lease: prepared.lease, fact: generated.fact });
			expect(await currentServer().renewListingTask(prepared.lease)).toBe(
				claimed.claim.leaseExpiresAt
			);
			expect(
				await currentServer().completeListingTask(
					prepared.lease,
					generated.fact
				)
			).toStrictEqual({ kind: 'completed' });
			expect(
				await currentServer().prepareListingTask(claimed.claim)
			).toStrictEqual({ kind: 'unavailable' });
			expect(await currentServer().collectArtifactStaging()).toStrictEqual({
				removed: 1,
				pending: false
			});
			const progress = await inSection((context) =>
				Promise.resolve(
					new ArtifactJobService(context).summaryInSection(original.jobId)
						?.progress
				)
			);
			expect(progress).toStrictEqual({
				discovered: 1,
				completed: 1,
				skipped: 0,
				failed: 0
			});
		}));

	it('refuses a queue message from an earlier job generation', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			await inSection((context) => {
				const jobs = new ArtifactJobService(context);
				jobs.cancelInSection(claim.jobId);
				jobs.resumeInSection(claim.jobId);
				return Promise.resolve();
			});
			const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
			expect(
				await currentServer().claimArtifactTask(
					{ id: claim.jobId, generation: claim.jobGeneration },
					owner
				)
			).toStrictEqual({ kind: 'idle', pending: false });
			const current = await currentServer().claimArtifactTask(
				{
					id: claim.jobId,
					generation: artifactJobGenerationSchema.parse(claim.jobGeneration + 2)
				},
				owner
			);
			expect(current.kind).toBe('claimed');
		}));

	it.each(['suspended', 'offboarding'] as const)(
		'does not claim a task while the tenant is %s',
		(status) =>
			withoutAlarmArming(async () => {
				const claim = await fixture();
				vi.setSystemTime(new Date(claim.leaseExpiresAt));
				await drizzle(env.CUPBOARD_DB)
					.update(d1Schema.tenant)
					.set({ status })
					.where(eq(d1Schema.tenant.id, fixtureTenant));
				const before = await inSection((context) => state(context, claim));
				expect(
					await currentServer().claimArtifactTask(
						{ id: claim.jobId, generation: claim.jobGeneration },
						crypto.randomUUID()
					)
				).toStrictEqual({ kind: 'idle', pending: false });
				expect(
					await inSection((context) => state(context, claim))
				).toStrictEqual(before);
			})
	);

	it('rejects malformed RPC ownership without modifying durable state', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const before = await inSection((context) => state(context, claim));
			await expect(
				runInDurableObject(currentServer(), (instance) =>
					instance.claimArtifactTask(
						{ id: claim.jobId, generation: claim.jobGeneration },
						'not-an-owner'
					)
				)
			).rejects.toThrow();
			expect(await inSection((context) => state(context, claim))).toStrictEqual(
				before
			);
		}));

	it('rejects malformed staging packets before modifying durable state', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const prepared = generationOf(
				await currentServer().prepareListingTask(claim)
			);
			const before = await inSection((context) => state(context, claim));
			await expect(
				runInDurableObject(currentServer(), (instance) =>
					instance.registerArtifactMultipart(prepared.lease, '')
				)
			).rejects.toThrow();
			await expect(
				runInDurableObject(currentServer(), (instance) =>
					instance.renewListingTask({
						...prepared.lease,
						maximumBytes: prepared.lease.maximumBytes + 1
					})
				)
			).rejects.toThrow();
			await expect(
				runInDurableObject(currentServer(), (instance) =>
					instance.prepareListingTask(Object.assign({}, claim, { extra: true }))
				)
			).rejects.toThrow();
			expect(await inSection((context) => state(context, claim))).toStrictEqual(
				before
			);
		}));

	it.each(['skipped', 'failed'] as const)(
		'reports %s and cleans staging only for its current RPC owner',
		(outcome) =>
			withoutAlarmArming(async () => {
				const claim = await fixture();
				const value = await generate(claim);
				const otherClaim = {
					...claim,
					owner: artifactTaskOwnerSchema.parse(crypto.randomUUID())
				};
				const otherLease = { ...value.lease, claim: otherClaim };
				const before = await inSection((context) => state(context, claim));
				expect({
					retired: await currentServer().retireArtifactStaging(otherLease),
					finished: await currentServer().finishArtifactTask(
						otherClaim,
						outcome
					),
					renewed: await currentServer().renewListingTask(otherLease),
					completed: await currentServer().completeListingTask(
						otherLease,
						value.fact
					),
					state: await inSection((context) => state(context, claim))
				}).toStrictEqual({
					retired: false,
					finished: false,
					renewed: undefined,
					completed: { kind: 'unavailable' },
					state: before
				});
				expect(await currentServer().retireArtifactStaging(value.lease)).toBe(
					true
				);
				expect(await currentServer().finishArtifactTask(claim, outcome)).toBe(
					true
				);
				expect(await currentServer().finishArtifactTask(claim, outcome)).toBe(
					false
				);
				expect(await currentServer().collectArtifactStaging()).toStrictEqual({
					removed: 1,
					pending: false
				});
				const after = await inSection((context) => state(context, claim));
				expect({
					progress: after.job?.progress,
					artifacts: after.artifacts,
					stages: after.stages,
					facts: after.facts,
					references: after.references
				}).toStrictEqual({
					progress: {
						discovered: 1,
						completed: 0,
						skipped: outcome === 'skipped' ? 1 : 0,
						failed: outcome === 'failed' ? 1 : 0
					},
					artifacts: [],
					stages: [],
					facts: [],
					references: []
				});
			})
	);

	it('allocates fresh staging when the old sealed output has entered cleanup', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const value = await generate(claim);
			await inSection((context) =>
				Promise.resolve(
					new ArtifactStagingService(context).retireInSection(value.lease)
				)
			);
			vi.setSystemTime(new Date(claim.leaseExpiresAt));
			const prepared = await inSection(async (context) => {
				const next = new ArtifactJobService(context).claimInSection(
					claim.jobId,
					artifactTaskOwnerSchema.parse(crypto.randomUUID())
				).claim;
				if (next === undefined) {
					throw new Error('The expired task was not reclaimed');
				}
				return generationOf(
					await new ListingTaskService(context).prepareInSection(next)
				);
			});
			const collection = await runInDurableObject(currentServer(), (instance) =>
				new ArtifactStagingService(instance.context).collect()
			);
			await inSection(async (context) => {
				expect({
					differentKey: prepared.lease.key !== value.lease.key,
					collection,
					rows: context.db
						.select({
							id: schema.artifactStages.id,
							state: schema.artifactStages.state
						})
						.from(schema.artifactStages)
						.all(),
					oldObjectExists: (await env.BLOBS.head(value.lease.key)) !== null,
					currentDeadline: new ArtifactStagingService(
						context
					).deadlineInSection(prepared.lease)
				}).toStrictEqual({
					differentKey: true,
					collection: {
						removed: 1,
						pending: true,
						nextWakeAt: prepared.lease.expiresAt
					},
					rows: [{ id: prepared.lease.id, state: 'pending' }],
					oldObjectExists: false,
					currentDeadline: prepared.lease.expiresAt
				});
			});
		}));

	it.each(['expiry', 'resume'] as const)(
		'recovers sealed output after %s without accepting operations from the old producer',
		(mode) =>
			withoutAlarmArming(async () => {
				const claim = await fixture();
				const value = await generate(claim);
				if (mode === 'expiry') {
					vi.setSystemTime(new Date(claim.leaseExpiresAt));
				}
				await inSection(async (context) => {
					const jobs = new ArtifactJobService(context);
					if (mode === 'resume') {
						jobs.cancelInSection(claim.jobId);
						jobs.resumeInSection(claim.jobId);
					}
					const next = jobs.claimInSection(
						claim.jobId,
						artifactTaskOwnerSchema.parse(crypto.randomUUID())
					).claim;
					if (next === undefined) {
						throw new Error('The expired listing task was not reclaimed');
					}
					const workflow = new ListingTaskService(context);
					const result = await workflow.prepareInSection(next);
					if (result.kind !== 'promote') {
						throw new Error('Expected recovery of the sealed listing');
					}
					expect({
						fact: result.fact,
						stageId: result.lease.id,
						key: result.lease.key,
						claim: result.lease.claim,
						maximumBytes: result.lease.maximumBytes
					}).toStrictEqual({
						fact: value.fact,
						stageId: value.lease.id,
						key: value.lease.key,
						claim: next,
						maximumBytes: value.lease.maximumBytes
					});
					const before = await state(context, next);
					const staging = new ArtifactStagingService(context);
					expect({
						oldReady: staging.readyInSection(value.lease),
						oldRenewal: staging.renewInSection(value.lease),
						oldRetirement: staging.retireInSection(value.lease),
						current: staging.readyInSection(result.lease),
						state: await state(context, next)
					}).toStrictEqual({
						oldReady: undefined,
						oldRenewal: undefined,
						oldRetirement: false,
						current: {
							key: value.lease.key,
							digest: value.fact.digest,
							size: value.fact.size
						},
						state: before
					});
				});
			})
	);

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
