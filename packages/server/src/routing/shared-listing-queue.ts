import { rootLogger } from '@cupboard/logger';
import {
	type ArtifactJobVersion,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { hasReachedTransitionState } from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { eq } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';

import { type NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import * as schema from '../db/d1-schema.ts';
import { recordedTransitions } from '../db/deployment-transitions.ts';
import { SharedListingDispatchStore } from '../db/shared-listing-dispatch.ts';
import { SharedListingDispatchSeedStore } from '../db/shared-listing-dispatch-seed.ts';
import { SharedListingJobStore } from '../db/shared-listing-jobs.ts';
import { SharedListingTaskDeliveryStore } from '../db/shared-listing-task-deliveries.ts';
import { boundedD1 } from '../do/bounded-io.ts';
import {
	boundedSubrequest,
	currentDeadlineSignal,
	withDeadlineBudget
} from '../do/deadline.ts';
import { hasSubrequestsFor, spendSubrequests } from '../do/subrequest-slice.ts';
import { withSpan } from '../observability/span.ts';

import {
	type SharedListingQueueMessage,
	sharedListingQueueMessageSchema
} from './shared-listing-queue-message.ts';
import { SharedListingTaskWorker } from './shared-listing-task-worker.ts';
/**
Pass raw bindings; each processor applies its own I/O limits.
*/
export interface SharedListingQueueDependencies {
	readonly database: D1Database;
	readonly blobs: R2Bucket;
	readonly buffers: NarReadBufferPool;
	readonly queue: Pick<Queue<SharedListingQueueMessage>, 'send' | 'sendBatch'>;
}
const metadataBudgetMs = 25_000;
const taskBudgetMs = 14 * 60 * 1000;
const retryDelaySeconds = 60;
const metadataSubrequests = 18;
const taskSubrequests = 8;

export class SharedListingQueue {
	private readonly database: DrizzleD1Database<typeof schema>;
	private readonly dispatch: SharedListingDispatchStore;
	private readonly seed: SharedListingDispatchSeedStore;
	private readonly jobs: SharedListingJobStore;
	private readonly deliveries: SharedListingTaskDeliveryStore;
	private readonly executor: SharedListingTaskWorker;
	private readonly invocationDeadline = Date.now() + taskBudgetMs;
	private readonly logger = rootLogger().with({
		worker: 'shared-listing-queue'
	});
	constructor(private readonly dependencies: SharedListingQueueDependencies) {
		this.database = drizzle(boundedD1(dependencies.database), { schema });
		this.dispatch = new SharedListingDispatchStore(this.database);
		this.seed = new SharedListingDispatchSeedStore(this.database);
		this.jobs = new SharedListingJobStore(this.database);
		this.deliveries = new SharedListingTaskDeliveryStore(this.database);
		this.executor = new SharedListingTaskWorker(dependencies);
	}
	private async ready(): Promise<boolean> {
		const row = await this.database
			.select({
				id: schema.deploymentTransition.id,
				state: schema.deploymentTransition.state
			})
			.from(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'shared-listing-dispatch-seed'))
			.get();
		const state = recordedTransitions(row === undefined ? [] : [row]).get(
			'shared-listing-dispatch-seed'
		);
		return hasReachedTransitionState(state, 'expanded');
	}
	private send<T>(operation: () => Promise<T>): Promise<T> {
		spendSubrequests(1, 'artifact.listing.shared.queue');
		return boundedSubrequest(operation, 'artifact.listing.shared.queue');
	}
	private wake(): Promise<unknown> {
		return this.send(() =>
			this.dependencies.queue.send({ kind: 'shared-listing-dispatch' })
		);
	}
	private async sweep(): Promise<void> {
		const now = isoTimestamp(new Date());
		const results = await Promise.allSettled([
			this.seed.advance(now),
			this.dispatch.reserve(now)
		]);
		const errors: unknown[] = [];
		const [seed, dispatch] = results;
		for (const result of results) {
			if (result.status === 'rejected') {
				errors.push(result.reason);
			}
		}
		if (dispatch.status === 'fulfilled' && dispatch.value.length > 0) {
			await this.send(() =>
				this.dependencies.queue.sendBatch(
					dispatch.value.map((job) => ({
						body: { kind: 'shared-listing-job', job }
					}))
				)
			);
		}
		const isSeeding =
			seed.status === 'fulfilled' &&
			(seed.value.kind === 'stale' ||
				(seed.value.kind === 'advanced' && !seed.value.isComplete));
		if (isSeeding || (await this.dispatch.hasDue(isoTimestamp(new Date())))) {
			await this.wake();
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, 'global listing dispatch failed');
		}
	}
	private async discover(job: ArtifactJobVersion): Promise<void> {
		const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
		const result = await this.jobs.claim(job, owner, isoTimestamp(new Date()));
		if (result.kind === 'claimed') {
			await this.jobs.discover(result.claim);
		}
	}
	private async deliver(job: ArtifactJobVersion): Promise<void> {
		const hints = await this.deliveries.reserve(job, isoTimestamp(new Date()));
		if (hints.length === 0) {
			return;
		}
		await this.send(() =>
			this.dependencies.queue.sendBatch(
				hints.map((hint) => ({
					body: { kind: 'shared-listing-task', ...hint }
				}))
			)
		);
	}
	private async runJob(job: ArtifactJobVersion): Promise<void> {
		const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
		const result = await this.dispatch.claim(
			job,
			owner,
			isoTimestamp(new Date())
		);
		if (result.kind !== 'claimed') {
			return;
		}
		const now = isoTimestamp(new Date());
		const results = await Promise.allSettled([
			this.dispatch.seed(result.claim, now),
			this.discover(job),
			this.deliver(job)
		]);
		const errors: unknown[] = [];
		for (const settled of results) {
			if (settled.status === 'rejected') {
				errors.push(settled.reason);
			}
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, 'global listing job dispatch failed');
		}
		currentDeadlineSignal()?.throwIfAborted();
		await this.dispatch.finish(result.claim, isoTimestamp(new Date()));
		await this.wake();
	}
	private async execute(
		message: SharedListingQueueMessage,
		remainingMs: number
	): Promise<void> {
		if (!(await this.ready())) {
			return;
		}
		switch (message.kind) {
			case 'shared-listing-dispatch': {
				await this.sweep();
				return;
			}
			case 'shared-listing-job': {
				await this.runJob(message.job);
				return;
			}
			case 'shared-listing-task': {
				const request = { job: message.job, id: message.id };
				const options = {
					budgetMs: remainingMs,
					signal: currentDeadlineSignal()
				};
				await this.executor.run(request, options);
				await this.wake();
			}
		}
	}
	async start(): Promise<void> {
		await withDeadlineBudget(
			metadataBudgetMs,
			async () => {
				if (await this.ready()) {
					await this.sweep();
				}
			},
			'artifact.listing.shared.dispatch'
		);
	}
	async handleMessage(message: Message): Promise<void> {
		const parsed = sharedListingQueueMessageSchema.safeParse(message.body);
		if (!parsed.success) {
			this.logger.warn('invalid global listing message', {
				messageId: message.id,
				error: parsed.error
			});
			message.ack();
			return;
		}
		const isTask = parsed.data.kind === 'shared-listing-task';
		const remainingMs = Math.min(
			isTask ? taskBudgetMs : metadataBudgetMs,
			this.invocationDeadline - Date.now()
		);
		if (
			remainingMs <= 0 ||
			!hasSubrequestsFor(isTask ? taskSubrequests : metadataSubrequests)
		) {
			message.retry({ delaySeconds: retryDelaySeconds });
			return;
		}
		const work = parsed.data;
		const attributes = {
			messageId: message.id,
			attempts: message.attempts,
			kind: work.kind,
			jobId: 'job' in work ? work.job.id : undefined,
			jobGeneration: 'job' in work ? work.job.generation : undefined,
			taskId: work.kind === 'shared-listing-task' ? work.id : undefined
		};
		try {
			await withSpan('artifact.listing.shared.queue', attributes, () =>
				withDeadlineBudget(
					remainingMs,
					() => this.execute(parsed.data, remainingMs),
					'artifact.listing.shared.queue'
				)
			);
		} catch (error) {
			this.logger.warn('global listing message failed; retry requested', {
				...attributes,
				error
			});
			message.retry({ delaySeconds: retryDelaySeconds });
			return;
		}
		message.ack();
	}
}
