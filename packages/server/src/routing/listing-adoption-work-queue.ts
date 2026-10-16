import { rootLogger } from '@cupboard/logger';
import { type TenantId } from '@cupboard/nix-store/scalars';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { drizzle } from 'drizzle-orm/d1';

import { type ListingAdoptionCaptureSequence } from '../blob/listing-adoption-capture.ts';
import {
	type ListingAdoptionDelivery,
	type ListingAdoptionDeliveryResolution,
	type ListingAdoptionTaskId
} from '../blob/listing-adoption-tasks.ts';
import {
	listingAdoptionOutcomesSchema,
	type NarListingAdoptionRequest
} from '../blob/nar-listing-adoption.ts';
import * as schema from '../db/d1-schema.ts';
import { ListingAdoptionConsumerStore } from '../db/listing-adoption-consumer.ts';
import { ListingAdoptionRecoveryStore } from '../db/listing-adoption-recovery.ts';
import { ListingAdoptionTaskStore } from '../db/listing-adoption-tasks.ts';
import { boundedD1 } from '../do/bounded-io.ts';
import {
	boundedSubrequest,
	currentDeadlineSignal,
	withDeadlineBudget
} from '../do/deadline.ts';
import { type CupboardServer } from '../do/server.ts';
import {
	hasSubrequestsFor,
	spendSubrequests,
	withHeldSubrequests
} from '../do/subrequest-slice.ts';
import { withSpan } from '../observability/span.ts';

import {
	type ListingAdoptionWorkMessage,
	listingAdoptionWorkMessageSchema
} from './listing-adoption-work-message.ts';

export interface ListingAdoptionWorkDependencies {
	readonly database: D1Database;
	readonly wakeHistorical: () => Promise<unknown>;
	readonly queue: Pick<Queue<ListingAdoptionWorkMessage>, 'send' | 'sendBatch'>;
	readonly serverFor: (
		tenant: TenantId
	) => Pick<CupboardServer, 'adoptNarListings'>;
}
const budgetMs = 25_000;
const dispatchSubrequests = 26;
const expansionSubrequests = 28;
const deliveryBaseSubrequests = 8;
const deliveryTargetSubrequests = 4;
const retryDelaySeconds = 60;
interface TenantDeliveries {
	readonly tenant: TenantId;
	readonly deliveries: readonly ListingAdoptionDelivery[];
}
interface TenantResolution {
	readonly resolutions: readonly ListingAdoptionDeliveryResolution[];
	readonly error?: unknown;
}

export class ListingAdoptionWorkQueue {
	private readonly tasks: ListingAdoptionTaskStore;
	private readonly captures: ListingAdoptionConsumerStore;
	private readonly recovery: ListingAdoptionRecoveryStore;
	private readonly invocationDeadline = Date.now() + budgetMs;
	private readonly logger = rootLogger().with({
		worker: 'listing-adoption-work'
	});
	constructor(private readonly dependencies: ListingAdoptionWorkDependencies) {
		const database = drizzle(boundedD1(dependencies.database), { schema });
		this.tasks = new ListingAdoptionTaskStore(database);
		this.captures = new ListingAdoptionConsumerStore(database);
		this.recovery = new ListingAdoptionRecoveryStore(database);
	}
	private io<T>(operation: () => Promise<T>): Promise<T> {
		spendSubrequests(1, 'artifact.listing.adoption.work');
		return boundedSubrequest(operation, 'artifact.listing.adoption.work');
	}
	private wake(): Promise<unknown> {
		return this.io(() =>
			this.dependencies.queue.send({ kind: 'listing-adoption-work-dispatch' })
		);
	}
	private async recover(
		prunedThrough: ListingAdoptionCaptureSequence
	): Promise<boolean> {
		return withSpan(
			'artifact.listing.adoption.recovery',
			{ prunedThrough },
			async (span) => {
				const progress = await this.recovery.recover();
				span.setAttribute('outcome', progress.kind);
				if (progress.kind === 'unavailable') {
					return false;
				}
				if (progress.kind === 'stale') {
					return true;
				}
				if (progress.kind === 'recovered') {
					span.setAttribute('after', progress.after);
					span.setAttribute('epoch', progress.epoch);
					this.logger.warn(
						'listing adoption recovery reset the historical seeds',
						{
							after: progress.after,
							epoch: progress.epoch,
							prunedThrough
						}
					);
				}
				await this.io(() => this.dependencies.wakeHistorical());
				return true;
			}
		);
	}
	private async capture(): Promise<boolean> {
		return withSpan('artifact.listing.adoption.capture', {}, async (span) => {
			const progress = await this.captures.advance();
			span.setAttribute('outcome', progress.kind);
			if (progress.kind === 'expired') {
				return this.recover(progress.prunedThrough);
			}
			if (progress.kind !== 'advanced' && progress.kind !== 'idle') {
				return false;
			}
			if (progress.kind === 'advanced') {
				span.setAttribute('scanned', progress.scanned);
				span.setAttribute('enrolled', progress.enrolled);
			}
			const retention = await this.captures.prune();
			span.setAttribute('retention.outcome', retention.kind);
			if (retention.kind === 'pruned') {
				span.setAttribute('retention.removed', retention.removed);
				span.setAttribute('retention.through', retention.through);
			}
			return (
				(progress.kind === 'advanced' && progress.hasMore) ||
				(retention.kind === 'pruned' && retention.hasMore)
			);
		});
	}
	private async seed(): Promise<boolean> {
		return withSpan(
			'artifact.listing.adoption.execution.seed',
			{},
			async (span) => {
				const progress = await this.tasks.seed();
				span.setAttribute('outcome', progress.kind);
				if (progress.kind !== 'advanced') {
					return false;
				}
				span.setAttribute('scanned', progress.scanned);
				span.setAttribute('complete', progress.isComplete);
				return !progress.isComplete;
			}
		);
	}
	private async sweep(): Promise<void> {
		const results = await Promise.allSettled([this.capture(), this.seed()]);
		const errors: unknown[] = [];
		let hasMore = false;
		for (const result of results) {
			if (result.status === 'rejected') {
				errors.push(result.reason);
				continue;
			}
			hasMore ||= result.value;
		}
		const reserved = await this.tasks.reserveWork();
		const messages: ListingAdoptionWorkMessage[] = [];
		const deliveries: ListingAdoptionTaskId[] = [];
		for (const item of reserved) {
			if (item.kind === 'deliver') {
				deliveries.push(item.id);
				continue;
			}
			messages.push({ kind: 'listing-adoption-expand', id: item.id });
		}
		if (deliveries.length > 0) {
			messages.push({ kind: 'listing-adoption-deliver', ids: deliveries });
		}
		if (messages.length > 0) {
			await this.io(() =>
				this.dependencies.queue.sendBatch(messages.map((body) => ({ body })))
			);
		}
		if (hasMore || reserved.length === 8) {
			await this.wake();
		}
		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				'Listing adoption input enrolment failed'
			);
		}
	}
	private async expand(id: ListingAdoptionTaskId): Promise<void> {
		const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
		const result = await this.tasks.claim(id, owner, 'expand');
		if (result.kind !== 'claimed') {
			if (result.kind === 'idle') {
				await this.wake();
			}
			return;
		}
		await withSpan(
			'artifact.listing.adoption.expand',
			{ taskId: id, generation: result.claim.generation },
			async (span) => {
				const progress = await this.tasks.advance(result.claim);
				span.setAttribute('outcome', progress.kind);
				switch (progress.kind) {
					case 'advanced': {
						span.setAttribute('scanned', progress.scanned);
						span.setAttribute('enrolled', progress.enrolled);
						span.setAttribute('complete', progress.isComplete);
						break;
					}
					case 'unavailable': {
						await this.tasks.defer(result.claim, retryDelaySeconds);
						await this.io(() =>
							this.dependencies.queue.send(
								{ kind: 'listing-adoption-expand', id },
								{ delaySeconds: retryDelaySeconds }
							)
						);
						break;
					}
					case 'stale':
					case 'complete': {
						break;
					}
				}
				await this.wake();
			}
		);
	}
	private request(
		delivery: ListingAdoptionDelivery
	): NarListingAdoptionRequest {
		const { parent, identity } = delivery.target;
		return {
			identity,
			cache: parent.cache,
			cacheGeneration: parent.cacheGeneration,
			storePathHash: parent.storePathHash,
			generation: parent.generation
		};
	}
	private groups(
		deliveries: readonly ListingAdoptionDelivery[]
	): readonly TenantDeliveries[] {
		const retries: TenantDeliveries[] = [];
		const tenants = new Map<TenantId, ListingAdoptionDelivery[]>();
		for (const delivery of deliveries) {
			const tenant = delivery.target.parent.tenant;
			if (delivery.previousOutcome?.kind === 'rpc-failed') {
				retries.push({ tenant, deliveries: [delivery] });
				continue;
			}
			const group = tenants.get(tenant);
			if (group === undefined) {
				tenants.set(tenant, [delivery]);
				continue;
			}
			group.push(delivery);
		}
		return [
			...retries,
			...Array.from(tenants, ([tenant, group]) => ({
				tenant,
				deliveries: group
			}))
		];
	}
	private deferred(
		deliveries: readonly ListingAdoptionDelivery[]
	): readonly ListingAdoptionDeliveryResolution[] {
		return deliveries.map(({ claim }) => ({
			kind: 'deferred',
			claim,
			outcome: { kind: 'rpc-failed' },
			delaySeconds: retryDelaySeconds
		}));
	}
	private async tenant(group: TenantDeliveries): Promise<TenantResolution> {
		const { tenant, deliveries } = group;
		return withSpan(
			'artifact.listing.adoption.deliver',
			{ tenant, count: deliveries.length },
			async (span) => {
				try {
					currentDeadlineSignal()?.throwIfAborted();
					const requests = deliveries.map((delivery) => this.request(delivery));
					const outcomes = listingAdoptionOutcomesSchema.parse(
						await this.io(() =>
							this.dependencies.serverFor(tenant).adoptNarListings(requests)
						)
					);
					if (outcomes.length !== deliveries.length) {
						throw new Error(
							'The listing adoption RPC must return one outcome for each captured request'
						);
					}
					const resolutions = outcomes.map(
						(outcome, index): ListingAdoptionDeliveryResolution => {
							const delivery = deliveries[index];
							if (delivery === undefined) {
								throw new Error(
									'The listing adoption RPC returned an unexpected outcome'
								);
							}
							const { claim } = delivery;
							switch (outcome.kind) {
								case 'published':
								case 'already-present':
								case 'conflict': {
									return { kind: 'finished', claim, outcome };
								}
								default: {
									return {
										kind: 'deferred',
										outcome,
										claim,
										delaySeconds:
											outcome.kind === 'capacity' ? 1 : retryDelaySeconds
									};
								}
							}
						}
					);
					span.setAttribute('outcome', 'resolved');
					return { resolutions };
				} catch (error) {
					span.setAttribute('outcome', 'retry');
					return { resolutions: this.deferred(deliveries), error };
				}
			}
		);
	}
	private async settle(
		resolutions: readonly ListingAdoptionDeliveryResolution[]
	): Promise<void> {
		if (resolutions.length === 0) {
			return;
		}
		await this.tasks.resolveDeliveries(resolutions);
		const retries = new Map<number, ListingAdoptionTaskId[]>();
		let hasFinished = false;
		for (const resolution of resolutions) {
			if (resolution.kind === 'finished') {
				hasFinished = true;
				continue;
			}
			const group = retries.get(resolution.delaySeconds);
			if (group === undefined) {
				retries.set(resolution.delaySeconds, [resolution.claim.id]);
				continue;
			}
			group.push(resolution.claim.id);
		}
		const sends: Promise<unknown>[] = [];
		if (hasFinished) {
			sends.push(this.wake());
		}
		for (const [delaySeconds, ids] of retries) {
			sends.push(
				this.io(() =>
					this.dependencies.queue.send(
						{ kind: 'listing-adoption-deliver', ids },
						{ delaySeconds }
					)
				)
			);
		}
		await Promise.all(sends);
	}
	private async settleTenant(group: TenantDeliveries): Promise<void> {
		const result = await this.tenant(group);
		await this.settle(result.resolutions);
		if (result.error !== undefined) {
			throw new Error('Listing adoption RPC failed', { cause: result.error });
		}
	}
	private async deliver(ids: readonly ListingAdoptionTaskId[]): Promise<void> {
		const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
		const claimed = await this.tasks.claimDeliveries(ids, owner);
		if (claimed.kind !== 'claimed') {
			return;
		}
		if (claimed.claims.length === 0) {
			await this.wake();
			return;
		}
		const prepared = await this.tasks.prepareDeliveries(claimed.claims);
		if (prepared.kind === 'unavailable') {
			await this.settle(
				claimed.claims.map((claim) => ({
					kind: 'deferred',
					claim,
					outcome: { kind: 'unavailable' },
					delaySeconds: retryDelaySeconds
				}))
			);
			return;
		}

		const groups = this.groups(prepared.deliveries);
		const obsolete: ListingAdoptionDeliveryResolution[] = prepared.obsolete.map(
			(claim) => ({ kind: 'finished', claim, outcome: { kind: 'obsolete' } })
		);
		const results = await Promise.allSettled([
			...groups.map((group) => this.settleTenant(group)),
			this.settle(obsolete)
		]);
		const errors: unknown[] = [];
		for (const result of results) {
			if (result.status === 'rejected') {
				errors.push(result.reason);
			}
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, 'Listing adoption delivery failed');
		}
	}
	private execute(work: ListingAdoptionWorkMessage): Promise<void> {
		switch (work.kind) {
			case 'listing-adoption-work-dispatch': {
				return this.sweep();
			}
			case 'listing-adoption-expand': {
				return this.expand(work.id);
			}
			case 'listing-adoption-deliver': {
				return this.deliver(work.ids);
			}
		}
	}
	async start(): Promise<void> {
		const remaining = this.invocationDeadline - Date.now();
		if (remaining <= 0 || !hasSubrequestsFor(2)) {
			return;
		}
		await withSpan('artifact.listing.adoption.work.wake', {}, () =>
			withDeadlineBudget(
				remaining,
				() =>
					withHeldSubrequests(2, async () => {
						if (await this.tasks.isInstalled()) {
							await this.wake();
						}
					}),
				'artifact.listing.adoption.work.wake'
			)
		);
	}
	async handleMessage(message: Message): Promise<void> {
		const parsed = listingAdoptionWorkMessageSchema.safeParse(message.body);
		if (!parsed.success) {
			this.logger.warn('invalid listing adoption work hint', {
				messageId: message.id,
				error: parsed.error
			});
			message.ack();
			return;
		}
		const work = parsed.data;
		const subrequests =
			work.kind === 'listing-adoption-expand'
				? expansionSubrequests
				: work.kind === 'listing-adoption-deliver'
					? deliveryBaseSubrequests +
						deliveryTargetSubrequests * work.ids.length
					: dispatchSubrequests;
		const remaining = this.invocationDeadline - Date.now();
		if (remaining <= 0 || !hasSubrequestsFor(subrequests)) {
			message.retry({ delaySeconds: retryDelaySeconds });
			return;
		}
		const attributes = {
			messageId: message.id,
			attempts: message.attempts,
			kind: work.kind
		};
		try {
			await withSpan('artifact.listing.adoption.work.queue', attributes, () =>
				withDeadlineBudget(
					remaining,
					() => withHeldSubrequests(subrequests, () => this.execute(work)),
					'artifact.listing.adoption.work.queue'
				)
			);
		} catch (error) {
			this.logger.warn('listing adoption work failed; retry requested', {
				...attributes,
				error
			});
			message.retry({ delaySeconds: retryDelaySeconds });
			return;
		}
		message.ack();
	}
}
