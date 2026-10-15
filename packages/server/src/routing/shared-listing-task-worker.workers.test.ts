import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	type ListingGeneratorRevision,
	listingGeneratorRevisionSchema
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { ByteBufferPool } from '../blob/byte-buffers.ts';
import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { SharedListingStagingService } from '../blob/shared-listing-staging-service.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as schema from '../db/d1-schema.ts';
import { ListingFactStore } from '../db/listing-facts.ts';
import { SharedListingGenerationStore } from '../db/shared-listing-generation.ts';
import { SharedListingJobStore } from '../db/shared-listing-jobs.ts';
import { SharedListingStageStore } from '../db/shared-listing-staging.ts';
import { SharedListingTaskStore } from '../db/shared-listing-tasks.ts';
import { sharedNarDiscoveryFixture } from '../db/shared-nar-discovery.test-support.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { casObjectKey, narObjectKey } from '../http/http.ts';

import { SharedListingTaskWorker } from './shared-listing-task-worker.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const retryAt = isoTimestamp(new Date(Date.parse(now) + 60_000));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);

function archiveTokens(values: readonly string[]): Uint8Array {
	const chunks = values.map((value) => {
		const bytes = new TextEncoder().encode(value);
		const chunk = new Uint8Array(8 + Math.ceil(bytes.byteLength / 8) * 8);
		new DataView(chunk.buffer).setBigUint64(0, BigInt(bytes.byteLength), true);
		chunk.set(bytes, 8);
		return chunk;
	});
	const result = new Uint8Array(
		chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
	);
	let position = 0;
	for (const chunk of chunks) {
		result.set(chunk, position);
		position += chunk.byteLength;
	}
	return result;
}

function archive(contents: string): Uint8Array {
	return archiveTokens([
		'nix-archive-1',
		'(',
		'type',
		'regular',
		'contents',
		contents,
		')'
	]);
}

async function registerNar(
	database: Awaited<ReturnType<typeof sharedNarDiscoveryFixture>>['database'],
	raw: Uint8Array,
	index = 0
) {
	const narHash = NixSha256Hash.fromDigest(
		new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
	).value;
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(raw);
			controller.close();
		}
	});
	const stream = input.pipeThrough(zstdCompressionStream());
	const response = new Response(stream);
	const compressed = new Uint8Array(await response.arrayBuffer());
	const fileHash = NixSha256Hash.fromDigest(
		new Uint8Array(await crypto.subtle.digest('SHA-256', compressed))
	).value;
	const source = narObjectKey(narHash);
	await env.BLOBS.put(source, compressed);
	const storePathHash = storePathHashSchema.parse(
		String(index).padStart(32, '0')
	);
	await database.batch([
		database.insert(schema.blobState).values({
			narHash,
			fileHash,
			narSize: raw.byteLength,
			fileSize: compressed.byteLength,
			compression: 'zstd',
			incarnation: 1,
			verifiedAt: now
		}),
		database.insert(schema.objectIncarnation).values({
			kind: 'nar',
			objectId: narHash,
			incarnation: 1,
			state: 'live',
			updatedAt: now
		}),
		database.insert(schema.blobReference).values({
			tenant: tenantIdSchema.parse('discovery-first'),
			cacheKind: 'default',
			cacheGeneration: cacheGenerationSchema.parse(1),
			storePathHash,
			generation: narInfoGenerationSchema.parse(1),
			narHash
		})
	]);
	return { narHash, source, compressed };
}

async function fixture(contents = 'hello', raw = archive(contents)) {
	const { database } = await sharedNarDiscoveryFixture(0);
	await database.insert(schema.deploymentTransition).values({
		id: 'shared-listing-completion',
		state: 'expanded',
		updatedAt: now
	});
	const { narHash, source, compressed } = await registerNar(database, raw);
	const jobs = new SharedListingJobStore(database);
	async function create(
		revision: ListingGeneratorRevision = currentListingGeneratorRevision
	) {
		const job = await jobs.start(revision, now);
		const discovery = await jobs.claim(job, owner, now);
		if (discovery.kind !== 'claimed') {
			throw new Error('Discovery ownership was not granted');
		}
		await jobs.discover(discovery.claim);
		const task = await database
			.select()
			.from(schema.sharedListingTask)
			.where(eq(schema.sharedListingTask.jobId, job.id))
			.get();
		if (task === undefined) {
			throw new Error('The global task is missing');
		}
		return {
			job,
			request: {
				job: { id: job.id, generation: job.generation },
				id: task.id,
				owner
			}
		};
	}
	const outputBuffers = new ByteBufferPool({
		buffers: 2,
		bufferSize: 5 * 1024 * 1024
	});
	const buffers = new NarReadBufferPool({
		buffers: 2,
		bufferSize: 1024 * 1024
	});
	const dependencies = {
		database: env.CUPBOARD_DB,
		blobs: env.BLOBS,
		buffers,
		outputBuffers
	};
	const worker = new SharedListingTaskWorker(dependencies);
	const first = await create();
	return {
		database,
		source,
		narHash,
		create,
		jobs,
		worker,
		first,
		dependencies,
		raw,
		compressed
	};
}

describe('global listing task execution', () => {
	it('verifies a real stored NAR and checkpoints retained canonical listing bytes without tenant authority', async () => {
		const { database, worker, first, jobs, narHash, dependencies } =
			await fixture();
		const result = await worker.run(first.request);
		const bytes = new TextEncoder().encode(
			'{"version":1,"root":{"type":"regular","size":5,"narOffset":96}}'
		);
		const fact = {
			narHash,
			generatorRevision: currentListingGeneratorRevision,
			format: 1,
			digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
			size: bytes.byteLength,
			createdAt: now
		};
		const cas = await database.select().from(schema.casObject).get();
		const object =
			cas === undefined
				? undefined
				: await env.BLOBS.get(casObjectKey(cas.digest, cas.incarnation));
		const summary = await jobs.find(first.job.id);
		expect({
			kind: result.kind,
			outcome: 'outcome' in result ? result.outcome.kind : undefined,
			bytes:
				object === undefined || object === null
					? undefined
					: new Uint8Array(await object.arrayBuffer()),
			facts: await database.select().from(schema.listingFact),
			progress: summary?.progress,
			tenantReferences: await database.select().from(schema.artifactReference),
			tenantPresence: await database.select().from(schema.tenantCasBlob),
			buffers: dependencies.outputBuffers.state
		}).toStrictEqual({
			kind: 'recorded',
			outcome: 'generated',
			bytes,
			facts: [fact],
			progress: { discovered: 1, completed: 1, skipped: 0, failed: 0 },
			tenantReferences: [],
			tenantPresence: [],
			buffers: { free: 2, allocations: 1 }
		});
	});

	it('reuses retained output for another job without a NAR read or an output buffer', async () => {
		const { database, worker, first, create, dependencies } = await fixture();
		await worker.run(first.request);
		const second = await create();
		const before = await database.select().from(schema.sharedListingGeneration);
		const reads = vi.spyOn(env.BLOBS, 'get');
		try {
			const reuse = new SharedListingTaskWorker({
				...dependencies,
				outputBuffers: new ByteBufferPool({
					buffers: 0,
					bufferSize: 5 * 1024 * 1024
				})
			});
			const result = await reuse.run(second.request);
			expect({
				kind: result.kind,
				outcome: 'outcome' in result ? result.outcome.kind : undefined,
				reads: reads.mock.calls.map((call) => call[0]),
				computation: await database
					.select()
					.from(schema.sharedListingGeneration)
			}).toStrictEqual({
				kind: 'recorded',
				outcome: 'reused',
				reads: [],
				computation: before
			});
		} finally {
			reads.mockRestore();
		}
	});
	it('records a resource refusal when valid NAR metadata exceeds the listing limit', async () => {
		const raw = archiveTokens([
			'nix-archive-1',
			'(',
			'type',
			'symlink',
			'target',
			'a'.repeat(16 * 1024 + 1),
			')'
		]);
		const { database, worker, first, jobs } = await fixture('hello', raw);
		const result = await worker.run(first.request);
		const summary = await jobs.find(first.job.id);
		expect({
			kind: result.kind,
			outcome:
				'outcome' in result
					? {
							kind: result.outcome.kind,
							reason:
								'reason' in result.outcome ? result.outcome.reason : undefined
						}
					: undefined,
			progress: summary?.progress,
			facts: await database.select().from(schema.listingFact),
			references: await database
				.select()
				.from(schema.sharedListingOutputReference)
		}).toStrictEqual({
			kind: 'recorded',
			outcome: { kind: 'skipped', reason: 'resource-limit' },
			progress: { discovered: 1, completed: 0, skipped: 1, failed: 0 },
			facts: [],
			references: []
		});
	});
	it('defers new generation before staging or NAR reads when output buffers are full', async () => {
		const { database, first, dependencies, jobs } = await fixture();
		const worker = new SharedListingTaskWorker({
			...dependencies,
			outputBuffers: new ByteBufferPool({
				buffers: 0,
				bufferSize: 5 * 1024 * 1024
			})
		});
		const reads = vi.spyOn(env.BLOBS, 'get');
		try {
			const result = await worker.run(first.request);
			const summary = await jobs.find(first.job.id);
			const computations = await database
				.select({ owner: schema.sharedListingGeneration.owner })
				.from(schema.sharedListingGeneration);
			expect({
				result,
				reads: reads.mock.calls.map((call) => call[0]),
				tasks: await database
					.select({
						state: schema.sharedListingTask.state,
						readyAt: schema.sharedListingTask.readyAt
					})
					.from(schema.sharedListingTask),
				computations: computations.map((row) => row.owner ?? undefined),
				stages: await database.select().from(schema.sharedListingStage),
				progress: summary?.progress
			}).toStrictEqual({
				result: {
					kind: 'deferred',
					reason: 'local-capacity',
					retryAt: retryAt
				},
				reads: [],
				tasks: [
					{
						state: 'pending',
						readyAt: retryAt
					}
				],
				computations: [undefined],
				stages: [],
				progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 }
			});
		} finally {
			reads.mockRestore();
		}
	});

	it('skips an unsupported generator revision before source access or staging', async () => {
		const { database, worker, first, jobs } = await fixture();
		await database.update(schema.sharedListingJob).set({
			generatorRevision: listingGeneratorRevisionSchema.parse('future-revision')
		});
		const reads = vi.spyOn(env.BLOBS, 'get');
		try {
			const result = await worker.run(first.request);
			const summary = await jobs.find(first.job.id);
			expect({
				kind: result.kind,
				outcome:
					'outcome' in result
						? {
								kind: result.outcome.kind,
								reason:
									'reason' in result.outcome ? result.outcome.reason : undefined
							}
						: undefined,
				reads: reads.mock.calls.map((call) => call[0]),
				stages: await database.select().from(schema.sharedListingStage),
				progress: summary?.progress
			}).toStrictEqual({
				kind: 'recorded',
				outcome: { kind: 'skipped', reason: 'unsupported-generator-revision' },
				reads: [],
				stages: [],
				progress: { discovered: 1, completed: 0, skipped: 1, failed: 0 }
			});
		} finally {
			reads.mockRestore();
		}
	});

	it('records a skipped source when the captured NAR object is missing', async () => {
		const { database, worker, first, source, jobs } = await fixture();
		await env.BLOBS.delete(source);
		const result = await worker.run(first.request);
		const summary = await jobs.find(first.job.id);
		expect({
			kind: result.kind,
			outcome:
				'outcome' in result
					? {
							kind: result.outcome.kind,
							reason:
								'reason' in result.outcome ? result.outcome.reason : undefined
						}
					: undefined,
			stages: await database.select().from(schema.sharedListingStage),
			facts: await database.select().from(schema.listingFact),
			progress: summary?.progress
		}).toStrictEqual({
			kind: 'recorded',
			outcome: { kind: 'skipped', reason: 'source-unavailable' },
			stages: [],
			facts: [],
			progress: { discovered: 1, completed: 0, skipped: 1, failed: 0 }
		});
	});

	it('records malformed archives as failed generation without publishing output', async () => {
		const { database, worker, first, jobs } = await fixture(
			'hello',
			new TextEncoder().encode('not a NAR')
		);
		const result = await worker.run(first.request);
		const summary = await jobs.find(first.job.id);
		expect({
			kind: result.kind,
			outcome:
				'outcome' in result
					? {
							kind: result.outcome.kind,
							reason:
								'reason' in result.outcome ? result.outcome.reason : undefined
						}
					: undefined,
			facts: await database.select().from(schema.listingFact),
			references: await database
				.select()
				.from(schema.sharedListingOutputReference),
			progress: summary?.progress
		}).toStrictEqual({
			kind: 'recorded',
			outcome: { kind: 'failed', reason: 'generation-failed' },
			facts: [],
			references: [],
			progress: { discovered: 1, completed: 0, skipped: 0, failed: 1 }
		});
	});

	it('preserves sealed output after a storage failure and recovers it without reading the NAR', async () => {
		const { database, worker, first, dependencies } = await fixture();
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
			result = await worker.run(first.request);
		} finally {
			failure.mockRestore();
		}
		const stages = await database
			.select({
				id: schema.sharedListingStage.id,
				state: schema.sharedListingStage.state,
				sealed: schema.sharedListingStage.writesSealed
			})
			.from(schema.sharedListingStage);
		expect({
			result,
			stages: stages.map((row) => ({ state: row.state, sealed: row.sealed }))
		}).toStrictEqual({
			result: {
				kind: 'deferred',
				reason: 'storage',
				retryAt: retryAt
			},
			stages: [{ state: 'ready', sealed: true }]
		});
		vi.setSystemTime(new Date(Date.parse(now) + 60_000));
		const reads = vi.spyOn(env.BLOBS, 'get');
		try {
			const recovered = await new SharedListingTaskWorker({
				...dependencies,
				outputBuffers: new ByteBufferPool({
					buffers: 0,
					bufferSize: 5 * 1024 * 1024
				})
			}).run(first.request);
			const after = await database
				.select({
					id: schema.sharedListingStage.id,
					state: schema.sharedListingStage.state
				})
				.from(schema.sharedListingStage);
			expect({
				kind: recovered.kind,
				reads: reads.mock.calls
					.map((call) => call[0])
					.filter((key) => key.startsWith('nar/')),
				stages: after
			}).toStrictEqual({
				kind: 'recorded',
				reads: [],
				stages: stages.map((row) => ({ id: row.id, state: 'retired' }))
			});
		} finally {
			reads.mockRestore();
		}
	});

	it('does not publish when cancellation occurs during the NAR read', async () => {
		const { database, worker, first, source, jobs } = await fixture();
		const get = env.BLOBS.get.bind(env.BLOBS);
		const cancellation = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation(async (key, options) => {
				if (key === source) {
					await jobs.cancel(first.job, now);
				}
				return options === undefined ? get(key) : get(key, options);
			});
		try {
			const result = await worker.run(first.request);
			const summary = await jobs.find(first.job.id);
			expect({
				result,
				state: summary?.state,
				progress: summary?.progress,
				facts: await database.select().from(schema.listingFact),
				references: await database
					.select()
					.from(schema.sharedListingOutputReference)
			}).toStrictEqual({
				result: { kind: 'unavailable' },
				state: 'cancelled',
				progress: { discovered: 1, completed: 0, skipped: 0, failed: 0 },
				facts: [],
				references: []
			});
		} finally {
			cancellation.mockRestore();
		}
	});

	it('executes independent NARs concurrently through the same Worker', async () => {
		const context = await fixture();
		const { database, worker, create, jobs } = context;
		const second = await registerNar(database, archive('another file'), 1);
		const { job } = await create();
		const tasks = await database
			.select()
			.from(schema.sharedListingTask)
			.where(eq(schema.sharedListingTask.jobId, job.id));
		const started = Promise.withResolvers<boolean>();
		const sources = new Set<string>();
		const get = env.BLOBS.get.bind(env.BLOBS);
		const barrier = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation(async (key, options) => {
				if (key.startsWith('nar/')) {
					sources.add(key);
					if (sources.size === 2) {
						started.resolve(true);
					}
					await started.promise;
				}
				return options === undefined ? get(key) : get(key, options);
			});
		try {
			const results = await Promise.all(
				tasks.map((task) =>
					worker.run({
						job: { id: job.id, generation: job.generation },
						id: task.id
					})
				)
			);
			const summary = await jobs.find(job.id);
			expect({
				kinds: results.map((result) => result.kind),
				sources: [...sources].toSorted(byCodeUnit),
				progress: summary?.progress,
				buffers: context.dependencies.outputBuffers.state
			}).toStrictEqual({
				kinds: ['recorded', 'recorded'],
				sources: [context.source, second.source].toSorted(byCodeUnit),
				progress: { discovered: 2, completed: 2, skipped: 0, failed: 0 },
				buffers: { free: 2, allocations: 2 }
			});
		} finally {
			barrier.mockRestore();
			started.resolve(true);
		}
	});

	it.each([0, 14 * 60 * 1000 + 1])(
		'rejects an invalid %i ms budget before acquiring work',
		async (budgetMs) => {
			const { database, worker, first } = await fixture();
			const before = await database.select().from(schema.sharedListingTask);
			await expect(worker.run(first.request, { budgetMs })).rejects.toThrow(
				RangeError
			);
			expect(
				await database.select().from(schema.sharedListingTask)
			).toStrictEqual(before);
		}
	);
	it.each([false, true])(
		'requires an immutable fact to recover an unknown generator revision (fact=%s)',
		async (hasFact) => {
			const context = await fixture();
			const { database, worker, first, narHash } = context;
			const revision = listingGeneratorRevisionSchema.parse('future-revision');
			await database
				.update(schema.sharedListingJob)
				.set({ generatorRevision: revision });
			const tasks = new SharedListingTaskStore(database);
			const task = await tasks.claim(first.request, now);
			if (task.kind !== 'claimed') {
				throw new Error('Task ownership was not granted');
			}
			const generations = new SharedListingGenerationStore(database);
			const generation = await generations.claim(task.claim, now);
			if (generation.kind !== 'claimed') {
				throw new Error('Computation ownership was not granted');
			}
			const stage = await new SharedListingStageStore(database).reserve(
				generation.claim,
				now
			);
			if (stage.kind !== 'writing') {
				throw new Error('An unsealed stage was not reserved');
			}
			const service = new SharedListingStagingService(context.dependencies);
			const upload = await service.create(stage.lease);
			if (upload === undefined) {
				throw new Error('The staged upload is missing');
			}
			const bytes = new TextEncoder().encode(
				hasFact
					? '{"version":1,"root":{"type":"regular","size":5,"narOffset":96}}'
					: '{"version":2,"unknownSemantics":true}'
			);
			const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
			const part = await upload.uploadPart(1, bytes);
			await upload.complete([part]);
			await service.seal(stage.lease, upload.uploadId, {
				digest,
				size: bytes.byteLength
			});
			const fact = {
				narHash,
				generatorRevision: revision,
				format: 1 as const,
				digest,
				size: bytes.byteLength
			};
			if (hasFact) {
				await new ListingFactStore(database).record(fact);
			}
			await tasks.defer(task.claim, now, now);
			await generations.release(generation.claim, now);
			const reads = vi.spyOn(env.BLOBS, 'get');
			try {
				const result = await worker.run(first.request);
				const facts = await database.select().from(schema.listingFact);
				const references = await database
					.select({
						digest: schema.sharedListingOutputReference.digest,
						size: schema.sharedListingOutputReference.size
					})
					.from(schema.sharedListingOutputReference);
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
					facts,
					references,
					narReads: reads.mock.calls
						.map((call) => call[0])
						.filter((key) => key.startsWith('nar/'))
				}).toStrictEqual({
					kind: 'recorded',
					outcome: hasFact
						? { kind: 'generated', reason: undefined }
						: { kind: 'skipped', reason: 'unsupported-generator-revision' },
					facts: hasFact ? [{ ...fact, createdAt: now }] : [],
					references: hasFact ? [{ digest, size: bytes.byteLength }] : [],
					narReads: []
				});
			} finally {
				reads.mockRestore();
			}
		}
	);

	it.each([undefined, 'expanded', 'complete', 'future-state'] as const)(
		'uses the recorded completion expansion state %s',
		async (state) => {
			const { database, worker, first } = await fixture();
			await database
				.delete(schema.deploymentTransition)
				.where(eq(schema.deploymentTransition.id, 'shared-listing-completion'));
			if (state !== undefined) {
				await database
					.insert(schema.deploymentTransition)
					.values({ id: 'shared-listing-completion', state, updatedAt: now });
			}
			const result = await worker.run(first.request);
			const tasks = await database
				.select({ state: schema.sharedListingTask.state })
				.from(schema.sharedListingTask);
			const generations = await database
				.select({ owner: schema.sharedListingGeneration.owner })
				.from(schema.sharedListingGeneration);
			expect({
				kind: result.kind,
				tasks,
				generations: generations.map((row) => ({ owned: row.owner !== null }))
			}).toStrictEqual({
				kind: state === undefined ? 'unavailable' : 'recorded',
				tasks: [{ state: state === undefined ? 'pending' : 'completed' }],
				generations: state === undefined ? [] : [{ owned: false }]
			});
		}
	);

	it('revokes a producer when its task expires during source I/O', async () => {
		const { database, worker, first, source } = await fixture();
		const get = env.BLOBS.get.bind(env.BLOBS);
		const expiry = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation(async (key, options) => {
				if (key === source) {
					vi.setSystemTime(new Date(Date.parse(now) + 61_000));
				}
				return options === undefined ? get(key) : get(key, options);
			});
		try {
			const result = await worker.run(first.request);
			expect({
				result,
				facts: await database.select().from(schema.listingFact),
				references: await database
					.select()
					.from(schema.sharedListingOutputReference),
				outcomes: await database.select().from(schema.sharedListingTaskOutcome)
			}).toStrictEqual({
				result: { kind: 'unavailable' },
				facts: [],
				references: [],
				outcomes: []
			});
		} finally {
			expiry.mockRestore();
		}
	});

	it('repairs a missing physical CAS output without replacing its logical reference', async () => {
		const { database, worker, first, create, source } = await fixture();
		const initial = await worker.run(first.request);
		if (!('outcome' in initial) || initial.outcome.kind !== 'generated') {
			throw new Error('The initial listing was not generated');
		}
		const before = await database
			.select({
				epoch: schema.sharedListingOutputReference.epoch,
				createdAt: schema.sharedListingOutputReference.createdAt,
				digest: schema.sharedListingOutputReference.digest,
				size: schema.sharedListingOutputReference.size
			})
			.from(schema.sharedListingOutputReference);
		await env.BLOBS.delete(
			casObjectKey(initial.outcome.fact.digest, initial.outcome.incarnation)
		);
		const second = await create();
		const reads = vi.spyOn(env.BLOBS, 'get');
		try {
			const result = await worker.run(second.request);
			const after = await database
				.select({
					epoch: schema.sharedListingOutputReference.epoch,
					createdAt: schema.sharedListingOutputReference.createdAt,
					digest: schema.sharedListingOutputReference.digest,
					size: schema.sharedListingOutputReference.size
				})
				.from(schema.sharedListingOutputReference);
			expect({
				kind: result.kind,
				incarnation:
					'outcome' in result && 'incarnation' in result.outcome
						? result.outcome.incarnation
						: undefined,
				references: after,
				narReads: reads.mock.calls
					.map((call) => call[0])
					.filter((key) => key.startsWith('nar/'))
			}).toStrictEqual({
				kind: 'recorded',
				incarnation: initial.outcome.incarnation + 1,
				references: before,
				narReads: [source]
			});
		} finally {
			reads.mockRestore();
		}
	});

	it('records a terminal failure instead of replacing a conflicting immutable fact', async () => {
		const { database, worker, first, narHash, jobs } = await fixture();
		const digest = sha256HexDigestSchema.parse(
			await sha256HexBytes(new TextEncoder().encode('different listing'))
		);
		const fact = {
			narHash,
			generatorRevision: currentListingGeneratorRevision,
			format: 1 as const,
			digest,
			size: 17
		};
		await new ListingFactStore(database).record(fact);
		const result = await worker.run(first.request);
		const summary = await jobs.find(first.job.id);
		expect({
			kind: result.kind,
			outcome:
				'outcome' in result
					? {
							kind: result.outcome.kind,
							reason:
								'reason' in result.outcome ? result.outcome.reason : undefined
						}
					: undefined,
			facts: await database.select().from(schema.listingFact),
			references: await database
				.select()
				.from(schema.sharedListingOutputReference),
			progress: summary?.progress
		}).toStrictEqual({
			kind: 'recorded',
			outcome: { kind: 'failed', reason: 'generation-failed' },
			facts: [{ ...fact, createdAt: now }],
			references: [],
			progress: { discovered: 1, completed: 0, skipped: 0, failed: 1 }
		});
	});

	it('cancels before claiming work when the caller has already aborted', async () => {
		const { database, worker, first } = await fixture();
		const before = await database.select().from(schema.sharedListingTask);
		const controller = new AbortController();
		controller.abort(new Error('caller cancelled'));
		await expect(
			worker.run(first.request, { signal: controller.signal })
		).rejects.toThrow('caller cancelled');
		expect(
			await database.select().from(schema.sharedListingTask)
		).toStrictEqual(before);
	});

	it('bounds a stalled source read by the execution deadline and recovers its buffers', async () => {
		const { database, worker, first, source, dependencies } = await fixture();
		const gate = Promise.withResolvers<boolean>();
		const get = env.BLOBS.get.bind(env.BLOBS);
		const stalled = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation(async (key, options) => {
				if (key === source) {
					await gate.promise;
				}
				return options === undefined ? get(key) : get(key, options);
			});
		try {
			await expect(
				worker.run(first.request, { budgetMs: 500 })
			).rejects.toThrow(SubrequestTimeoutError);
		} finally {
			gate.resolve(true);
			stalled.mockRestore();
		}
		await vi.waitFor(
			() => {
				expect(dependencies.outputBuffers.state.free).toBe(2);
			},
			{ timeout: 10_000 }
		);
		expect({
			facts: await database.select().from(schema.listingFact),
			references: await database
				.select()
				.from(schema.sharedListingOutputReference)
		}).toStrictEqual({ facts: [], references: [] });
	});

	it('defers a competing job without releasing the active producer and later reuses its result', async () => {
		const { database, worker, first, source, create } = await fixture();
		const second = await create();
		const started = Promise.withResolvers<boolean>();
		const gate = Promise.withResolvers<boolean>();
		const get = env.BLOBS.get.bind(env.BLOBS);
		let narReads = 0;
		const pause = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation(async (key, options) => {
				if (key === source) {
					narReads += 1;
					if (narReads > 1) {
						throw new Error('A competing job read the NAR again');
					}
					started.resolve(true);
					await gate.promise;
				}
				return options === undefined ? get(key) : get(key, options);
			});
		const active = worker.run(first.request);
		try {
			await started.promise;
			const before = await database
				.select()
				.from(schema.sharedListingGeneration);
			const busy = await worker.run(second.request);
			expect({
				busy,
				generation: await database
					.select()
					.from(schema.sharedListingGeneration),
				narReads
			}).toStrictEqual({
				busy: { kind: 'deferred', reason: 'generation-busy', retryAt },
				generation: before,
				narReads: 1
			});
			gate.resolve(true);
			const firstResult = await active;
			vi.setSystemTime(new Date(retryAt));
			const reused = await worker.run(second.request);
			expect({
				first: firstResult.kind,
				reused: reused.kind,
				outcome: 'outcome' in reused ? reused.outcome.kind : undefined,
				narReads
			}).toStrictEqual({
				first: 'recorded',
				reused: 'recorded',
				outcome: 'reused',
				narReads: 1
			});
		} finally {
			gate.resolve(true);
			await Promise.allSettled([active]);
			pause.mockRestore();
		}
	});
});
