import { rootLogger } from '@cupboard/logger';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { hasReachedTransitionState } from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { eq } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';

import { SharedListingStagingService } from '../blob/shared-listing-staging-service.ts';
import * as schema from '../db/d1-schema.ts';
import { recordedTransitions } from '../db/deployment-transitions.ts';
import { SharedListingStageStore } from '../db/shared-listing-staging.ts';
import { boundedD1 } from '../do/bounded-io.ts';
import { boundedSubrequest, withDeadlineBudget } from '../do/deadline.ts';
import { hasSubrequestsFor, spendSubrequests } from '../do/subrequest-slice.ts';
import { withSpan } from '../observability/span.ts';

import {
	type SharedListingCleanupMessage,
	sharedListingCleanupMessageSchema
} from './shared-listing-cleanup-message.ts';

/**
Pass raw bindings; the queue applies deadlines and subrequest accounting.
*/
export interface SharedListingCleanupDependencies {
	readonly database: D1Database;
	readonly blobs: R2Bucket;
	readonly queue: Pick<
		Queue<SharedListingCleanupMessage>,
		'send' | 'sendBatch'
	>;
}
type Sweep = Extract<
	SharedListingCleanupMessage,
	{ readonly kind: 'shared-listing-stage-sweep' }
>;
type Decision =
	| { readonly action: 'ack' }
	| { readonly action: 'retry'; readonly delaySeconds: number };
const cleanupBudgetMs = 25_000;
const cleanupSubrequests = 8;
const retryDelaySeconds = 60;
const maximumDelaySeconds = 24 * 60 * 60;

export class SharedListingCleanupQueue {
	private readonly database: DrizzleD1Database<typeof schema>;
	private readonly store: SharedListingStageStore;
	private readonly staging: SharedListingStagingService;
	private readonly queue: SharedListingCleanupDependencies['queue'];
	private readonly logger = rootLogger().with({
		worker: 'shared-listing-cleanup'
	});
	private readonly invocationDeadline = Date.now() + cleanupBudgetMs;

	constructor(dependencies: SharedListingCleanupDependencies) {
		this.database = drizzle(boundedD1(dependencies.database), { schema });
		this.store = new SharedListingStageStore(this.database);
		this.staging = new SharedListingStagingService({
			database: dependencies.database,
			blobs: dependencies.blobs
		});
		this.queue = dependencies.queue;
	}

	private async ready(): Promise<boolean> {
		const row = await this.database
			.select({
				id: schema.deploymentTransition.id,
				state: schema.deploymentTransition.state
			})
			.from(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'shared-listing-staging'))
			.get();
		const state = recordedTransitions(row === undefined ? [] : [row]).get(
			'shared-listing-staging'
		);
		return hasReachedTransitionState(state, 'expanded');
	}

	private send<T>(operation: () => Promise<T>): Promise<T> {
		spendSubrequests(1, 'artifact.stage.shared.queue');
		return boundedSubrequest(operation, 'artifact.stage.shared.queue');
	}

	private async sweep(message: Sweep): Promise<void> {
		if (!(await this.ready())) {
			return;
		}
		await withSpan(
			'artifact.stage.shared.dispatch',
			{ through: message.through, after: message.after?.id },
			async () => {
				const page = await this.store.due(message.through, message.after);
				if (page.stages.length === 0) {
					return;
				}
				await this.send(() =>
					this.queue.sendBatch(
						page.stages.map((id) => ({
							body: { kind: 'shared-listing-stage-cleanup', id }
						}))
					)
				);
				if (page.next !== undefined) {
					await this.send(() =>
						this.queue.send({
							kind: 'shared-listing-stage-sweep',
							through: message.through,
							after: page.next
						})
					);
				}
			}
		);
	}

	private async execute(
		message: SharedListingCleanupMessage
	): Promise<Decision> {
		if (message.kind === 'shared-listing-stage-sweep') {
			await this.sweep(message);
			return { action: 'ack' };
		}
		if (!(await this.ready())) {
			return { action: 'ack' };
		}
		const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
		const result = await this.staging.collect(message.id, owner);
		if (result.kind === 'deferred') {
			const secondsUntilRetry = Math.ceil(
				(Date.parse(result.retryAt) - Date.now()) / 1000
			);
			return {
				action: 'retry',
				delaySeconds: Math.max(
					1,
					Math.min(maximumDelaySeconds, secondsUntilRetry)
				)
			};
		}
		return { action: 'ack' };
	}

	async start(): Promise<void> {
		await withDeadlineBudget(
			cleanupBudgetMs,
			() =>
				this.sweep({
					kind: 'shared-listing-stage-sweep',
					through: isoTimestamp(new Date())
				}),
			'artifact.stage.shared.dispatch'
		);
	}

	async handleMessage(message: Message): Promise<void> {
		const parsed = sharedListingCleanupMessageSchema.safeParse(message.body);
		if (!parsed.success) {
			this.logger.warn('invalid shared staging cleanup message', {
				messageId: message.id,
				error: parsed.error
			});
			message.ack();
			return;
		}
		const remainingMs = this.invocationDeadline - Date.now();
		if (remainingMs <= 0 || !hasSubrequestsFor(cleanupSubrequests)) {
			message.retry({ delaySeconds: retryDelaySeconds });
			return;
		}
		let decision: Decision;
		try {
			decision = await withSpan(
				'artifact.stage.shared.queue',
				{
					messageId: message.id,
					attempts: message.attempts,
					kind: parsed.data.kind
				},
				() =>
					withDeadlineBudget(
						remainingMs,
						() => this.execute(parsed.data),
						'artifact.stage.shared.queue'
					)
			);
		} catch (error) {
			this.logger.warn(
				'shared staging cleanup message failed; retry requested',
				{ messageId: message.id, attempts: message.attempts, error }
			);
			message.retry({ delaySeconds: retryDelaySeconds });
			return;
		}
		if (decision.action === 'ack') {
			message.ack();
			return;
		}
		message.retry({ delaySeconds: decision.delaySeconds });
	}
}
