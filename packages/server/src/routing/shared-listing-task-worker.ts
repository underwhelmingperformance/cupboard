import { rootLogger } from '@cupboard/logger';
import {
	InvalidNarListingError,
	NarListingLimitError
} from '@cupboard/nix-store/nar-listing';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	type NarListingFact,
	narListingFactSchema
} from '@cupboard/protocol/artifacts';
import { hasReachedTransitionState } from '@cupboard/protocol/deployment';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { positiveSafeInteger } from '@cupboard/shared/limits';
import { and, eq } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';

import { ArtifactOutputBuffer } from '../blob/artifact-multipart-writer.ts';
import { type ByteBufferPool } from '../blob/byte-buffers.ts';
import { CasObjectStore } from '../blob/cas-object-store.ts';
import { ConnectionLimitedBucket } from '../blob/connection-limited-bucket.ts';
import { StoredNarListingGenerator } from '../blob/nar-listing-generation.ts';
import { type NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import {
	type SharedListingCompletionOutput,
	type SharedListingCompletionResult,
	type SharedListingTaskFailure
} from '../blob/shared-listing-completion.ts';
import { type SharedListingGenerationClaim } from '../blob/shared-listing-generation.ts';
import {
	SharedListingStageConflictError,
	type SharedListingStageLease
} from '../blob/shared-listing-staging.ts';
import { SharedListingStagingService } from '../blob/shared-listing-staging-service.ts';
import {
	type SharedListingTaskClaim,
	type SharedListingTaskRequest,
	sharedListingTaskRequestSchema
} from '../blob/shared-listing-tasks.ts';
import * as schema from '../db/d1-schema.ts';
import { recordedTransitions } from '../db/deployment-transitions.ts';
import { ForwardListingStageStore } from '../db/forward-listing-staging.ts';
import {
	ListingFactStore,
	type StoredNarListingFact
} from '../db/listing-facts.ts';
import { SharedListingCompletionStore } from '../db/shared-listing-completion.ts';
import { SharedListingGenerationStore } from '../db/shared-listing-generation.ts';
import { SharedListingStageStore } from '../db/shared-listing-staging.ts';
import { SharedListingTaskStore } from '../db/shared-listing-tasks.ts';
import { boundedBlobs, boundedD1 } from '../do/bounded-io.ts';
import { maxOutgoingConnections } from '../do/bulk.ts';
import { raceClaimOperation, withRenewedClaim } from '../do/claim-lease.ts';
import { currentDeadlineSignal, withDeadlineBudget } from '../do/deadline.ts';
import {
	ListingFactConflictError,
	UploadedObjectNotFoundError,
	UploadedObjectSizeMismatchError
} from '../errors.ts';
import { casObjectKey, narObjectKey } from '../http/http.ts';
import { withSpan } from '../observability/span.ts';

const maximumBudgetMs = 14 * 60 * 1000;
const renewalIntervalMs = 30_000;
const retryDelayMs = 60_000;
const logger = rootLogger().with({ component: 'shared-listing-task-worker' });

export interface SharedListingTaskWorkerDependencies {
	readonly database: D1Database;
	readonly blobs: R2Bucket;
	readonly buffers: NarReadBufferPool;
	readonly outputBuffers?: ByteBufferPool;
}
export interface SharedListingTaskWorkerOptions {
	readonly budgetMs?: number;
	readonly signal?: AbortSignal;
}
type DeferredReason =
	'generation-busy' | 'local-capacity' | 'staging-busy' | 'storage';
export type SharedListingTaskWorkerResult =
	| SharedListingCompletionResult
	| { readonly kind: 'busy'; readonly retryAt: IsoTimestamp }
	| {
			readonly kind: 'deferred';
			readonly retryAt: IsoTimestamp;
			readonly reason: DeferredReason;
	  };
type WorkResult =
	| { readonly kind: 'output'; readonly output: SharedListingCompletionOutput }
	| { readonly kind: 'finish'; readonly failure: SharedListingTaskFailure }
	| {
			readonly kind: 'defer';
			readonly reason: DeferredReason;
			readonly retryAt: IsoTimestamp;
	  };

class SharedListingOwnershipLostError extends Error {
	constructor() {
		super('The global listing task is no longer owned by this Worker');
		this.name = 'SharedListingOwnershipLostError';
	}
}
interface ExecutionStores {
	readonly tasks: SharedListingTaskStore;
	readonly generation: SharedListingGenerationStore;
	readonly stages: SharedListingStageStore;
}
class ExecutionLease {
	computation: SharedListingGenerationClaim | undefined;
	stage: SharedListingStageLease | undefined;
	preserveStage = false;
	constructor(
		readonly task: SharedListingTaskClaim,
		private readonly stores: ExecutionStores
	) {}
	async renew(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const now = isoTimestamp(new Date());
		if ((await this.stores.tasks.renew(this.task, now)) === undefined) {
			throw new SharedListingOwnershipLostError();
		}
		if (
			this.computation !== undefined &&
			(await this.stores.generation.renew(
				this.computation,
				isoTimestamp(new Date())
			)) === undefined
		) {
			throw new SharedListingOwnershipLostError();
		}
		if (
			this.stage !== undefined &&
			(await this.stores.stages.renew(this.stage, isoTimestamp(new Date()))) ===
				undefined
		) {
			throw new SharedListingOwnershipLostError();
		}
		signal.throwIfAborted();
	}
}

/**
Pass raw bindings; the executor applies deadlines and subrequest accounting.
*/
export class SharedListingTaskWorker {
	private readonly database: DrizzleD1Database<typeof schema>;
	private readonly tasks: SharedListingTaskStore;
	private readonly generation: SharedListingGenerationStore;
	private readonly stages: SharedListingStageStore;
	private readonly forwardStages: ForwardListingStageStore;
	private readonly completion: SharedListingCompletionStore;
	private readonly facts: ListingFactStore;
	private readonly staging: SharedListingStagingService;
	private readonly blobs: R2Bucket;
	private readonly source: ConnectionLimitedBucket;
	private readonly objects: CasObjectStore;

	constructor(
		private readonly dependencies: SharedListingTaskWorkerDependencies
	) {
		this.database = drizzle(boundedD1(dependencies.database), { schema });
		this.tasks = new SharedListingTaskStore(this.database);
		this.generation = new SharedListingGenerationStore(this.database);
		this.stages = new SharedListingStageStore(this.database);
		this.forwardStages = new ForwardListingStageStore(this.database);
		this.completion = new SharedListingCompletionStore(this.database);
		this.facts = new ListingFactStore(this.database);
		this.staging = new SharedListingStagingService(dependencies);
		this.blobs = boundedBlobs(dependencies.blobs);
		this.source = new ConnectionLimitedBucket(
			this.blobs,
			maxOutgoingConnections
		);
		this.objects = new CasObjectStore(this.database, this.blobs);
	}

	private async ready(): Promise<boolean> {
		const row = await this.database
			.select({
				id: schema.deploymentTransition.id,
				state: schema.deploymentTransition.state
			})
			.from(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'shared-listing-completion'))
			.get();
		return hasReachedTransitionState(
			recordedTransitions(row === undefined ? [] : [row]).get(
				'shared-listing-completion'
			),
			'expanded'
		);
	}

	private retryAt(): IsoTimestamp {
		return isoTimestamp(new Date(Date.now() + retryDelayMs));
	}

	private async stored(
		task: SharedListingTaskClaim,
		signal: AbortSignal
	): Promise<StoredNarListingFact | undefined> {
		const [stored] = await this.facts.findStored([task]);
		if (stored === undefined) {
			return;
		}
		const head = await raceClaimOperation(
			this.blobs.head(casObjectKey(stored.fact.digest, stored.incarnation)),
			signal
		);
		signal.throwIfAborted();
		return head?.size === stored.fact.size ? stored : undefined;
	}

	private async retained(fact: NarListingFact): Promise<boolean> {
		const identity = and(
			eq(schema.sharedListingOutputReference.narHash, fact.narHash),
			eq(
				schema.sharedListingOutputReference.generatorRevision,
				fact.generatorRevision
			)
		);
		const row = await this.database
			.select({ narHash: schema.sharedListingOutputReference.narHash })
			.from(schema.sharedListingOutputReference)
			.where(identity)
			.get();
		return row !== undefined;
	}

	private async promote(
		execution: ExecutionLease,
		fact: NarListingFact,
		signal: AbortSignal
	): Promise<SharedListingCompletionOutput> {
		const lease = execution.stage;
		if (lease === undefined) {
			throw new SharedListingOwnershipLostError();
		}
		await execution.renew(signal);
		const incarnation = await raceClaimOperation(
			this.objects.promote(
				{
					digest: fact.digest,
					size: fact.size,
					open: async () => {
						await execution.renew(signal);
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
		const key = casObjectKey(fact.digest, incarnation);
		const head = await raceClaimOperation(this.blobs.head(key), signal);
		if (head === null) {
			throw new UploadedObjectNotFoundError(key);
		}
		if (head.size !== fact.size) {
			throw new UploadedObjectSizeMismatchError(key, fact.size, head.size);
		}
		await execution.renew(signal);
		return { kind: 'generated', fact, incarnation, stageId: lease.id };
	}

	private async generate(
		execution: ExecutionLease,
		outputBuffer: ArtifactOutputBuffer,
		signal: AbortSignal
	): Promise<WorkResult> {
		const claim = execution.computation;
		if (claim === undefined) {
			throw new SharedListingOwnershipLostError();
		}
		const task = execution.task;
		const current = this.generation.source(task, isoTimestamp(new Date()));
		const metadata = await this.database
			.select()
			.from(schema.blobState)
			.where(and(eq(schema.blobState.narHash, task.narHash), current))
			.get();
		if (metadata === undefined) {
			return {
				kind: 'finish',
				failure: { kind: 'skipped', reason: 'source-unavailable' }
			};
		}

		const key = narObjectKey(task.narHash, task.sourceIncarnation);
		const head = await raceClaimOperation(this.blobs.head(key), signal);
		if (head?.size !== task.fileSize) {
			return {
				kind: 'finish',
				failure: {
					kind: 'skipped',
					reason: head === null ? 'source-unavailable' : 'source-mismatch'
				}
			};
		}
		const reserved = await this.stages.reserve(claim, isoTimestamp(new Date()));
		if (reserved.kind === 'unavailable') {
			return { kind: 'defer', reason: 'staging-busy', retryAt: this.retryAt() };
		}
		execution.stage = reserved.lease;
		if (reserved.kind === 'ready') {
			execution.preserveStage = true;
			outputBuffer.release();
			const fact = narListingFactSchema.parse({
				narHash: task.narHash,
				generatorRevision: task.generatorRevision,
				format: 1,
				...reserved.measurement
			});
			return {
				kind: 'output',
				output: await this.promote(execution, fact, signal)
			};
		}
		await execution.renew(signal);
		const upload = await raceClaimOperation(
			this.staging.create(reserved.lease),
			signal
		);
		if (upload === undefined) {
			throw new SharedListingOwnershipLostError();
		}
		const generated = await new StoredNarListingGenerator({
			objects: this.source,
			source: key,
			expected: { narHash: task.narHash, narSize: task.narSize },
			upload,
			buffers: this.dependencies.buffers,
			outputBuffer,
			generatorRevision: task.generatorRevision,
			maximumOutputBytes: reserved.lease.maximumBytes,
			signal,
			assertCurrent: () => execution.renew(signal)
		}).run();
		if (generated.kind === 'mismatch') {
			return {
				kind: 'finish',
				failure: { kind: 'failed', reason: 'source-mismatch' }
			};
		}
		execution.preserveStage = true;
		if (
			!(await raceClaimOperation(
				this.staging.seal(reserved.lease, upload.uploadId, {
					digest: generated.fact.digest,
					size: generated.fact.size
				}),
				signal
			))
		) {
			throw new SharedListingOwnershipLostError();
		}
		return {
			kind: 'output',
			output: await this.promote(execution, generated.fact, signal)
		};
	}

	private async work(
		execution: ExecutionLease,
		signal: AbortSignal,
		outputBuffer?: ArtifactOutputBuffer
	): Promise<WorkResult> {
		const task = execution.task;
		const stored = await this.stored(task, signal);
		if (stored !== undefined && (await this.retained(stored.fact))) {
			outputBuffer?.release();
			return { kind: 'output', output: { kind: 'reused', ...stored } };
		}
		const generation = await this.generation.claim(
			task,
			isoTimestamp(new Date())
		);
		if (generation.kind === 'busy') {
			return {
				kind: 'defer',
				reason: 'generation-busy',
				retryAt: generation.retryAt
			};
		}
		if (generation.kind === 'unavailable') {
			return {
				kind: 'finish',
				failure: { kind: 'skipped', reason: 'source-unavailable' }
			};
		}
		execution.computation = generation.claim;
		const afterClaim = await this.stored(task, signal);
		if (afterClaim !== undefined) {
			outputBuffer?.release();
			return { kind: 'output', output: { kind: 'reused', ...afterClaim } };
		}
		const isSupported =
			task.generatorRevision === currentListingGeneratorRevision;
		const knownFact = isSupported ? undefined : await this.facts.find(task);
		if (!isSupported && knownFact === undefined) {
			return {
				kind: 'finish',
				failure: { kind: 'skipped', reason: 'unsupported-generator-revision' }
			};
		}
		const saved = await this.stages.recover(
			generation.claim,
			isoTimestamp(new Date())
		);
		const recovered =
			saved.kind === 'ready'
				? saved
				: await this.forwardStages.adopt(
						generation.claim,
						isoTimestamp(new Date())
					);
		if (recovered.kind === 'ready') {
			execution.stage = recovered.lease;
			execution.preserveStage = true;
			outputBuffer?.release();
			const fact =
				knownFact ??
				narListingFactSchema.parse({
					narHash: task.narHash,
					generatorRevision: task.generatorRevision,
					format: 1,
					...recovered.measurement
				});
			if (
				fact.digest !== recovered.measurement.digest ||
				fact.size !== recovered.measurement.size
			) {
				throw new ListingFactConflictError();
			}
			return {
				kind: 'output',
				output: await this.promote(execution, fact, signal)
			};
		}
		if (!isSupported) {
			return {
				kind: 'finish',
				failure: { kind: 'skipped', reason: 'unsupported-generator-revision' }
			};
		}
		if (outputBuffer === undefined) {
			return {
				kind: 'defer',
				reason: 'local-capacity',
				retryAt: this.retryAt()
			};
		}
		return this.generate(execution, outputBuffer, signal);
	}

	private async checkpoint(
		execution: ExecutionLease,
		result: WorkResult
	): Promise<SharedListingTaskWorkerResult> {
		const now = isoTimestamp(new Date());
		if (result.kind === 'finish') {
			return this.completion.finish(execution.task, result.failure, now);
		}
		if (result.kind === 'defer') {
			const at = await this.tasks.defer(execution.task, result.retryAt, now);
			return at === undefined
				? { kind: 'unavailable' }
				: { kind: 'deferred', reason: result.reason, retryAt: at };
		}
		if (execution.computation !== undefined) {
			return this.completion.complete(
				execution.computation,
				result.output,
				now
			);
		}
		return this.completion.reuse(execution.task, result.output, now);
	}

	private async consume(
		task: SharedListingTaskClaim,
		signal: AbortSignal
	): Promise<SharedListingTaskWorkerResult> {
		const execution = new ExecutionLease(task, {
			tasks: this.tasks,
			generation: this.generation,
			stages: this.stages
		});
		const outputBuffer = ArtifactOutputBuffer.tryAcquire(
			this.dependencies.outputBuffers
		);
		try {
			const result = await withRenewedClaim(
				() => execution.renew(signal),
				(workSignal) => this.work(execution, workSignal, outputBuffer),
				{ renewalIntervalMs, signal }
			);
			signal.throwIfAborted();
			return await this.checkpoint(execution, result);
		} catch (error) {
			if (error instanceof SharedListingOwnershipLostError) {
				return { kind: 'unavailable' };
			}
			if (signal.aborted) {
				throw error;
			}
			logger.warn('global listing execution failed', {
				jobId: task.job.id,
				taskId: task.id,
				error
			});
			if (error instanceof NarListingLimitError) {
				return await this.completion.finish(
					execution.task,
					{ kind: 'skipped', reason: 'resource-limit' },
					isoTimestamp(new Date())
				);
			}
			if (
				error instanceof InvalidNarListingError ||
				error instanceof ListingFactConflictError ||
				error instanceof SharedListingStageConflictError
			) {
				return await this.completion.finish(
					execution.task,
					{ kind: 'failed', reason: 'generation-failed' },
					isoTimestamp(new Date())
				);
			}
			return await this.checkpoint(execution, {
				kind: 'defer',
				reason: 'storage',
				retryAt: this.retryAt()
			});
		} finally {
			outputBuffer?.release();
			const cleanupAt = isoTimestamp(new Date());
			if (execution.stage !== undefined && !execution.preserveStage) {
				await Promise.allSettled([
					this.stages.retire(execution.stage, cleanupAt)
				]);
			}
			if (execution.computation !== undefined) {
				await Promise.allSettled([
					this.generation.release(execution.computation, cleanupAt)
				]);
			}
		}
	}

	private async execute(
		request: SharedListingTaskRequest,
		signal: AbortSignal
	): Promise<SharedListingTaskWorkerResult> {
		signal.throwIfAborted();
		if (!(await this.ready())) {
			return { kind: 'unavailable' };
		}
		const claimed = await this.tasks.claim(request, isoTimestamp(new Date()));
		if (claimed.kind !== 'claimed') {
			return claimed;
		}
		const task = claimed.claim;
		return withSpan(
			'artifact.listing.shared.execute',
			{
				jobId: task.job.id,
				taskId: task.id,
				jobGeneration: task.job.generation,
				taskGeneration: task.generation,
				narHash: task.narHash,
				generatorRevision: task.generatorRevision
			},
			async (span) => {
				const result = await this.consume(task, signal);
				span.setAttribute('completion', result.kind);
				if ('outcome' in result) {
					span.setAttribute('outcome', result.outcome.kind);
					if ('reason' in result.outcome) {
						span.setAttribute('reason', result.outcome.reason);
					}
				}
				if ('reason' in result) {
					span.setAttribute('reason', result.reason);
				}
				return result;
			}
		);
	}

	/**
	Executes global work without creating a tenant cache publication.
	*/
	async run(
		input: Omit<SharedListingTaskRequest, 'owner'>,
		options: SharedListingTaskWorkerOptions = {}
	): Promise<SharedListingTaskWorkerResult> {
		const budgetMs = positiveSafeInteger(
			options.budgetMs ?? maximumBudgetMs,
			'Global listing task time budget'
		);
		if (budgetMs > maximumBudgetMs) {
			throw new RangeError(
				'The global listing task time budget exceeds 14 minutes'
			);
		}
		const request = sharedListingTaskRequestSchema.parse({
			job: input.job,
			id: input.id,
			owner: artifactTaskOwnerSchema.parse(crypto.randomUUID())
		});
		return withSpan(
			'artifact.listing.shared',
			{
				jobId: request.job.id,
				taskId: request.id,
				jobGeneration: request.job.generation
			},
			() =>
				withDeadlineBudget(
					budgetMs,
					() => {
						const signals = [currentDeadlineSignal(), options.signal].filter(
							(signal): signal is AbortSignal => signal !== undefined
						);
						const signal = AbortSignal.any(signals);
						return raceClaimOperation(this.execute(request, signal), signal);
					},
					'artifact.listing.shared'
				)
		);
	}
}
