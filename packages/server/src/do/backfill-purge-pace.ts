import { and, eq, lte } from 'drizzle-orm';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';

import type { ServerContext } from './context.ts';

/**
The Durable Object storage key of the earliest time at which this object
expects its next claim to succeed. The key is outside every queue prefix.
*/
const backfillPurgePaceKey = 'cache-purge:backfill-pace';

const knownPaceSchema = z.strictObject({ nextAt: z.number() });

const paceRowId = 'backfill';

/**
The default time between two backfill purge requests in one deployment. The
account's purge bucket refills one token every 12 seconds, and twice that time
leaves half of the refill to other purges. The limit covers one deployment.
Each deployment in the account has its own pace, so several deployments add up.
*/
export const defaultBackfillPurgeIntervalMs = 24_000;

/**
The result of {@link BackfillPurgePace.claim}. A `waiting` result includes the
time at which the next claim can succeed.
*/
export type BackfillPurgeClaim =
	| { readonly kind: 'claimed' }
	| { readonly kind: 'waiting'; readonly nextAt: number };

/**
Spaces the signing-key backfill's purge requests across one deployment.

Cloudflare's purge rate limit applies to the whole account, and a tenant's
Durable Object cannot see the purges of other tenants. Both Workers bind
`CUPBOARD_DB`, so every tenant object can read and write its `backfill_purge_pace`
row. The row's `next_at` is the earliest time of the next backfill purge
request. A request claims the row with one conditional write that moves
`next_at` forward by the interval, so the claims of all tenants in the
deployment are at least one interval apart. Several deployments in one account
each have their own row and do not see each other's claims.

Only backfill purges use the row. The purge queue never reads or writes it, so
explicit deletions and read revocations keep their priority and their share of
the bucket.
*/
export class BackfillPurgePace {
	constructor(
		private readonly context: ServerContext,
		private readonly intervalMs: number = defaultBackfillPurgeIntervalMs
	) {}

	private async remember(nextAt: number): Promise<void> {
		await this.context.ctx.storage.put(backfillPurgePaceKey, { nextAt });
	}

	/**
	Returns the time at which this object last learned that the next claim can
	succeed, from its own claim or from a refused claim. Returns `undefined`
	before the first claim. Another tenant can have claimed since then, so a
	later claim can still be refused. The alarm uses this time to skip a waiting backfill
	with a read of this object's storage and no D1 call.
	*/
	async knownNextAt(): Promise<number | undefined> {
		const stored = await this.context.ctx.storage.get(backfillPurgePaceKey);

		return stored === undefined
			? undefined
			: knownPaceSchema.parse(stored).nextAt;
	}

	/**
	Claims the next backfill purge request at `now`. The claim succeeds when no
	tenant has claimed a request less than one interval before `now`. A refused
	claim returns the time of the claim that blocked it.

	One D1 batch does both steps: an insert that updates the row only when its
	time has passed, and a read of the row. The insert also creates the row in a
	database where it is missing.
	*/
	async claim(now: number): Promise<BackfillPurgeClaim> {
		const table = d1Schema.backfillPurgePace;
		const claimedAt = now + this.intervalMs;
		const dueRow = and(eq(table.id, paceRowId), lte(table.nextAt, now));
		const [claimed, current] = await this.context.d1.batch([
			this.context.d1
				.insert(table)
				.values({ id: paceRowId, nextAt: claimedAt })
				.onConflictDoUpdate({
					target: table.id,
					set: { nextAt: claimedAt },
					setWhere: dueRow
				})
				.returning({ nextAt: table.nextAt }),
			this.context.d1
				.select({ nextAt: table.nextAt })
				.from(table)
				.where(eq(table.id, paceRowId))
		]);

		if (claimed.length > 0) {
			await this.remember(claimedAt);

			return { kind: 'claimed' };
		}

		// The insert has created the row, so the read finds it.
		const nextAt = current.at(0)?.nextAt ?? claimedAt;
		await this.remember(nextAt);

		return { kind: 'waiting', nextAt };
	}
}
