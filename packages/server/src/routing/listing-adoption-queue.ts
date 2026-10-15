import { rootLogger } from '@cupboard/logger';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { drizzle } from 'drizzle-orm/d1';

import { type ListingAdoptionSeedScope } from '../blob/listing-adoption-seed-dispatch.ts';
import * as schema from '../db/d1-schema.ts';
import { ListingAdoptionFactSeedStore } from '../db/listing-adoption-fact-seed.ts';
import { ListingAdoptionParentSeedStore } from '../db/listing-adoption-parent-seed.ts';
import { ListingAdoptionSeedDispatchStore } from '../db/listing-adoption-seed-dispatch.ts';
import { boundedD1 } from '../do/bounded-io.ts';
import { boundedSubrequest, withDeadlineBudget } from '../do/deadline.ts';
import { hasSubrequestsFor, spendSubrequests } from '../do/subrequest-slice.ts';
import { withSpan } from '../observability/span.ts';

import {
	type ListingAdoptionQueueMessage,
	listingAdoptionQueueMessageSchema
} from './listing-adoption-queue-message.ts';

/**
Pass raw bindings so seed processing applies its own deadlines and I/O accounting.
*/
export interface ListingAdoptionQueueDependencies {
	readonly database: D1Database;
	readonly queue: Pick<
		Queue<ListingAdoptionQueueMessage>,
		'send' | 'sendBatch'
	>;
}
const budgetMs = 25_000;
const dispatchSubrequests = 4;
const seedSubrequests = 18;
const retryDelaySeconds = 60;

export class ListingAdoptionQueue {
	private readonly dispatch: ListingAdoptionSeedDispatchStore;
	private readonly facts: ListingAdoptionFactSeedStore;
	private readonly parents: ListingAdoptionParentSeedStore;
	private readonly invocationDeadline = Date.now() + budgetMs;
	private readonly logger = rootLogger().with({ worker: 'listing-adoption' });

	constructor(private readonly dependencies: ListingAdoptionQueueDependencies) {
		const database = drizzle(boundedD1(dependencies.database), { schema });
		this.dispatch = new ListingAdoptionSeedDispatchStore(database);
		this.facts = new ListingAdoptionFactSeedStore(database);
		this.parents = new ListingAdoptionParentSeedStore(database);
	}

	private send<T>(operation: () => Promise<T>): Promise<T> {
		spendSubrequests(1, 'artifact.listing.adoption.queue');
		return boundedSubrequest(operation, 'artifact.listing.adoption.queue');
	}

	private async sweep(): Promise<void> {
		const scopes = await this.dispatch.reserve();
		if (scopes.length === 0) {
			return;
		}
		await this.send(() =>
			this.dependencies.queue.sendBatch(
				scopes.map((scope) => ({
					body: { kind: 'listing-adoption-seed', scope }
				}))
			)
		);
	}

	private async seed(scope: ListingAdoptionSeedScope): Promise<void> {
		const owner = artifactTaskOwnerSchema.parse(crypto.randomUUID());
		const result = await this.dispatch.claim(scope, owner);
		if (result.kind !== 'claimed') {
			return;
		}
		const claim = result.claim;
		await withSpan(
			'artifact.listing.adoption.seed',
			{ scope, generation: claim.generation },
			async (span) => {
				const progress =
					claim.scope === 'facts'
						? await this.facts.advance(claim)
						: await this.parents.advance(claim);
				span.setAttribute('outcome', progress.kind);
				if (progress.kind === 'advanced') {
					span.setAttribute('scanned', progress.scanned);
					span.setAttribute('captured', progress.captured);
					span.setAttribute('complete', progress.isComplete);
				}
				if (!(await this.dispatch.finish(claim))) {
					return;
				}
				await this.send(() =>
					this.dependencies.queue.send({ kind: 'listing-adoption-dispatch' })
				);
			}
		);
	}

	async start(): Promise<void> {
		const remainingMs = this.invocationDeadline - Date.now();
		if (remainingMs <= 0 || !hasSubrequestsFor(dispatchSubrequests)) {
			return;
		}
		await withSpan('artifact.listing.adoption.dispatch', {}, () =>
			withDeadlineBudget(
				remainingMs,
				() => this.sweep(),
				'artifact.listing.adoption.dispatch'
			)
		);
	}

	async handleMessage(message: Message): Promise<void> {
		const parsed = listingAdoptionQueueMessageSchema.safeParse(message.body);
		if (!parsed.success) {
			this.logger.warn('invalid listing adoption message', {
				messageId: message.id,
				error: parsed.error
			});
			message.ack();
			return;
		}
		const work = parsed.data;
		const subrequests =
			work.kind === 'listing-adoption-seed'
				? seedSubrequests
				: dispatchSubrequests;
		const remainingMs = this.invocationDeadline - Date.now();
		if (remainingMs <= 0 || !hasSubrequestsFor(subrequests)) {
			message.retry({ delaySeconds: retryDelaySeconds });
			return;
		}
		const attributes = {
			messageId: message.id,
			attempts: message.attempts,
			kind: work.kind,
			scope: work.kind === 'listing-adoption-seed' ? work.scope : undefined
		};
		try {
			await withSpan('artifact.listing.adoption.queue', attributes, () =>
				withDeadlineBudget(
					remainingMs,
					() =>
						work.kind === 'listing-adoption-seed'
							? this.seed(work.scope)
							: this.sweep(),
					'artifact.listing.adoption.queue'
				)
			);
		} catch (error) {
			this.logger.warn('listing adoption message failed; retry requested', {
				...attributes,
				error
			});
			message.retry({ delaySeconds: retryDelaySeconds });
			return;
		}
		message.ack();
	}
}
