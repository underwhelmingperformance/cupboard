import { rootLogger } from '@cupboard/logger';
import { InvalidNarListingError } from '@cupboard/nix-store/nar-listing';
import { type ArtifactTaskClaim } from '@cupboard/protocol/artifact-jobs';
import { type NarListingFact } from '@cupboard/protocol/artifacts';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { positiveSafeInteger } from '@cupboard/shared/limits';
import { drizzle } from 'drizzle-orm/d1';

import {
	ArtifactOutputBuffer,
	ArtifactWriterUnavailableError
} from '../blob/artifact-multipart-writer.ts';
import { type ArtifactStageLease } from '../blob/artifact-staging.ts';
import { type ByteBufferPool } from '../blob/byte-buffers.ts';
import { CasObjectStore } from '../blob/cas-object-store.ts';
import { ConnectionLimitedBucket } from '../blob/connection-limited-bucket.ts';
import { StoredNarListingGenerator } from '../blob/nar-listing-generation.ts';
import { type NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { boundedBlobs, boundedD1 } from '../do/bounded-io.ts';
import { maxOutgoingConnections } from '../do/bulk.ts';
import { raceClaimOperation, withRenewedClaim } from '../do/claim-lease.ts';
import { boundedSubrequest, withDeadlineBudget } from '../do/deadline.ts';
import {
	type ListingTaskCompletion,
	type ListingTaskPreparation
} from '../do/listing-task-service.ts';
import { type CupboardServer } from '../do/server.ts';
import { spendSubrequests } from '../do/subrequest-slice.ts';
import {
	SubrequestTimeoutError,
	UploadedObjectNotFoundError
} from '../errors.ts';
import { withSpan } from '../observability/span.ts';

const maximumBudgetMs = 14 * 60 * 1000;
const renewalIntervalMs = 30_000;
const cleanupBudgetMs = 1000;

type ListingTaskRpc = Pick<
	CupboardServer,
	| 'prepareListingTaskWithCapacity'
	| 'registerArtifactMultipart'
	| 'sealArtifactStaging'
	| 'renewListingTask'
	| 'completeListingTask'
	| 'retireArtifactStaging'
	| 'finishArtifactTask'
>;
/**
 * Pass raw storage bindings; the executor applies deadlines and subrequest
 * accounting. Buffers are shared with other tasks in the Worker isolate.
 */
export interface ListingTaskWorkerDependencies {
	readonly server: ListingTaskRpc;
	readonly database: D1Database;
	readonly blobs: R2Bucket;
	readonly buffers: NarReadBufferPool;
	readonly outputBuffers?: ByteBufferPool;
}
export interface ListingTaskWorkerOptions {
	readonly budgetMs?: number;
	readonly signal?: AbortSignal;
}
export type ListingTaskWorkerResult =
	| ListingTaskCompletion
	| { readonly kind: 'reused' | 'local-capacity' }
	| { readonly kind: 'capacity'; readonly retryAt: IsoTimestamp }
	| {
			readonly kind: 'failed';
			readonly reason: 'nar-mismatch' | 'invalid-nar';
	  };

export class ArtifactTaskOwnershipLostError extends Error {
	constructor() {
		super('The artifact task is no longer owned by this Worker');
		this.name = 'ArtifactTaskOwnershipLostError';
	}
}

class StagingUploadAttempt {
	private state: 'reserved' | 'registered' | 'recoverable';
	private upload: R2MultipartUpload | undefined;

	constructor(isRecoverable: boolean) {
		this.state = isRecoverable ? 'recoverable' : 'reserved';
	}
	created(upload: R2MultipartUpload): void {
		this.upload = upload;
	}
	registered(): void {
		this.state = 'registered';
	}
	preserveForRecovery(): void {
		this.state = 'recoverable';
	}
	get canRetire(): boolean {
		return this.state === 'registered';
	}
	get uploadToAbort(): R2MultipartUpload | undefined {
		return this.state === 'recoverable' ? undefined : this.upload;
	}
}

export class ListingTaskWorker {
	private readonly blobs: R2Bucket;
	private readonly source: ConnectionLimitedBucket;
	private readonly objects: CasObjectStore;
	private readonly logger = rootLogger().with({
		component: 'listing-task-worker'
	});

	constructor(private readonly dependencies: ListingTaskWorkerDependencies) {
		this.blobs = boundedBlobs(dependencies.blobs);
		this.source = new ConnectionLimitedBucket(
			this.blobs,
			maxOutgoingConnections
		);
		this.objects = new CasObjectStore(
			drizzle(boundedD1(dependencies.database), { schema: d1Schema }),
			this.blobs
		);
	}

	private async rpc<T>(
		operation: () => Promise<T>,
		signal: AbortSignal
	): Promise<T> {
		signal.throwIfAborted();
		spendSubrequests(1, 'artifact.task.rpc');
		return raceClaimOperation(
			boundedSubrequest(operation, 'artifact.task.rpc'),
			signal
		);
	}

	private async renew(
		lease: ArtifactStageLease,
		signal: AbortSignal
	): Promise<void> {
		const deadline = await this.rpc(
			() => this.dependencies.server.renewListingTask(lease),
			signal
		);
		if (deadline === undefined) {
			throw new ArtifactTaskOwnershipLostError();
		}
	}

	private async promote(
		lease: ArtifactStageLease,
		fact: NarListingFact,
		signal: AbortSignal
	): Promise<void> {
		await this.renew(lease, signal);
		await raceClaimOperation(
			this.objects.promote(
				{
					digest: fact.digest,
					size: fact.size,
					open: async () => {
						await this.renew(lease, signal);
						const object = await this.source.get(lease.key);
						if (object === null) {
							throw new UploadedObjectNotFoundError(lease.key);
						}
						return object.body;
					}
				},
				{ restoreMissingObject: true }
			),
			signal
		);
	}

	private async produce(
		prepared: Extract<ListingTaskPreparation, { kind: 'generate' | 'promote' }>,
		signal: AbortSignal,
		outputBuffer?: ArtifactOutputBuffer
	): Promise<ListingTaskWorkerResult> {
		const lease = prepared.lease;
		const attempt = new StagingUploadAttempt(prepared.kind === 'promote');
		try {
			return await withRenewedClaim(
				() => this.renew(lease, signal),
				async (workSignal) => {
					let fact: NarListingFact;
					if (prepared.kind === 'promote') {
						fact = prepared.fact;
					} else {
						if (outputBuffer === undefined) {
							throw new ArtifactWriterUnavailableError(
								'generation was prepared without an output buffer'
							);
						}
						const currentUpload = await raceClaimOperation(
							this.blobs.createMultipartUpload(lease.key),
							workSignal
						);
						attempt.created(currentUpload);
						const isRegistered = await this.rpc(
							() =>
								this.dependencies.server.registerArtifactMultipart(
									lease,
									currentUpload.uploadId
								),
							workSignal
						);
						if (!isRegistered) {
							throw new ArtifactTaskOwnershipLostError();
						}
						attempt.registered();
						const generated = await new StoredNarListingGenerator({
							objects: this.source,
							source: prepared.source.key,
							expected: prepared.source.expected,
							upload: currentUpload,
							buffers: this.dependencies.buffers,
							outputBuffer,
							generatorRevision: prepared.generatorRevision,
							maximumOutputBytes: lease.maximumBytes,
							signal: workSignal,
							assertCurrent: () => this.renew(lease, workSignal)
						}).run();
						if (generated.kind === 'mismatch') {
							const isFinished = await this.rpc(
								() =>
									this.dependencies.server.finishArtifactTask(
										lease.claim,
										'failed'
									),
								workSignal
							);
							return isFinished
								? { kind: 'failed', reason: 'nar-mismatch' }
								: { kind: 'unavailable' };
						}
						fact = generated.fact;
						// A seal can commit before its reply is lost.
						attempt.preserveForRecovery();
						const isSealed = await this.rpc(
							() =>
								this.dependencies.server.sealArtifactStaging(
									lease,
									currentUpload.uploadId,
									{ digest: fact.digest, size: fact.size }
								),
							workSignal
						);
						if (!isSealed) {
							throw new ArtifactTaskOwnershipLostError();
						}
					}
					await this.promote(lease, fact, workSignal);
					return this.rpc(
						() => this.dependencies.server.completeListingTask(lease, fact),
						workSignal
					);
				},
				{ renewalIntervalMs, signal }
			);
		} catch (error) {
			if (!(error instanceof InvalidNarListingError)) {
				throw error;
			}
			this.logger.warn('listing generation rejected the NAR', {
				jobId: lease.claim.jobId,
				taskId: lease.claim.id,
				error
			});
			const isFinished = await this.rpc(
				() =>
					this.dependencies.server.finishArtifactTask(lease.claim, 'failed'),
				signal
			);
			return isFinished
				? { kind: 'failed', reason: 'invalid-nar' }
				: { kind: 'unavailable' };
		} finally {
			const pending: Promise<unknown>[] = [];
			if (attempt.canRetire) {
				pending.push(
					this.rpc(
						() => this.dependencies.server.retireArtifactStaging(lease),
						signal
					)
				);
			}
			const currentUpload = attempt.uploadToAbort;
			if (currentUpload !== undefined) {
				pending.push(
					boundedSubrequest(
						() => currentUpload.abort(),
						'artifact.abort',
						cleanupBudgetMs
					)
				);
			}
			await Promise.allSettled(pending);
		}
	}

	private async execute(
		claim: ArtifactTaskClaim,
		signal: AbortSignal
	): Promise<ListingTaskWorkerResult> {
		signal.throwIfAborted();
		const outputBuffer = ArtifactOutputBuffer.tryAcquire(
			this.dependencies.outputBuffers
		);
		try {
			const prepared = await this.rpc(
				() =>
					this.dependencies.server.prepareListingTaskWithCapacity(
						claim,
						outputBuffer !== undefined
					),
				signal
			);
			if (prepared.kind !== 'generate') {
				outputBuffer?.release();
			}
			if (prepared.kind !== 'generate' && prepared.kind !== 'promote') {
				return prepared;
			}
			return await this.produce(prepared, signal, outputBuffer);
		} finally {
			outputBuffer?.release();
		}
	}

	/**
	 * Executes one claimed listing outside the Durable Object. The tenant RPCs
	 * decide whether the measured output may become a cache publication.
	 */
	async run(
		claim: ArtifactTaskClaim,
		options: ListingTaskWorkerOptions = {}
	): Promise<ListingTaskWorkerResult> {
		const budgetMs = positiveSafeInteger(
			options.budgetMs ?? maximumBudgetMs,
			'Artifact task time budget'
		);
		if (budgetMs > maximumBudgetMs) {
			throw new RangeError('The artifact task time budget exceeds 14 minutes');
		}
		const controller = new AbortController();
		const signal =
			options.signal === undefined
				? controller.signal
				: AbortSignal.any([controller.signal, options.signal]);
		const timer = setTimeout(() => {
			controller.abort(new SubrequestTimeoutError('artifact.task'));
		}, budgetMs);
		try {
			return await withSpan(
				'artifact.listing',
				{
					jobId: claim.jobId,
					taskId: claim.id,
					jobGeneration: claim.jobGeneration,
					taskGeneration: claim.generation
				},
				() =>
					withDeadlineBudget(
						budgetMs,
						() => this.execute(claim, signal),
						'artifact.task'
					)
			);
		} finally {
			clearTimeout(timer);
		}
	}
}
