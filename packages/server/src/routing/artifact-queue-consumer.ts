import { rootLogger } from '@cupboard/logger';
import { type TenantId } from '@cupboard/nix-store/scalars';
import { type ArtifactTaskClaim } from '@cupboard/protocol/artifact-jobs';

import { type NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { artifactTaskClaimRpcResultSchema } from '../do/artifact-task-rpc.ts';
import { raceClaimOperation } from '../do/claim-lease.ts';
import { boundedSubrequest, withDeadlineBudget } from '../do/deadline.ts';
import { type CupboardServer } from '../do/server.ts';
import { spendSubrequests } from '../do/subrequest-slice.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { withSpan } from '../observability/span.ts';

import {
	type ArtifactQueueMessage,
	artifactQueueMessageSchema
} from './artifact-queue-message.ts';
import {
	ListingTaskWorker,
	type ListingTaskWorkerOptions,
	type ListingTaskWorkerResult
} from './listing-task-worker.ts';

type ArtifactQueueRpc = Pick<
	CupboardServer,
	| 'claimArtifactTask'
	| 'claimAdmittedArtifactTask'
	| 'requestArtifactDispatch'
	| 'prepareListingTaskWithCapacity'
	| 'registerArtifactMultipart'
	| 'sealArtifactStaging'
	| 'renewListingTask'
	| 'completeListingTask'
	| 'retireArtifactStaging'
	| 'finishArtifactTask'
>;
/**
 * Raw storage, a tenant resolver and the queue used for job continuations.
 */
export interface ArtifactQueueDependencies {
	readonly blobs: R2Bucket;
	readonly database: D1Database;
	readonly buffers: NarReadBufferPool;
	readonly queue: Pick<Queue<ArtifactQueueMessage>, 'send'>;
	readonly serverFor: (tenant: TenantId) => ArtifactQueueRpc;
	readonly executeTask?: (
		server: ArtifactQueueRpc,
		claim: ArtifactTaskClaim,
		options: ListingTaskWorkerOptions
	) => Promise<ListingTaskWorkerResult>;
}
type QueueDecision =
	| { readonly action: 'ack' }
	| { readonly action: 'retry'; readonly delaySeconds: number };
const workBudgetMs = 14 * 60 * 1000;
const retryDelaySeconds = 60;
const maximumDelaySeconds = 24 * 60 * 60;

export class ArtifactQueueConsumer {
	private hasProcessed = false;
	private readonly logger = rootLogger().with({ worker: 'artifact-queue' });

	constructor(private readonly dependencies: ArtifactQueueDependencies) {}

	private async rpc<T>(
		operation: () => Promise<T>,
		signal: AbortSignal
	): Promise<T> {
		signal.throwIfAborted();
		spendSubrequests(1, 'artifact.queue');
		return raceClaimOperation(
			boundedSubrequest(operation, 'artifact.queue'),
			signal
		);
	}

	private async continueJob(
		message: ArtifactQueueMessage,
		signal: AbortSignal
	): Promise<QueueDecision> {
		if (message.admission !== undefined) {
			await this.rpc(
				() =>
					this.dependencies
						.serverFor(message.tenant)
						.requestArtifactDispatch(message.job),
				signal
			);
			return { action: 'ack' };
		}
		await this.rpc(() => this.dependencies.queue.send(message), signal);
		return { action: 'ack' };
	}

	private async execute(
		message: ArtifactQueueMessage,
		signal: AbortSignal
	): Promise<QueueDecision> {
		if (message.artifactKind !== 'listing') {
			this.logger.warn('artifact job kind has no queue executor', {
				jobId: message.job.id,
				kind: message.artifactKind
			});
			return { action: 'retry', delaySeconds: retryDelaySeconds };
		}
		const server = this.dependencies.serverFor(message.tenant);
		const owner = crypto.randomUUID();
		const claimed = artifactTaskClaimRpcResultSchema.parse(
			await this.rpc(
				() =>
					message.admission === undefined
						? server.claimArtifactTask(message.job, owner, message.artifactKind)
						: server.claimAdmittedArtifactTask(
								message.admission,
								owner,
								message.artifactKind
							),
				signal
			)
		);
		if (claimed.kind === 'idle') {
			return claimed.pending
				? { action: 'retry', delaySeconds: retryDelaySeconds }
				: { action: 'ack' };
		}
		if (claimed.definition.kind !== message.artifactKind) {
			return { action: 'retry', delaySeconds: retryDelaySeconds };
		}
		if (
			message.admission !== undefined &&
			(claimed.claim.id !== message.admission.taskId ||
				claimed.claim.jobId !== message.job.id ||
				claimed.claim.jobGeneration !== message.job.generation ||
				claimed.claim.cacheGeneration !== message.admission.cacheGeneration)
		) {
			return { action: 'retry', delaySeconds: retryDelaySeconds };
		}
		const options = { signal, budgetMs: workBudgetMs };
		const execution =
			this.dependencies.executeTask === undefined
				? new ListingTaskWorker({
						server,
						blobs: this.dependencies.blobs,
						database: this.dependencies.database,
						buffers: this.dependencies.buffers
					}).run(claimed.claim, options)
				: this.dependencies.executeTask(server, claimed.claim, options);
		const result = await raceClaimOperation(execution, signal);
		if (['completed', 'reused', 'failed'].includes(result.kind)) {
			return this.continueJob(message, signal);
		}
		if (result.kind === 'capacity') {
			const seconds = Math.ceil(
				(Date.parse(result.retryAt) - Date.now()) / 1000
			);
			const delaySeconds = Number.isFinite(seconds)
				? Math.max(retryDelaySeconds, Math.min(maximumDelaySeconds, seconds))
				: retryDelaySeconds;
			return { action: 'retry', delaySeconds };
		}
		return { action: 'retry', delaySeconds: retryDelaySeconds };
	}

	private async run(
		message: ArtifactQueueMessage,
		transport: Pick<Message, 'id' | 'attempts'>
	): Promise<QueueDecision> {
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort(new SubrequestTimeoutError('artifact.queue'));
		}, workBudgetMs);
		try {
			return await withSpan(
				'artifact.queue',
				{
					tenant: message.tenant,
					jobId: message.job.id,
					jobGeneration: message.job.generation,
					messageId: transport.id,
					attempts: transport.attempts,
					kind: message.artifactKind
				},
				() =>
					withDeadlineBudget(
						workBudgetMs,
						() => this.execute(message, controller.signal),
						'artifact.queue'
					)
			);
		} catch (error) {
			this.logger.warn('artifact queue execution failed; retry requested', {
				tenant: message.tenant,
				jobId: message.job.id,
				jobGeneration: message.job.generation,
				messageId: transport.id,
				attempts: transport.attempts,
				error
			});
			return { action: 'retry', delaySeconds: retryDelaySeconds };
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	Processes at most one valid artifact job per consumer invocation.
	*/
	async handleMessage(message: Message): Promise<void> {
		const parsed = artifactQueueMessageSchema.safeParse(message.body);
		if (!parsed.success) {
			this.logger.warn('invalid artifact queue message', {
				messageId: message.id,
				error: parsed.error
			});
			message.ack();
			return;
		}
		if (this.hasProcessed) {
			message.retry({ delaySeconds: retryDelaySeconds });
			return;
		}
		this.hasProcessed = true;
		const decision = await this.run(parsed.data, message);
		if (decision.action === 'ack') {
			message.ack();
			return;
		}
		message.retry({ delaySeconds: decision.delaySeconds });
	}
}
