import { rootLogger } from '@cupboard/logger';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { hasReachedTransitionState } from '@cupboard/protocol/deployment';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { eq } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';

import { ListingStageCollector } from '../blob/listing-stage-collector.ts';
import { SharedListingStagingService } from '../blob/shared-listing-staging-service.ts';
import * as schema from '../db/d1-schema.ts';
import { recordedTransitions } from '../db/deployment-transitions.ts';
import { ForwardListingStageStore } from '../db/forward-listing-staging.ts';
import { SharedListingOutputCleanupStore } from '../db/shared-listing-output-cleanup.ts';
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
	{
		readonly kind: 'shared-listing-stage-sweep' | 'forward-listing-stage-sweep';
	}
>;
type OutputSweep = Extract<
	SharedListingCleanupMessage,
	{ readonly kind: 'shared-listing-output-sweep' }
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
	private readonly forward: ForwardListingStageStore;
	private readonly forwardCleanup: ListingStageCollector;
	private readonly outputs: SharedListingOutputCleanupStore;
	private readonly queue: SharedListingCleanupDependencies['queue'];
	private readonly logger = rootLogger().with({
		worker: 'shared-listing-cleanup'
	});
	private readonly invocationDeadline = Date.now() + cleanupBudgetMs;

	constructor(dependencies: SharedListingCleanupDependencies) {
		this.database = drizzle(boundedD1(dependencies.database), { schema });
		this.store = new SharedListingStageStore(this.database);
		this.forward = new ForwardListingStageStore(this.database);
		this.forwardCleanup = new ListingStageCollector({
			store: this.forward,
			blobs: dependencies.blobs,
			scope: 'forward'
		});
		this.outputs = new SharedListingOutputCleanupStore(this.database);
		this.staging = new SharedListingStagingService({
			database: dependencies.database,
			blobs: dependencies.blobs
		});
		this.queue = dependencies.queue;
	}

	private async ready(
		transition:
			| 'shared-listing-staging'
			| 'shared-listing-output-retirement'
			| 'forward-listing-staging'
	): Promise<boolean> {
		const row = await this.database
			.select({
				id: schema.deploymentTransition.id,
				state: schema.deploymentTransition.state
			})
			.from(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, transition))
			.get();
		const state = recordedTransitions(row === undefined ? [] : [row]).get(
			transition
		);
		return hasReachedTransitionState(state, 'expanded');
	}

	private send<T>(operation: () => Promise<T>): Promise<T> {
		spendSubrequests(1, 'artifact.shared.cleanup.queue');
		return boundedSubrequest(operation, 'artifact.shared.cleanup.queue');
	}

	private async sweep(message: Sweep): Promise<void> {
		const isForward = message.kind === 'forward-listing-stage-sweep';
		const transition = isForward
			? 'forward-listing-staging'
			: 'shared-listing-staging';
		if (!(await this.ready(transition))) {
			return;
		}
		const store = isForward ? this.forward : this.store;
		const cleanupKind = isForward
			? 'forward-listing-stage-cleanup'
			: 'shared-listing-stage-cleanup';
		const scope = isForward ? 'forward' : 'shared';
		await withSpan(
			`artifact.stage.${scope}.dispatch`,
			{ through: message.through, after: message.after?.id },
			async () => {
				const page = await store.due(message.through, message.after);
				if (page.stages.length === 0) {
					return;
				}
				await this.send(() =>
					this.queue.sendBatch(
						page.stages.map((id) => ({
							body: { kind: cleanupKind, id }
						}))
					)
				);
				if (page.next !== undefined) {
					await this.send(() =>
						this.queue.send({
							kind: message.kind,
							through: message.through,
							after: page.next
						})
					);
				}
			}
		);
	}

	private async sweepOutputs(input?: OutputSweep): Promise<void> {
		if (!(await this.ready('shared-listing-output-retirement'))) {
			return;
		}
		const message: OutputSweep = input ?? {
			kind: 'shared-listing-output-sweep',
			through: await this.outputs.cutoff()
		};
		await withSpan(
			'artifact.output.shared.dispatch',
			{ through: message.through, after: message.after?.narHash },
			async () => {
				const page = await this.outputs.due(message.through, message.after);
				if (page.parents.length === 0) {
					return;
				}
				await this.send(() =>
					this.queue.sendBatch(
						page.parents.map((narHash) => ({
							body: { kind: 'shared-listing-output-cleanup', narHash }
						}))
					)
				);
				if (page.next !== undefined) {
					await this.send(() =>
						this.queue.send({
							kind: 'shared-listing-output-sweep',
							through: message.through,
							after: page.next
						})
					);
				}
			}
		);
	}

	private deferred(retryAt: IsoTimestamp): Decision {
		const seconds = Math.ceil((Date.parse(retryAt) - Date.now()) / 1000);
		return {
			action: 'retry',
			delaySeconds: Math.max(1, Math.min(maximumDelaySeconds, seconds))
		};
	}

	private async retireOutputs(
		message: Extract<
			SharedListingCleanupMessage,
			{ readonly kind: 'shared-listing-output-cleanup' }
		>
	): Promise<Decision> {
		if (!(await this.ready('shared-listing-output-retirement'))) {
			return { action: 'ack' };
		}
		const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
		const result = await this.outputs.claim(
			message.narHash,
			owner,
			isoTimestamp(new Date())
		);
		if (result.kind === 'deferred') {
			return this.deferred(result.retryAt);
		}
		if (result.kind === 'absent') {
			return { action: 'ack' };
		}
		const drained = await withSpan(
			'artifact.output.shared.retire',
			{
				narHash: message.narHash,
				scopeEpoch: result.claim.epoch,
				after: result.claim.cursor
			},
			() => this.outputs.drain(result.claim, isoTimestamp(new Date()))
		);
		if (drained.kind === 'drained' && drained.hasMore) {
			await this.send(() => this.queue.send(message));
		}
		return { action: 'ack' };
	}

	private async execute(
		message: SharedListingCleanupMessage
	): Promise<Decision> {
		switch (message.kind) {
			case 'forward-listing-stage-sweep':
			case 'shared-listing-stage-sweep': {
				await this.sweep(message);
				return { action: 'ack' };
			}
			case 'shared-listing-output-sweep': {
				await this.sweepOutputs(message);
				return { action: 'ack' };
			}
			case 'shared-listing-output-cleanup': {
				return this.retireOutputs(message);
			}
			case 'forward-listing-stage-cleanup':
			case 'shared-listing-stage-cleanup': {
				const isForward = message.kind === 'forward-listing-stage-cleanup';
				const transition = isForward
					? 'forward-listing-staging'
					: 'shared-listing-staging';
				if (!(await this.ready(transition))) {
					return { action: 'ack' };
				}
				const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
				const collector = isForward ? this.forwardCleanup : this.staging;
				const result = await collector.collect(message.id, owner);
				return result.kind === 'deferred'
					? this.deferred(result.retryAt)
					: { action: 'ack' };
			}
		}
	}

	async start(): Promise<void> {
		const stageSweep: Sweep = {
			kind: 'shared-listing-stage-sweep',
			through: isoTimestamp(new Date())
		};
		await withDeadlineBudget(
			cleanupBudgetMs,
			async () => {
				const results = await Promise.allSettled([
					this.sweep(stageSweep),
					this.sweep({
						kind: 'forward-listing-stage-sweep',
						through: stageSweep.through
					}),
					this.sweepOutputs()
				]);
				const errors: unknown[] = [];
				for (const result of results) {
					if (result.status === 'rejected') {
						errors.push(result.reason);
					}
				}
				if (errors.length === 1) {
					throw errors[0];
				}
				if (errors.length > 1) {
					throw new AggregateError(errors, 'shared cleanup dispatch failed');
				}
			},
			'artifact.shared.cleanup.dispatch'
		);
	}

	async handleMessage(message: Message): Promise<void> {
		const parsed = sharedListingCleanupMessageSchema.safeParse(message.body);
		if (!parsed.success) {
			this.logger.warn('invalid shared cleanup message', {
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
				'artifact.shared.cleanup.queue',
				{
					messageId: message.id,
					attempts: message.attempts,
					kind: parsed.data.kind
				},
				() =>
					withDeadlineBudget(
						remainingMs,
						() => this.execute(parsed.data),
						'artifact.shared.cleanup.queue'
					)
			);
		} catch (error) {
			this.logger.warn('shared cleanup message failed; retry requested', {
				messageId: message.id,
				attempts: message.attempts,
				error
			});
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
