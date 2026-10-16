import {
	currentListingGeneratorRevision,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { DrizzleQueryError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/d1-schema.ts';
import { ForwardListingStageStore } from '../db/forward-listing-staging.ts';
import { boundedBlobs, boundedD1 } from '../do/bounded-io.ts';
import { boundedSubrequest } from '../do/deadline.ts';
import { spendSubrequests } from '../do/subrequest-slice.ts';
import {
	SharedFactsUnavailableError,
	SubrequestTimeoutError
} from '../errors.ts';
import { withSpan } from '../observability/span.ts';

import {
	ArtifactOutputBuffer,
	ArtifactWriterUnavailableError
} from './artifact-multipart-writer.ts';
import { type ByteBufferPool } from './byte-buffers.ts';
import { ConnectionLimitedMultipartBucket } from './connection-limited-multipart.ts';
import {
	type ForwardListingSource,
	forwardListingSourceSchema,
	type ForwardListingStageLease
} from './forward-listing-staging.ts';
import { NarListingMetadataSink } from './nar-listing-metadata.ts';
import { NarListingOutput } from './nar-listing-output.ts';
import {
	type NarMetadataCapture,
	type NarMetadataSink
} from './nar-metadata.ts';
import { r2ErrorCode } from './r2-errors.ts';
import { type R2RequestAdmission } from './r2-request-admission.ts';

/**
 * Pass raw bindings. Capture applies optional admission, deadlines and
 * accounting, and extends deferred completion through actual outstanding I/O.
 */
export interface ForwardListingCaptureDependencies {
	readonly database: D1Database;
	readonly blobs: R2Bucket;
	readonly defer: (completion: Promise<void>) => void;
	readonly outputBuffers?: ByteBufferPool;
	readonly now?: () => IsoTimestamp;
}

interface CaptureResources {
	readonly buffer: ArtifactOutputBuffer;
	readonly admission: R2RequestAdmission;
}

class OwnedForwardListingCapture implements NarMetadataSink {
	private readonly controller = new AbortController();
	private readonly pending = new Set<Promise<void>>();
	private readonly now: () => IsoTimestamp;
	private initializing: Promise<NarListingMetadataSink> | undefined;
	private aborting: Promise<void> | undefined;
	private lease: ForwardListingStageLease | undefined;
	private upload: R2MultipartUpload | undefined;
	private output: NarListingOutput | undefined;
	private delegate: NarListingMetadataSink | undefined;
	private mayHaveReserved = false;

	constructor(
		private readonly dependencies: ForwardListingCaptureDependencies,
		private readonly source: ForwardListingSource,
		private readonly resources: CaptureResources
	) {
		this.now = dependencies.now ?? (() => isoTimestamp(new Date()));
	}

	private store(signal?: AbortSignal): ForwardListingStageStore {
		return new ForwardListingStageStore(
			drizzle(
				boundedD1(this.dependencies.database, { priority: 'optional', signal }),
				{ schema }
			)
		);
	}
	private objects(signal: AbortSignal): ConnectionLimitedMultipartBucket {
		return new ConnectionLimitedMultipartBucket(
			boundedBlobs(this.dependencies.blobs),
			this.resources.admission,
			{ priority: 'optional', signal }
		);
	}
	private async storage<T>(operation: Promise<T>): Promise<T> {
		try {
			return await operation;
		} catch (error) {
			let cause = error;
			while (
				cause instanceof SharedFactsUnavailableError ||
				cause instanceof DrizzleQueryError
			) {
				cause = cause.cause;
			}
			if (cause instanceof SubrequestTimeoutError) {
				await cause.abandoned;
			}
			throw error;
		}
	}
	private async assertCurrent(
		lease: ForwardListingStageLease,
		store: ForwardListingStageStore,
		signal: AbortSignal
	): Promise<void> {
		signal.throwIfAborted();
		if (!(await this.storage(store.canWrite(lease, this.now())))) {
			throw new ArtifactWriterUnavailableError(
				'the provisional listing lease is no longer writable'
			);
		}
		signal.throwIfAborted();
	}
	private async createUpload(
		lease: ForwardListingStageLease,
		signal: AbortSignal
	): Promise<R2MultipartUpload> {
		spendSubrequests(1, 'r2.createMultipartUpload');
		const upload = await this.dependencies.blobs.createMultipartUpload(
			lease.key
		);
		this.upload = this.objects(signal).resumeMultipartUpload(
			lease.key,
			upload.uploadId
		);
		return this.upload;
	}
	// A deadline must not discard the upload ID returned by a late allocation.
	private async allocate(
		lease: ForwardListingStageLease,
		signal: AbortSignal
	): Promise<R2MultipartUpload> {
		let actual: Promise<R2MultipartUpload> | undefined;
		try {
			return await boundedSubrequest(() => {
				actual = this.resources.admission.write(
					() => this.createUpload(lease, signal),
					{ priority: 'optional', signal }
				);
				return actual;
			}, 'r2.createMultipartUpload');
		} catch (error) {
			await Promise.allSettled([actual]);
			throw error;
		}
	}
	private async seal(
		lease: ForwardListingStageLease,
		fact: NarListingFact,
		signal: AbortSignal
	): Promise<void> {
		const combined = AbortSignal.any([signal, this.controller.signal]);
		return withSpan(
			'artifact.capture.forward.seal',
			{
				stageId: lease.id,
				narHash: this.source.narHash,
				generatorRevision: this.source.generatorRevision
			},
			async () => {
				const store = this.store(combined);
				await this.assertCurrent(lease, store, combined);
				const head = await this.storage(this.objects(combined).head(lease.key));
				combined.throwIfAborted();
				if (head?.size !== fact.size) {
					throw new ArtifactWriterUnavailableError(
						'the provisional listing size differs from its measured bytes'
					);
				}
				const upload = this.upload;
				if (
					upload === undefined ||
					!(await this.storage(
						store.recordSeal(
							lease,
							upload.uploadId,
							{ digest: fact.digest, size: fact.size },
							this.now()
						)
					))
				) {
					throw new ArtifactWriterUnavailableError(
						'the provisional listing seal is no longer owned'
					);
				}
				combined.throwIfAborted();
			}
		);
	}
	private async initialize(
		signal: AbortSignal
	): Promise<NarListingMetadataSink> {
		const combined = AbortSignal.any([signal, this.controller.signal]);
		combined.throwIfAborted();
		const store = this.store(combined);
		this.mayHaveReserved = true;
		const reserved = await this.storage(store.reserve(this.source, this.now()));
		if (reserved.kind !== 'writing' || reserved.multipartId !== undefined) {
			this.mayHaveReserved = false;
			throw new ArtifactWriterUnavailableError(
				'provisional listing generation is already allocated or unavailable'
			);
		}
		this.lease = reserved.lease;
		await this.assertCurrent(reserved.lease, store, combined);
		const upload = await this.allocate(reserved.lease, combined);
		if (
			!(await this.storage(
				store.registerMultipart(reserved.lease, upload.uploadId, this.now())
			))
		) {
			throw new ArtifactWriterUnavailableError(
				'the provisional multipart allocation was rejected'
			);
		}
		combined.throwIfAborted();
		this.output = new NarListingOutput({
			upload,
			narHash: this.source.narHash,
			generatorRevision: this.source.generatorRevision,
			maximumOutputBytes: reserved.lease.maximumBytes,
			outputBuffer: this.resources.buffer,
			signal: combined,
			assertCurrent: () => this.assertCurrent(reserved.lease, store, combined)
		});
		this.delegate = new NarListingMetadataSink({
			output: this.output,
			seal: (fact, finishSignal) =>
				this.seal(reserved.lease, fact, finishSignal),
			abandon: () => this.retire()
		});
		return this.delegate;
	}
	private async get(signal: AbortSignal): Promise<NarListingMetadataSink> {
		signal.throwIfAborted();
		this.controller.signal.throwIfAborted();
		this.initializing ??= withSpan(
			'artifact.capture.forward.initialize',
			{
				tenant: this.source.tenant,
				uploadId: this.source.uploadId,
				narHash: this.source.narHash,
				generatorRevision: this.source.generatorRevision
			},
			() => this.initialize(signal)
		);
		return this.initializing;
	}
	private async retire(): Promise<void> {
		const store = this.store();
		if (this.lease === undefined && this.mayHaveReserved) {
			const existing = await this.storage(store.find(this.source));
			if (existing.kind === 'writing' || existing.kind === 'ready') {
				this.lease = existing.lease;
			}
		}
		const lease = this.lease;
		if (lease === undefined) {
			return;
		}
		try {
			if (this.upload !== undefined) {
				await this.storage(
					store.registerMultipart(lease, this.upload.uploadId, this.now())
				);
			}
		} finally {
			await this.storage(
				store.retire(lease, this.now(), this.upload?.uploadId)
			);
		}
	}
	private async abortUpload(): Promise<void> {
		try {
			await this.storage(this.upload?.abort() ?? Promise.resolve());
		} catch (error) {
			if (r2ErrorCode(error) !== 10_024) {
				throw error;
			}
		}
	}
	private async cleanup(reason: unknown): Promise<void> {
		try {
			await Promise.allSettled([this.initializing]);
			if (this.delegate !== undefined) {
				await this.delegate.abort(reason);
				return;
			}
			const results = await Promise.allSettled([
				this.abortUpload(),
				this.retire()
			]);
			const errors: unknown[] = [];
			for (const result of results) {
				if (result.status === 'rejected') {
					errors.push(result.reason);
				}
			}
			if (errors.length > 0) {
				throw new AggregateError(
					errors,
					'Forward listing capture cleanup failed'
				);
			}
		} finally {
			this.resources.buffer.release();
		}
	}
	private async execute(operation: Promise<void>): Promise<void> {
		try {
			await operation;
		} catch (error) {
			await Promise.allSettled([this.abort(error)]);
			throw error;
		}
	}
	private run(operation: Promise<void>): Promise<void> {
		const pending = this.execute(operation);
		this.pending.add(pending);
		const release = () => {
			this.pending.delete(pending);
		};
		void pending.then(release).catch(release);
		return pending;
	}
	private async writeChunk(
		chunk: Uint8Array,
		signal: AbortSignal
	): Promise<void> {
		const delegate = await this.get(signal);
		await delegate.write(chunk, signal);
	}
	private async finishOutput(signal: AbortSignal): Promise<void> {
		const delegate = await this.get(signal);
		await delegate.finish(signal);
	}
	write(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
		return this.run(this.writeChunk(chunk, signal));
	}
	finish(signal: AbortSignal): Promise<void> {
		return this.run(this.finishOutput(signal));
	}
	abort(reason: unknown): Promise<void> {
		this.controller.abort(reason);
		this.aborting ??= this.cleanup(reason);
		return this.aborting;
	}
	async deferred(completion: Promise<void>): Promise<void> {
		try {
			await completion;
		} finally {
			while (this.pending.size > 0) {
				await Promise.allSettled(this.pending);
			}
			await Promise.allSettled([this.aborting]);
			await this.output?.settled();
			this.resources.buffer.release();
		}
	}
}

export class ForwardListingCaptureProducer {
	constructor(
		private readonly dependencies: ForwardListingCaptureDependencies
	) {}
	capture(
		input: ForwardListingSource,
		admission: R2RequestAdmission
	): NarMetadataCapture | undefined {
		const source = forwardListingSourceSchema.parse(input);
		if (source.generatorRevision !== currentListingGeneratorRevision) {
			return undefined;
		}
		const buffer = ArtifactOutputBuffer.tryAcquire(
			this.dependencies.outputBuffers
		);
		if (buffer === undefined) {
			return undefined;
		}
		const sink = new OwnedForwardListingCapture(this.dependencies, source, {
			buffer,
			admission
		});
		return {
			sink,
			defer: (completion) => {
				this.dependencies.defer(sink.deferred(completion));
			}
		};
	}
}
