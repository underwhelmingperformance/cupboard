import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	sha256HexDigestSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	currentListingGeneratorRevision,
	listingGeneratorRevisionSchema
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { env } from 'cloudflare:workers';
import { DrizzleQueryError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256HexBytes } from '../crypto/crypto.ts';
import * as schema from '../db/d1-schema.ts';
import { ForwardListingStageStore } from '../db/forward-listing-staging.ts';
import { currentDeadlineSignal, withDeadlineBudget } from '../do/deadline.ts';
import {
	holdSubrequests,
	subrequestsAvailable,
	withSubrequestSlice
} from '../do/subrequest-slice.ts';
import {
	SharedFactsUnavailableError,
	SubrequestTimeoutError
} from '../errors.ts';
import { archive } from '../routing/shared-listing-task-worker.test-support.ts';
import { clearBlobStorage } from '../test-support.ts';

import { ByteBufferPool } from './byte-buffers.ts';
import { ForwardListingCaptureProducer } from './forward-listing-capture.ts';
import { type ForwardListingSource } from './forward-listing-staging.ts';
import {
	type NarMetadataCapture,
	OptionalNarMetadata
} from './nar-metadata.ts';
import { r2ErrorCode } from './r2-errors.ts';
import { R2RequestAdmission } from './r2-request-admission.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const raw = archive('hello');
const listing = new TextEncoder().encode(
	'{"version":1,"root":{"type":"regular","size":5,"narOffset":96}}'
);

class IoGate {
	readonly started = Promise.withResolvers<undefined>();
	readonly released = Promise.withResolvers<undefined>();
	async wait(): Promise<void> {
		this.started.resolve(undefined);
		await this.released.promise;
	}
}

function stallMultipart(phase: 'part' | 'complete', gate: IoGate): void {
	const resume = env.BLOBS.resumeMultipartUpload.bind(env.BLOBS);
	vi.spyOn(env.BLOBS, 'resumeMultipartUpload').mockImplementation((key, id) => {
		const upload = resume(key, id);
		return {
			key: upload.key,
			uploadId: upload.uploadId,
			uploadPart: async (
				...arguments_: Parameters<R2MultipartUpload['uploadPart']>
			) => {
				if (phase === 'part') {
					await gate.wait();
				}
				return upload.uploadPart(...arguments_);
			},
			complete: async (parts) => {
				const object = await upload.complete(parts);
				if (phase === 'complete') {
					await gate.wait();
				}
				return object;
			},
			abort: () => upload.abort()
		};
	});
}

function required(capture: NarMetadataCapture | undefined): NarMetadataCapture {
	if (capture === undefined) {
		throw new Error('Expected an owned forward listing capture');
	}
	return capture;
}

async function failure(operation: Promise<unknown>): Promise<unknown> {
	try {
		await operation;
		return undefined;
	} catch (error) {
		return error;
	}
}

async function isAborted(
	upload: R2MultipartUpload | undefined
): Promise<boolean | undefined> {
	if (upload === undefined) {
		return undefined;
	}
	const error = await failure(upload.uploadPart(1, new Uint8Array([1])));
	return r2ErrorCode(error) === 10_024;
}

async function fixture(buffers = 1) {
	const database = drizzle(env.CUPBOARD_DB, { schema });
	await database.insert(schema.deploymentTransition).values({
		id: 'forward-listing-staging',
		state: 'complete',
		updatedAt: now
	});
	const source: ForwardListingSource = {
		tenant: tenantIdSchema.parse('forward-tenant'),
		uploadId: uploadIdSchema.parse('upload-one'),
		owner: '00000000-0000-4000-8000-000000000001',
		narHash: NixSha256Hash.fromDigest(
			new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
		).value,
		generatorRevision: currentListingGeneratorRevision
	};
	const outputBuffers = new ByteBufferPool({
		buffers,
		bufferSize: 5 * 1024 * 1024
	});
	const deferred: Promise<void>[] = [];
	const producer = new ForwardListingCaptureProducer({
		database: env.CUPBOARD_DB,
		blobs: env.BLOBS,
		outputBuffers,
		defer: (completion) => {
			deferred.push(completion);
		},
		now: () => now
	});
	const admission = new R2RequestAdmission(6);
	const store = new ForwardListingStageStore(database);
	const capture = () => required(producer.capture(source, admission));
	async function row() {
		const value = await database
			.select()
			.from(schema.forwardListingStage)
			.get();
		if (value === undefined) {
			throw new Error('The provisional stage is missing');
		}
		return value;
	}
	return {
		database,
		source,
		outputBuffers,
		deferred,
		producer,
		admission,
		store,
		capture,
		row
	};
}

describe('owned forward listing producer', () => {
	beforeEach(clearBlobStorage);
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it.each(['d1', 'r2'] as const)(
		'tracks a timed-out %s allocation through late completion and cleanup',
		async (kind) => {
			const value = await fixture();
			const gate = new IoGate();
			const expired = Promise.withResolvers<undefined>();
			const completion = Promise.withResolvers<undefined>();
			const created: R2MultipartUpload[] = [];
			switch (kind) {
				case 'd1': {
					const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
					vi.spyOn(env.CUPBOARD_DB, 'batch').mockImplementationOnce(
						async (statements) => {
							await gate.wait();
							return batch(statements);
						}
					);
					break;
				}
				case 'r2': {
					const allocate = env.BLOBS.createMultipartUpload.bind(env.BLOBS);
					vi.spyOn(env.BLOBS, 'createMultipartUpload').mockImplementationOnce(
						async (...arguments_) => {
							await gate.wait();
							const upload = await allocate(...arguments_);
							created.push(upload);
							return upload;
						}
					);
					break;
				}
			}
			const capture = value.capture();
			capture.defer(completion.promise);
			const writing = withDeadlineBudget(1000, async () => {
				const signal = currentDeadlineSignal();
				if (signal === undefined) {
					throw new Error('The deadline scope is missing');
				}
				signal.addEventListener(
					'abort',
					() => {
						expired.resolve(undefined);
					},
					{ once: true }
				);
				await capture.sink.write(raw, new AbortController().signal);
			});
			const rejected = expect(writing).rejects.toBeInstanceOf(
				SubrequestTimeoutError
			);
			await gate.started.promise;
			await expired.promise;
			const cleanup = capture.sink.abort(new Error('capture deadline expired'));
			completion.resolve(undefined);
			let isDeferredComplete = false;
			void Promise.all(value.deferred).then(() => {
				isDeferredComplete = true;
			});
			await Promise.resolve();
			const before = { pool: value.outputBuffers.state, isDeferredComplete };
			gate.released.resolve(undefined);
			await Promise.all([rejected, cleanup, ...value.deferred]);
			const row = await value.row();
			expect({
				before,
				pool: value.outputBuffers.state,
				state: row.state,
				multipartId: row.multipartId ?? undefined,
				created: created.length,
				isAborted: await isAborted(created[0])
			}).toStrictEqual({
				before: {
					pool: { free: 0, allocations: 1 },
					isDeferredComplete: false
				},
				pool: { free: 1, allocations: 1 },
				state: 'retired',
				multipartId: created[0]?.uploadId,
				created: kind === 'r2' ? 1 : 0,
				isAborted: kind === 'r2' || undefined
			});
		}
	);
	it.each(['part', 'complete'] as const)(
		'keeps deferred completion and output memory until a cancelled %s call actually ends',
		async (phase) => {
			const value = await fixture();
			const gate = new IoGate();
			stallMultipart(phase, gate);
			const completion = Promise.withResolvers<undefined>();
			const capture = value.capture();
			capture.defer(completion.promise);
			const controller = new AbortController();
			await capture.sink.write(raw, controller.signal);
			const finishing = failure(capture.sink.finish(controller.signal));
			await gate.started.promise;
			controller.abort(new Error('capture cancelled'));
			await Promise.allSettled([capture.sink.abort(controller.signal.reason)]);
			const error = await finishing;
			completion.resolve(undefined);
			let isDeferredComplete = false;
			void Promise.all(value.deferred).then(() => {
				isDeferredComplete = true;
			});
			await Promise.resolve();
			const before = { pool: value.outputBuffers.state, isDeferredComplete };
			gate.released.resolve(undefined);
			await Promise.all(value.deferred);
			const row = await value.row();
			const object = await env.BLOBS.head(row.r2Key);
			expect({
				before,
				pool: value.outputBuffers.state,
				stage: { state: row.state, sealed: row.writesSealed },
				objectBytes: object?.size,
				isCancelled: error === controller.signal.reason
			}).toStrictEqual({
				before: {
					pool: { free: 0, allocations: 1 },
					isDeferredComplete: false
				},
				pool: { free: 1, allocations: 1 },
				stage: { state: 'retired', sealed: false },
				objectBytes: phase === 'complete' ? listing.byteLength : undefined,
				isCancelled: true
			});
		}
	);
	it('aborts only a rejected extra allocation and preserves the accepted upload under the same lease', async () => {
		const value = await fixture();
		const allocate = env.BLOBS.createMultipartUpload.bind(env.BLOBS);
		const created: R2MultipartUpload[] = [];
		vi.spyOn(env.BLOBS, 'createMultipartUpload').mockImplementationOnce(
			async (key) => {
				const reserved = await value.store.find(value.source);
				if (reserved.kind !== 'writing') {
					throw new Error('The native provisional lease is missing');
				}
				const accepted = await allocate(key);
				created.push(accepted);
				await value.store.registerMultipart(
					reserved.lease,
					accepted.uploadId,
					now
				);
				const extra = await allocate(key);
				created.push(extra);
				return extra;
			}
		);
		const capture = value.capture();
		await expect(
			capture.sink.write(raw, new AbortController().signal)
		).rejects.toThrow('allocation was rejected');
		const accepted = created[0];
		if (accepted === undefined) {
			throw new Error('The accepted upload is missing');
		}
		try {
			await accepted.uploadPart(1, new Uint8Array([1]));
			const row = await value.row();
			expect({
				stage: {
					state: row.state,
					multipartId: row.multipartId,
					sealed: row.writesSealed
				},
				extraAborted: await isAborted(created[1]),
				pool: value.outputBuffers.state
			}).toStrictEqual({
				stage: {
					state: 'pending',
					multipartId: accepted.uploadId,
					sealed: false
				},
				extraAborted: true,
				pool: { free: 1, allocations: 1 }
			});
		} finally {
			await accepted.abort();
		}
	});
	it('rejects a completed size mismatch and leaves object deletion to durable cleanup', async () => {
		const value = await fixture();
		const capture = value.capture();
		const head = env.BLOBS.head.bind(env.BLOBS);
		vi.spyOn(env.BLOBS, 'head').mockImplementationOnce(async (key) => {
			const object = await head(key);
			if (object === null) {
				return object;
			}
			return new Proxy(object, {
				get(target, property): unknown {
					const value: unknown = Reflect.get(target, property, target);
					return property === 'size' ? target.size + 1 : value;
				}
			});
		});
		const deleted = vi.spyOn(env.BLOBS, 'delete');
		const signal = new AbortController().signal;
		await capture.sink.write(raw, signal);
		await expect(capture.sink.finish(signal)).rejects.toThrow('size differs');
		const row = await value.row();
		const object = await head(row.r2Key);
		expect({
			stage: { state: row.state, sealed: row.writesSealed },
			objectBytes: object?.size,
			deleted: deleted.mock.calls,
			pool: value.outputBuffers.state
		}).toStrictEqual({
			stage: { state: 'retired', sealed: false },
			objectBytes: listing.byteLength,
			deleted: [],
			pool: { free: 1, allocations: 1 }
		});
	});
	it('reserves memory before I/O and releases an unused capture without allocating staging', async () => {
		const value = await fixture();
		const create = vi.spyOn(env.BLOBS, 'createMultipartUpload');
		const capture = value.capture();
		const before = {
			pool: value.outputBuffers.state,
			other: value.producer.capture(value.source, value.admission),
			rows: await value.database.select().from(schema.forwardListingStage),
			creates: create.mock.calls
		};
		await capture.sink.abort(new Error('unused capture'));
		expect({
			before,
			after: value.outputBuffers.state,
			creates: create.mock.calls
		}).toStrictEqual({
			before: {
				pool: { free: 0, allocations: 1 },
				other: undefined,
				rows: [],
				creates: []
			},
			after: { free: 1, allocations: 1 },
			creates: []
		});
	});
	it.each(['unknown-revision', 'no-capacity'] as const)(
		'declines %s without allocating resources',
		async (reason) => {
			const value = await fixture(reason === 'no-capacity' ? 0 : 1);
			const source =
				reason === 'unknown-revision'
					? {
							...value.source,
							generatorRevision:
								listingGeneratorRevisionSchema.parse('future-revision')
						}
					: value.source;
			const create = vi.spyOn(env.BLOBS, 'createMultipartUpload');
			expect({
				capture: value.producer.capture(source, value.admission),
				pool: value.outputBuffers.state,
				rows: await value.database.select().from(schema.forwardListingStage),
				creates: create.mock.calls
			}).toStrictEqual({
				capture: undefined,
				pool: { free: reason === 'no-capacity' ? 0 : 1, allocations: 0 },
				rows: [],
				creates: []
			});
		}
	);
	it('seals measured canonical listing bytes under the native source without creating authority', async () => {
		const value = await fixture();
		const reads = vi.spyOn(env.BLOBS, 'get');
		const metadata = new OptionalNarMetadata(value.capture());
		metadata.write(raw.subarray(0, 37));
		metadata.write(raw.subarray(37));
		metadata.finish();
		await Promise.all(value.deferred);
		const row = await value.row();
		const sourceReads = reads.mock.calls.map(([key]) => key);
		const object = await env.BLOBS.get(row.r2Key);
		const bytes =
			object === null ? undefined : new Uint8Array(await object.arrayBuffer());
		expect({
			stage: {
				state: row.state,
				source: {
					tenant: row.tenant,
					uploadId: row.uploadId,
					owner: row.owner,
					narHash: row.narHash,
					generatorRevision: row.generatorRevision
				},
				digest: row.digest,
				size: row.size,
				sealed: row.writesSealed
			},
			bytes,
			sourceReads,
			pool: value.outputBuffers.state,
			facts: await value.database.select().from(schema.listingFact),
			references: await value.database.select().from(schema.artifactReference),
			retention: await value.database
				.select()
				.from(schema.sharedListingOutputReference)
		}).toStrictEqual({
			stage: {
				state: 'ready',
				source: value.source,
				digest: await sha256HexBytes(listing),
				size: listing.byteLength,
				sealed: true
			},
			bytes: listing,
			sourceReads: [],
			pool: { free: 1, allocations: 1 },
			facts: [],
			references: [],
			retention: []
		});
	});
	it.each(['writing', 'ready', 'busy'] as const)(
		'declines existing %s work without retiring its allocation',
		async (kind) => {
			const value = await fixture();
			const reserved = await value.store.reserve(value.source, now);
			if (reserved.kind !== 'writing') {
				throw new Error('Expected a fresh provisional lease');
			}
			await value.store.registerMultipart(
				reserved.lease,
				'existing-multipart',
				now
			);
			if (kind === 'ready') {
				await value.store.recordSeal(
					reserved.lease,
					'existing-multipart',
					{ digest: sha256HexDigestSchema.parse('a'.repeat(64)), size: 1 },
					now
				);
			}
			const original = await value.row();
			const source =
				kind === 'busy'
					? { ...value.source, owner: crypto.randomUUID() }
					: value.source;
			const capture = required(value.producer.capture(source, value.admission));
			const create = vi.spyOn(env.BLOBS, 'createMultipartUpload');
			await expect(
				capture.sink.write(raw, new AbortController().signal)
			).rejects.toThrow();
			await capture.sink.abort(new Error('declined capture'));
			expect({
				row: await value.row(),
				pool: value.outputBuffers.state,
				creates: create.mock.calls
			}).toStrictEqual({
				row: original,
				pool: { free: 1, allocations: 1 },
				creates: []
			});
		}
	);
	it.each(['d1', 'r2'] as const)(
		'keeps memory and deferred lifetime until cancelled %s initialisation finishes',
		async (kind) => {
			const value = await fixture();
			const started = Promise.withResolvers<undefined>();
			const release = Promise.withResolvers<undefined>();
			const completion = Promise.withResolvers<undefined>();
			const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const allocate = env.BLOBS.createMultipartUpload.bind(env.BLOBS);
			const created: R2MultipartUpload[] = [];
			switch (kind) {
				case 'd1': {
					vi.spyOn(env.CUPBOARD_DB, 'batch').mockImplementationOnce(
						async (statements) => {
							const result = await batch(statements);
							started.resolve(undefined);
							await release.promise;
							return result;
						}
					);
					break;
				}
				case 'r2': {
					vi.spyOn(env.BLOBS, 'createMultipartUpload').mockImplementationOnce(
						async (...arguments_) => {
							started.resolve(undefined);
							await release.promise;
							const upload = await allocate(...arguments_);
							created.push(upload);
							return upload;
						}
					);
					break;
				}
			}
			const capture = value.capture();
			capture.defer(completion.promise);
			const controller = new AbortController();
			const writing = capture.sink.write(raw, controller.signal);
			const rejected = failure(writing);
			await started.promise;
			controller.abort(new Error('capture cancelled'));
			const cleanup = capture.sink.abort(controller.signal.reason);
			completion.resolve(undefined);
			let isDeferredComplete = false;
			void Promise.all(value.deferred).then(() => {
				isDeferredComplete = true;
			});
			await Promise.resolve();
			const before = { pool: value.outputBuffers.state, isDeferredComplete };
			release.resolve(undefined);
			await Promise.all([rejected, cleanup, ...value.deferred]);
			const error = await rejected;
			const cause =
				error instanceof SharedFactsUnavailableError ? error.cause : error;
			const storageCause =
				cause instanceof DrizzleQueryError ? cause.cause : cause;
			const row = await value.row();
			const upload = created[0];
			expect({
				before,
				after: value.outputBuffers.state,
				stage: {
					state: row.state,
					multipartId: row.multipartId ?? undefined,
					sealed: row.writesSealed
				},
				created: created.length,
				isAborted: await isAborted(upload),
				isCancelled: storageCause === controller.signal.reason
			}).toStrictEqual({
				before: {
					pool: { free: 0, allocations: 1 },
					isDeferredComplete: false
				},
				after: { free: 1, allocations: 1 },
				stage: {
					state: 'retired',
					multipartId: upload?.uploadId,
					sealed: false
				},
				created: kind === 'r2' ? 1 : 0,
				isAborted: kind === 'r2' || undefined,
				isCancelled: true
			});
		}
	);
	it('refuses optional D1 work before allocation when native requests consume the available allowance', async () => {
		const value = await fixture();
		const result = await withSubrequestSlice(
			async () => {
				const native = holdSubrequests(1);
				const capture = value.capture();
				await expect(
					capture.sink.write(raw, new AbortController().signal)
				).rejects.toThrow();
				await Promise.allSettled([
					capture.sink.abort(new Error('metadata refused'))
				]);
				native.release();
				return subrequestsAvailable();
			},
			{ subrequests: 1, reserve: 0 }
		);
		expect({
			remaining: result,
			pool: value.outputBuffers.state,
			rows: await value.database.select().from(schema.forwardListingStage)
		}).toStrictEqual({
			remaining: 1,
			pool: { free: 1, allocations: 1 },
			rows: []
		});
	});
});
