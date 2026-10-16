import { rootLogger } from '@cupboard/logger';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import {
	currentListingGeneratorRevision,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ByteBufferPool } from '../blob/byte-buffers.ts';
import { ConnectionLimitedMultipartBucket } from '../blob/connection-limited-multipart.ts';
import { ForwardListingCaptureProducer } from '../blob/forward-listing-capture.ts';
import { NarListingMetadataSink } from '../blob/nar-listing-metadata.ts';
import { NarListingOutput } from '../blob/nar-listing-output.ts';
import { type NarMetadataCapture } from '../blob/nar-metadata.ts';
import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { type R2RequestAdmission } from '../blob/r2-request-admission.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { SubrequestSliceExceededError } from '../errors.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import { handleWorkerQueue } from '../routing/queue.ts';
import {
	type VerificationMetadataResources,
	type VerificationMetadataSource,
	verifyTenant,
	type VerifyTenantOptions
} from '../routing/scheduled.ts';
import {
	currentServer,
	currentServerTenant,
	expectSingleUploadDecision,
	fetchNarInfo,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	putNarBytes,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

import { boundedBlobs, boundedD1, boundedWorkerEnv } from './bounded-io.ts';
import {
	subrequestsAvailable,
	withSubrequestSlice
} from './subrequest-slice.ts';

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

async function fixture(isDeclared = false) {
	const token = await initialise();
	const nar = await sourceNar();
	const storePathHash = storePathHashSchema.parse('a'.repeat(32));
	const metadata = uploadMetadata({
		storePathHash,
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await putNarBytes(upload.r2Key, nar);
	await markUploadPendingVerification(upload.uploadId);
	if (isDeclared) {
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.pendingUploads)
				.set({
					declaredFileHash: nar.fileHash,
					declaredFileSize: nar.narBytes.byteLength
				})
				.where(eq(schema.pendingUploads.id, upload.uploadId))
				.run();
		});
	}
	return { nar, upload, storePathHash };
}

function verify(options: VerifyTenantOptions, bindings: typeof env = env) {
	return verifyTenant(
		rootLogger(),
		bindings,
		new NarReadBufferPool(),
		currentServerTenant(),
		undefined,
		undefined,
		undefined,
		options
	);
}

function bindingsAfterMetadataDrain(
	drained: Promise<undefined>,
	bindings = boundedWorkerEnv(env)
) {
	const stub = new Proxy(currentServer(), {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (property === 'recordVerificationsWithinBudget') {
				return async (...arguments_: unknown[]): Promise<unknown> => {
					await drained;
					if (typeof value !== 'function') {
						throw new TypeError('The native verdict RPC is unavailable');
					}
					const result: unknown = Reflect.apply(value, target, arguments_);
					return result;
				};
			}
			if (typeof value === 'function') {
				// RPC method properties are remote lookups; .bind would make a remote call.
				return (...arguments_: unknown[]): unknown =>
					Reflect.apply(value, target, arguments_);
			}
			return value;
		}
	});
	const namespace = new Proxy(env.CUPBOARD_DO, {
		get(target, property) {
			if (property === 'idFromName') {
				return () => currentServer().id;
			}
			if (property === 'get') {
				return () => stub;
			}
			const value: unknown = Reflect.get(target, property, target);
			return value;
		}
	});
	return new Proxy(bindings, {
		get(target, property) {
			if (property === 'CUPBOARD_DO') {
				return namespace;
			}
			const value: unknown = Reflect.get(target, property, target);
			return value;
		}
	});
}

class OptionalIoProbe {
	readonly drained = Promise.withResolvers<undefined>();
	readonly deferred: Promise<void>[] = [];
	calls = 0;
	isRefused = false;
	constructor(private readonly kind: 'd1' | 'r2') {}
	private capture(
		source: VerificationMetadataSource,
		resources: VerificationMetadataResources
	): NarMetadataCapture {
		const database = boundedD1(env.CUPBOARD_DB, { priority: 'optional' });
		const objects = new ConnectionLimitedMultipartBucket(
			boundedBlobs(env.BLOBS),
			resources.admission,
			{ priority: 'optional' }
		);
		const operation =
			this.kind === 'd1'
				? () => database.prepare('SELECT 1 AS value').first()
				: () => objects.head(source.claim.r2Key);
		return {
			sink: {
				write: async () => {
					try {
						for (let index = 0; index < 16; index += 1) {
							await operation();
							this.calls += 1;
						}
					} finally {
						this.drained.resolve(undefined);
					}
				},
				finish: () => Promise.resolve(),
				abort: (reason) => {
					this.isRefused = reason instanceof SubrequestSliceExceededError;
					return Promise.resolve();
				}
			},
			defer: (completion) => {
				this.deferred.push(completion);
			}
		};
	}
	get options(): VerifyTenantOptions {
		return {
			metadataFor: (source, resources) => this.capture(source, resources)
		};
	}
}

describe('fresh verification listing metadata', () => {
	beforeEach(resetTestServer);
	it.each([false, true])(
		'defers owned capture after queue acknowledgement (declared=%s)',
		async (isDeclared) => {
			const value = await fixture(isDeclared);
			const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
			await database.insert(d1Schema.deploymentTransition).values({
				id: 'forward-listing-staging',
				state: 'complete',
				updatedAt: isoTimestamp(new Date())
			});
			const context = createExecutionContext();
			const outputBuffers = new ByteBufferPool({
				buffers: 1,
				bufferSize: 5 * 1024 * 1024
			});
			const gate = Promise.withResolvers<undefined>();
			const started = Promise.withResolvers<undefined>();
			const head = env.BLOBS.head.bind(env.BLOBS);
			const sealing = vi
				.spyOn(env.BLOBS, 'head')
				.mockImplementation(async (key) => {
					if (key.startsWith('shared-artifact-staging/')) {
						started.resolve(undefined);
						await gate.promise;
					}
					return head(key);
				});
			const deferred = vi.fn((completion: Promise<void>) => {
				context.waitUntil(completion);
			});
			const actions: string[] = [];
			const metadataFor: NonNullable<VerifyTenantOptions['metadataFor']> = (
				source,
				resources
			) => {
				if (resources.defer === undefined) {
					throw new Error('The queue capture lifetime is unavailable');
				}
				return new ForwardListingCaptureProducer({
					database: env.CUPBOARD_DB,
					blobs: env.BLOBS,
					outputBuffers,
					defer: resources.defer
				}).capture(
					{
						tenant: source.tenant,
						uploadId: source.claim.uploadId,
						owner: source.owner,
						narHash: source.claim.narHash,
						generatorRevision: currentListingGeneratorRevision
					},
					resources.admission
				);
			};
			try {
				await handleWorkerQueue(
					{
						queue: 'cupboard-maintenance',
						metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
						messages: [
							{
								id: 'owned-verify',
								body: { kind: 'tenant-verify', tenant: currentServerTenant() },
								timestamp: new Date(),
								attempts: 1,
								ack: () => {
									actions.push('ack');
								},
								retry: () => {
									actions.push('retry');
								}
							}
						],
						ackAll: () => {
							throw new Error('Unexpected batch acknowledgement');
						},
						retryAll: () => {
							throw new Error('Unexpected batch retry');
						}
					},
					bindingsAfterMetadataDrain(Promise.resolve(undefined), env),
					new NarReadBufferPool(),
					{ metadataFor, defer: deferred }
				);
				if (deferred.mock.calls.length === 0) {
					throw new Error(
						'The queue did not supply its invocation lifetime to the metadata factory'
					);
				}
				await started.promise;
				await fetchNarInfo(value.storePathHash);
				let isComplete = false;
				const waiting = waitOnExecutionContext(context);
				void waiting.then(() => {
					isComplete = true;
				});
				await Promise.resolve();
				const before = {
					isComplete,
					actions: [...actions],
					deferred: deferred.mock.calls.length,
					ready: await database
						.select()
						.from(d1Schema.forwardListingStage)
						.where(eq(d1Schema.forwardListingStage.state, 'ready'))
				};
				gate.resolve(undefined);
				await waiting;
				const stages = await database
					.select({
						state: d1Schema.forwardListingStage.state,
						uploadId: d1Schema.forwardListingStage.uploadId
					})
					.from(d1Schema.forwardListingStage);
				expect({
					before,
					isComplete,
					actions,
					stages,
					pool: outputBuffers.state
				}).toStrictEqual({
					before: {
						isComplete: false,
						actions: ['ack'],
						deferred: 1,
						ready: []
					},
					isComplete: true,
					actions: ['ack'],
					stages: [{ state: 'ready', uploadId: value.upload.uploadId }],
					pool: { free: 1, allocations: 1 }
				});
			} finally {
				gate.resolve(undefined);
				await waitOnExecutionContext(context);
				sealing.mockRestore();
			}
		}
	);
	it.each([
		{ isDeclared: false, budget: 8 },
		{ isDeclared: true, budget: 8 },
		{ isDeclared: false, budget: 64 },
		{ isDeclared: true, budget: 64 }
	])(
		'publishes the NAR with owned capture (declared=$isDeclared, allowance=$budget)',
		async ({ isDeclared, budget }) => {
			const value = await fixture(isDeclared);
			const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
			await database.insert(d1Schema.deploymentTransition).values({
				id: 'forward-listing-staging',
				state: 'complete',
				updatedAt: isoTimestamp(new Date())
			});
			const outputBuffers = new ByteBufferPool({
				buffers: 1,
				bufferSize: 5 * 1024 * 1024
			});
			const deferred: Promise<void>[] = [];
			const drained = Promise.withResolvers<undefined>();
			const sources: VerificationMetadataSource[] = [];
			const awaitCapture = async (completion: Promise<void>): Promise<void> => {
				try {
					await completion;
				} finally {
					drained.resolve(undefined);
				}
			};
			const producer = new ForwardListingCaptureProducer({
				database: env.CUPBOARD_DB,
				blobs: env.BLOBS,
				outputBuffers,
				defer: (completion) => {
					deferred.push(awaitCapture(completion));
				}
			});
			const remaining = await withSubrequestSlice(
				async () => {
					await verify(
						{
							metadataFor: (source, resources) => {
								sources.push(source);
								return producer.capture(
									{
										tenant: source.tenant,
										uploadId: source.claim.uploadId,
										owner: source.owner,
										narHash: source.claim.narHash,
										generatorRevision: currentListingGeneratorRevision
									},
									resources.admission
								);
							}
						},
						bindingsAfterMetadataDrain(drained.promise)
					);
					await Promise.all(deferred);
					return subrequestsAvailable();
				},
				{ subrequests: budget, reserve: 0 }
			);
			await fetchNarInfo(value.storePathHash);
			const source = sources[0];
			if (source === undefined) {
				throw new Error('The native capture source is missing');
			}
			const ready = await database
				.select({
					tenant: d1Schema.forwardListingStage.tenant,
					uploadId: d1Schema.forwardListingStage.uploadId,
					owner: d1Schema.forwardListingStage.owner,
					narHash: d1Schema.forwardListingStage.narHash,
					generatorRevision: d1Schema.forwardListingStage.generatorRevision,
					size: d1Schema.forwardListingStage.size,
					sealed: d1Schema.forwardListingStage.writesSealed
				})
				.from(d1Schema.forwardListingStage)
				.where(eq(d1Schema.forwardListingStage.state, 'ready'));
			expect({
				ready,
				pool: outputBuffers.state,
				hasProtectedRetries: remaining >= 2,
				references: await database.select().from(d1Schema.artifactReference)
			}).toStrictEqual({
				ready:
					budget === 64
						? [
								{
									tenant: currentServerTenant(),
									uploadId: value.upload.uploadId,
									owner: source.owner,
									narHash: value.nar.narHash,
									generatorRevision: currentListingGeneratorRevision,
									size: 63,
									sealed: true
								}
							]
						: [],
				pool: { free: 1, allocations: 1 },
				hasProtectedRetries: true,
				references: []
			});
		}
	);
	it.each(['d1', 'r2'] as const)(
		'preserves verdict retries while optional %s work exhausts the remaining allowance',
		async (kind) => {
			const value = await fixture(true);
			const probe = new OptionalIoProbe(kind);
			const result = await withSubrequestSlice(
				async () => {
					await verify(
						probe.options,
						bindingsAfterMetadataDrain(probe.drained.promise)
					);
					await Promise.all(probe.deferred);
					return {
						calls: probe.calls,
						isRefused: probe.isRefused,
						remaining: subrequestsAvailable(),
						deferred: probe.deferred.length
					};
				},
				{ subrequests: 8, reserve: 0 }
			);
			await fetchNarInfo(value.storePathHash);
			expect(result).toStrictEqual({
				calls: 3,
				isRefused: true,
				remaining: 2,
				deferred: 1
			});
		}
	);
	it.each([false, true])(
		'publishes the NAR while optional listing sealing is blocked (isDeclared: %s)',
		async (isDeclared) => {
			const value = await fixture(isDeclared);
			const key = r2ObjectKeySchema.parse(
				`artifact-staging/forward-${crypto.randomUUID()}`
			);
			const upload = await env.BLOBS.createMultipartUpload(key);
			const gate = Promise.withResolvers<undefined>();
			const sealing = Promise.withResolvers<undefined>();
			const deferred: Promise<void>[] = [];
			const facts: NarListingFact[] = [];
			const sources: VerificationMetadataSource[] = [];
			const abandoned: unknown[] = [];
			const sinkFor = (admission: R2RequestAdmission) => {
				const metadata = new ConnectionLimitedMultipartBucket(
					boundedBlobs(env.BLOBS),
					admission,
					{ priority: 'optional' }
				);
				return new NarListingMetadataSink({
					output: new NarListingOutput({
						upload: metadata.resumeMultipartUpload(key, upload.uploadId),
						narHash: value.nar.narHash
					}),
					seal: async (fact, signal) => {
						sealing.resolve(undefined);
						await gate.promise;
						signal.throwIfAborted();
						facts.push(fact);
					},
					abandon: async (reason) => {
						abandoned.push(reason);
						await env.BLOBS.delete(key);
					}
				});
			};
			try {
				await verify({
					metadataFor: (source, resources) => {
						sources.push(source);
						return {
							sink: sinkFor(resources.admission),
							defer: (completion) => {
								deferred.push(completion);
							}
						};
					}
				});
				await fetchNarInfo(value.storePathHash);
				expect({
					facts,
					deferred: deferred.length,
					sources: sources.map(({ tenant, owner, claim }) => ({
						tenant,
						owned: owner.length > 0,
						uploadId: claim.uploadId,
						key: claim.r2Key,
						narHash: claim.narHash,
						narSize: claim.narSize,
						reuse: claim.reuse,
						blob: claim.blob
					}))
				}).toStrictEqual({
					facts: [],
					deferred: 1,
					sources: [
						{
							tenant: currentServerTenant(),
							owned: true,
							uploadId: value.upload.uploadId,
							key: value.upload.r2Key,
							narHash: value.nar.narHash,
							narSize: value.nar.narSize,
							reuse: false,
							blob: isDeclared
								? {
										fileHash: value.nar.fileHash,
										fileSize: value.nar.narBytes.byteLength
									}
								: undefined
						}
					]
				});
				await sealing.promise;
				gate.resolve(undefined);
				await Promise.all(deferred);
				const object = await env.BLOBS.get(key);
				if (object === null) {
					throw new Error('The captured listing is missing');
				}
				const bytes = new Uint8Array(await object.arrayBuffer());
				const listing: unknown = JSON.parse(new TextDecoder().decode(bytes));
				expect({ facts, listing, abandoned }).toStrictEqual({
					facts: [
						{
							narHash: value.nar.narHash,
							generatorRevision: currentListingGeneratorRevision,
							format: 1,
							digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
							size: bytes.byteLength
						}
					],
					listing: {
						version: 1,
						root: { type: 'regular', size: 5, narOffset: 96 }
					},
					abandoned: []
				});
			} finally {
				gate.resolve(undefined);
				await Promise.all(deferred);
				await upload.abort();
				await env.BLOBS.delete(key);
			}
		}
	);
	it('publishes a valid NAR when optional capture setup throws', async () => {
		const value = await fixture();
		const metadataFor = vi.fn(() => {
			throw new Error('Metadata setup failed');
		});
		await verify({ metadataFor });
		await fetchNarInfo(value.storePathHash);
		expect(metadataFor).toHaveBeenCalledOnce();
	});
	it('uses the Worker capture policy even when a provider supplies custom limits', async () => {
		const value = await fixture();
		const deferred: Promise<void>[] = [];
		const sink = {
			write: vi.fn(() => Promise.resolve()),
			finish: vi.fn(() => Promise.resolve()),
			abort: vi.fn(() => Promise.resolve())
		};
		const capture: NarMetadataCapture = {
			sink,
			defer: (completion) => {
				deferred.push(completion);
			},
			maxBufferedBytes: 0,
			operationTimeoutMs: 0
		};
		await verify({ metadataFor: () => capture });
		await Promise.all(deferred);
		await fetchNarInfo(value.storePathHash);
		expect({
			writes: sink.write.mock.calls.length,
			finishes: sink.finish.mock.calls.length,
			aborts: sink.abort.mock.calls.length,
			deferred: deferred.length
		}).toStrictEqual({ writes: 1, finishes: 1, aborts: 0, deferred: 1 });
	});
});
