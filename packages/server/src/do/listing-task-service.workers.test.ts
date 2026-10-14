import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import {
	artifactJobGenerationSchema,
	type ArtifactTaskClaim,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
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
import { SubrequestTimeoutError } from '../errors.ts';
import {
	ArtifactQueueConsumer,
	type ArtifactQueueDependencies
} from '../routing/artifact-queue-consumer.ts';
import { type ArtifactQueueMessage } from '../routing/artifact-queue-message.ts';
import {
	ArtifactTaskOwnershipLostError,
	ListingTaskWorker,
	type ListingTaskWorkerDependencies
} from '../routing/listing-task-worker.ts';
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
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import { ArtifactAdmissionService } from './artifact-admission-service.ts';
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
	run: (context: ServerContext) => Promise<T>
): Promise<T> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.criticalSection(() => run(instance.context))
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

function workerRpc(
	overrides: Partial<ListingTaskWorkerDependencies['server']>
): ListingTaskWorkerDependencies['server'] {
	const real = currentServer();
	return {
		prepareListingTask: (claim) => real.prepareListingTask(claim),
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

function artifactConsumer(
	sent: ArtifactQueueMessage[],
	executeTask?: ArtifactQueueDependencies['executeTask']
) {
	return new ArtifactQueueConsumer({
		blobs: env.BLOBS,
		database: env.CUPBOARD_DB,
		buffers: new NarReadBufferPool(),
		serverFor: () => currentServer(),
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

	it('consumes an admitted listing without allowing its replay to claim a sibling task', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture(undefined, true);
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
				queueState: { admissions: [], job: { nextDispatchAt: 0 } }
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
			const retryAt = isoTimestamp(new Date(Date.now() + 120_000));
			const execute = () => {
				if (reason === 'transport') {
					return Promise.reject(new Error('R2 temporarily unavailable'));
				}
				return reason === 'capacity'
					? Promise.resolve({ kind: 'capacity' as const, retryAt })
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
					{ action: 'retry', delaySeconds: reason === 'capacity' ? 120 : 60 }
				],
				sent: [],
				progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 },
				artifacts: []
			});
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

	it('bounds a stalled preparation RPC without writing artifact bytes', () =>
		withoutAlarmArming(async () => {
			const claim = await fixture();
			const before = await inSection((context) => state(context, claim));
			const preparation = Promise.withResolvers<ListingTaskPreparation>();
			const server = workerRpc({
				prepareListingTask: () => preparation.promise
			});
			await expect(
				new ListingTaskWorker({
					server,
					database: env.CUPBOARD_DB,
					blobs: env.BLOBS,
					buffers: new NarReadBufferPool()
				}).run(claim, { budgetMs: 50 })
			).rejects.toBeInstanceOf(SubrequestTimeoutError);
			preparation.reject(new Error('late preparation failure'));
			expect(await inSection((context) => state(context, claim))).toStrictEqual(
				before
			);
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
