import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { z } from 'zod';

import * as schema from '../db/schema.ts';

import {
	cachePurgeBackoffCapMs,
	CachePurgeRetryPolicy,
	isRateLimitedPurgeFailure
} from './cache-purge-retry.ts';
import { type SchemaDatabase } from './context.ts';

/**
The Durable Object storage key of the shared rate-limit wait. Its absence
means that no purge is waiting for the rate limit. The key is outside every
queue prefix.
*/
export const cachePurgeRateLimitKey = 'cache-purge:rate-limit';

const rateLimitSchema = z.strictObject({
	notBefore: z.number(),
	refusals: z.number().int().positive()
});

/**
The retry state that one queued purge row keeps for failures other than the
rate limit.
*/
export interface CachePurgeRowRetry {
	readonly nextAttemptAt: IsoTimestamp | null;
	readonly failedAttempts: number;
}

/**
Decides when the tenant object may send each cache-tag purge.

Cloudflare's purge rate limit applies to the whole account. A rate-limit
refusal therefore sets one time for every purge that the object sends, from
the mutation queue and from the signing-key backfill alike, and a success on
either path clears it. Any other failure delays only the row that failed.
*/
export class CachePurgeBackoff {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly database: SchemaDatabase,
		private readonly policy: CachePurgeRetryPolicy = new CachePurgeRetryPolicy()
	) {}

	private async rateLimit(): Promise<
		z.infer<typeof rateLimitSchema> | undefined
	> {
		const stored = await this.storage.get(cachePurgeRateLimitKey);

		return stored === undefined ? undefined : rateLimitSchema.parse(stored);
	}

	/**
	Returns the earliest time at which the purge of a row with `row`'s retry
	state may be sent: `now` or later.
	*/
	async dueAt(row: CachePurgeRowRetry, now: number): Promise<number> {
		const rateLimit = await this.rateLimit();

		return Math.max(
			now,
			row.nextAttemptAt === null ? now : Date.parse(row.nextAttemptAt),
			rateLimit?.notBefore ?? now
		);
	}

	/**
	Records a purge that failed with `error` at `failedAt`, and returns the
	retry state to store on the row. A rate-limit refusal extends the shared
	wait and leaves the row's state unchanged. It continues the previous run
	of refusals only when the previous wait ended at most
	{@link cachePurgeBackoffCapMs} earlier.
	*/
	async recordFailure(
		error: unknown,
		row: CachePurgeRowRetry,
		failedAt: number
	): Promise<CachePurgeRowRetry> {
		if (!isRateLimitedPurgeFailure(error)) {
			const failedAttempts = row.failedAttempts + 1;

			return {
				nextAttemptAt: isoTimestamp(
					new Date(this.policy.nextAttemptAt(error, failedAttempts, failedAt))
				),
				failedAttempts
			};
		}

		const previous = await this.rateLimit();
		const isSameRun =
			previous !== undefined &&
			failedAt - previous.notBefore <= cachePurgeBackoffCapMs;
		const refusals = (isSameRun ? previous.refusals : 0) + 1;

		await this.storage.put(cachePurgeRateLimitKey, {
			notBefore: this.policy.nextAttemptAt(error, refusals, failedAt),
			refusals
		});

		return {
			nextAttemptAt: row.nextAttemptAt,
			failedAttempts: row.failedAttempts
		};
	}

	/**
	Clears the shared wait after a purge succeeds.
	*/
	async recordSuccess(): Promise<void> {
		if ((await this.rateLimit()) === undefined) {
			return;
		}

		await this.storage.delete(cachePurgeRateLimitKey);
	}

	/**
	Removes the shared wait when no purge of either kind remains queued. A
	purge queued later starts a new run of refusals.
	*/
	async forgetWhenIdle(): Promise<void> {
		if ((await this.rateLimit()) === undefined) {
			return;
		}

		const queued = this.database
			.select({ id: schema.cachePurgeContinuations.id })
			.from(schema.cachePurgeContinuations)
			.limit(1)
			.get();

		if (queued !== undefined) {
			return;
		}

		await this.storage.delete(cachePurgeRateLimitKey);
	}
}
