import { type Logger } from '@cupboard/logger';
import {
	hasDoneWork,
	type LocalStepSweep,
	type LocalStepSweepChainId,
	localStepSweepChainIdSchema,
	type LocalStepSweepFailingTenant,
	localStepSweepFailingTenantSchema,
	localStepSweepFailureLimit,
	localStepSweepPaceSeconds,
	localStepWakeMaxTenants,
	type LocalStepWakeOutcomes,
	localStepWakeOutcomesSchema
} from '@cupboard/protocol/deployment';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	eq,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	type SQL,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import {
	maintenanceQueueMaxRetries,
	maintenanceQueueRetryDelaySeconds,
	queueConsumerWallClockMs
} from '../policy/maintenance-queue.ts';

type Database = DrizzleD1Database<typeof d1Schema>;
export type LocalStepSweepRow = typeof d1Schema.localStepSweep.$inferSelect;

const sweepRowId = 1;

/**
 * One message's place in a chain of sweep messages: the chain that it belongs
 * to and its number within the chain (its link).
 */
export const localStepSweepLinkSchema = z.object({
	chain: localStepSweepChainIdSchema,
	link: z.number().int().nonnegative()
});
export type LocalStepSweepLink = z.output<typeof localStepSweepLinkSchema>;

/**
 * The queue's identity for one delivery of a sweep message: the message's id,
 * which is the same for every delivery of one sent message, and the number of
 * this delivery attempt.
 */
export interface LocalStepSweepDelivery {
	readonly id: string;
	readonly attempts: number;
}

/**
 * The longest delay between two batches of a stalled chain.
 */
export const localStepSweepStallCapSeconds = 60 * 60;

// A margin for the queue's delivery latency across all attempts.
const deliveryMarginMs = 5 * 60 * 1000;

/**
 * How long a chain keeps the lease after it sends a message that the queue
 * delivers `delaySeconds` later. It covers that delay and every delivery of
 * the message before the queue moves it to the dead-letter queue: each
 * delivery runs for at most the consumer's wall-clock limit, and the queue
 * delivers each retry after the retry delay. A chain that stops because its
 * message was lost keeps the lease for no longer than this, and the next cron
 * tick starts a new chain.
 *
 * The maintenance consumer runs at most `max_concurrency` invocations at once,
 * and a tenant verification pass can run for most of an invocation's wall
 * time. After a busy cron tick, a message can therefore wait in the backlog
 * after its delivery delay has passed. Nothing bounds that wait, so the lease
 * does not cover it.
 */
export function localStepSweepLeaseMs(delaySeconds: number): number {
	return (
		delaySeconds * 1000 +
		(maintenanceQueueMaxRetries + 1) * queueConsumerWallClockMs +
		maintenanceQueueMaxRetries * maintenanceQueueRetryDelaySeconds * 1000 +
		deliveryMarginMs
	);
}

/**
 * The chain's state for the row after a claim or a batch: the number of tenant
 * wakes since the last batch in which a tenant did work, when the chain
 * confirmed a stall, the tenants whose recent wakes failed, the delay before
 * its next message, the per-tenant outcomes of the last batch, and when that
 * batch ran.
 */
export interface LocalStepSweepUpdate {
	readonly wokenWithoutWork: number;
	readonly stalledAt?: IsoTimestamp;
	readonly failing: readonly LocalStepSweepFailingTenant[];
	readonly delaySeconds: number;
	readonly outcomes: LocalStepWakeOutcomes;
	readonly batchAt: IsoTimestamp;
}

/**
 * The part of the row that the next update starts from.
 */
export type LocalStepSweepProgress = Pick<
	LocalStepSweepUpdate,
	'wokenWithoutWork' | 'stalledAt' | 'failing' | 'delaySeconds'
>;

type LocalStepSweepBatch = Pick<LocalStepSweepUpdate, 'outcomes' | 'batchAt'>;

/**
 * The update that a chain records after a batch, given the chain's progress
 * before the batch, or `undefined` for a chain's first batch. `previous` must
 * list only failing tenants that are still pending.
 *
 * A batch in which a tenant did work keeps the chain running at
 * `localStepSweepPaceSeconds`. Otherwise the chain adds the batch's completed
 * wakes to its count of tenant wakes without work. A failed wake may not have
 * reached the tenant, so it counts only once the tenant has failed
 * `localStepSweepFailureLimit` wakes in a row. The batches follow the wake
 * cursor, so once the count reaches the number of pending tenants and no
 * failing tenant is below that limit, every pending tenant has completed a
 * wake without work or has failed too often, and the chain confirms a stall.
 * The delay stays at `localStepSweepPaceSeconds` until then, and doubles with
 * each further batch, up to `localStepSweepStallCapSeconds`.
 */
export function localStepSweepUpdateAfter(
	previous: LocalStepSweepProgress | undefined,
	batch: LocalStepSweepBatch,
	pending: number,
	now: Date
): LocalStepSweepUpdate {
	const failing = failingAfter(previous?.failing ?? [], batch.outcomes);

	if (batch.outcomes.some((outcome) => hasDoneWork(outcome))) {
		return { ...localStepSweepRestart(batch), failing };
	}

	const failures = new Map(failing.map((failure) => [failure.tenant, failure]));
	const completed = batch.outcomes.filter(
		(outcome) =>
			outcome.kind !== 'failed' ||
			(failures.get(outcome.tenant)?.failures ?? localStepSweepFailureLimit) >=
				localStepSweepFailureLimit
	).length;
	const wokenWithoutWork = (previous?.wokenWithoutWork ?? 0) + completed;

	if (previous?.stalledAt !== undefined) {
		return {
			...batch,
			wokenWithoutWork,
			stalledAt: previous.stalledAt,
			failing,
			delaySeconds: backoff(previous.delaySeconds)
		};
	}

	const isRetrying = failing.some(
		(failure) => failure.failures < localStepSweepFailureLimit
	);

	if (isRetrying || wokenWithoutWork < pending) {
		return {
			...batch,
			wokenWithoutWork,
			failing,
			delaySeconds: localStepSweepPaceSeconds
		};
	}

	return {
		...batch,
		wokenWithoutWork,
		stalledAt: isoTimestamp(now),
		failing,
		delaySeconds: backoff(localStepSweepPaceSeconds)
	};
}

// Counts each failed wake against its tenant, and clears the count of a tenant
// whose wake completed. At most `localStepWakeMaxTenants` tenants are tracked.
// A failure of a tenant beyond that is not tracked, so it counts as a wake
// without work.
function failingAfter(
	previous: readonly LocalStepSweepFailingTenant[],
	outcomes: LocalStepWakeOutcomes
): LocalStepSweepFailingTenant[] {
	const failing = new Map(previous.map((failure) => [failure.tenant, failure]));

	for (const outcome of outcomes) {
		const { tenant } = outcome;

		if (outcome.kind !== 'failed') {
			failing.delete(tenant);
			continue;
		}

		const earlier = failing.get(tenant);

		if (earlier === undefined && failing.size >= localStepWakeMaxTenants) {
			continue;
		}

		failing.set(tenant, {
			tenant,
			failures: (earlier?.failures ?? 0) + 1,
			error: outcome.error
		});
	}

	return failing.values().toArray();
}

function backoff(delaySeconds: number): number {
	return Math.min(delaySeconds * 2, localStepSweepStallCapSeconds);
}

/**
 * The update for a chain with no stall and no failing tenants: a chain that
 * the cron tick starts, which runs no batch and keeps the previous chain's
 * last outcomes and their batch time.
 */
export function localStepSweepRestart(
	batch: LocalStepSweepBatch
): LocalStepSweepUpdate {
	return {
		...batch,
		wokenWithoutWork: 0,
		failing: [],
		delaySeconds: localStepSweepPaceSeconds
	};
}

function rowFor(update: LocalStepSweepUpdate, now: Date) {
	return {
		sent: false,
		batchMessage: sql`null`,
		batchAttempts: sql`null`,
		wokenWithoutWork: update.wokenWithoutWork,
		stalledAt: update.stalledAt ?? sql`null`,
		failingTenants: JSON.stringify(update.failing),
		delaySeconds: update.delaySeconds,
		expiresAt: leaseEnd(update.delaySeconds, now),
		nextAt: isoTimestamp(new Date(now.getTime() + update.delaySeconds * 1000)),
		updatedAt: isoTimestamp(now),
		batchAt: update.batchAt,
		lastOutcomes: JSON.stringify(update.outcomes)
	};
}

function leaseEnd(delaySeconds: number, now: Date): IsoTimestamp {
	return isoTimestamp(
		new Date(now.getTime() + localStepSweepLeaseMs(delaySeconds))
	);
}

const linkColumns = {
	chain: d1Schema.localStepSweep.chain,
	link: d1Schema.localStepSweep.link
};

/**
 * Claims the row for a new chain unless another chain has a lease that has
 * not expired. Returns the chain's first link, or `undefined` when another
 * chain has the lease. The link is recorded as not yet sent.
 */
export async function claimLocalStepSweep(
	database: Database,
	chain: LocalStepSweepChainId,
	update: LocalStepSweepUpdate,
	now: Date
): Promise<LocalStepSweepLink | undefined> {
	return upsertChain(
		database,
		chain,
		update,
		now,
		lte(d1Schema.localStepSweep.expiresAt, isoTimestamp(now))
	);
}

/**
 * Claims the row for a new chain unless another chain has a lease that has
 * not expired and has not confirmed a stall. This is the claim of a
 * `localStep.wake`: an operator's request replaces a stalled chain. The claim
 * is one statement, so a batch of the stalled chain that records its next link
 * at the same time either comes first and is replaced, or comes second and
 * matches no row. Every later write of the replaced chain matches no row,
 * because each of those writes requires the row to record that chain.
 */
export async function claimLocalStepSweepForWake(
	database: Database,
	chain: LocalStepSweepChainId,
	update: LocalStepSweepUpdate,
	now: Date
): Promise<LocalStepSweepLink | undefined> {
	const leaseExpired = lte(
		d1Schema.localStepSweep.expiresAt,
		isoTimestamp(now)
	);
	const stallConfirmed = isNotNull(d1Schema.localStepSweep.stalledAt);

	return upsertChain(
		database,
		chain,
		update,
		now,
		or(leaseExpired, stallConfirmed)
	);
}

async function upsertChain(
	database: Database,
	chain: LocalStepSweepChainId,
	update: LocalStepSweepUpdate,
	now: Date,
	isReplaceable: SQL | undefined
): Promise<LocalStepSweepLink | undefined> {
	const values = { chain, link: 0, ...rowFor(update, now) };
	const [claimed] = await database
		.insert(d1Schema.localStepSweep)
		.values({ id: sweepRowId, ...values })
		.onConflictDoUpdate({
			target: d1Schema.localStepSweep.id,
			set: values,
			setWhere: isReplaceable
		})
		.returning(linkColumns);

	return claimed;
}

/**
 * The row as last written, whichever chain wrote it. After a lease expires,
 * the row still records its chain until another chain claims it.
 */
export function readLocalStepSweepRow(
	database: Database
): Promise<LocalStepSweepRow | undefined> {
	return database
		.select()
		.from(d1Schema.localStepSweep)
		.where(eq(d1Schema.localStepSweep.id, sweepRowId))
		.get();
}

/**
 * Whether the row records this link as the latest link of a chain that has
 * not ended. A redelivery of an ended chain's last message, whose
 * acknowledgement was lost, therefore runs no batch.
 */
export function isCurrentLocalStepSweepLink(
	row: LocalStepSweepRow | undefined,
	link: LocalStepSweepLink
): boolean {
	return (
		row?.chain === link.chain && row.link === link.link && row.nextAt !== null
	);
}

export type UnsentLocalStepSweepRow = LocalStepSweepRow & {
	readonly nextAt: IsoTimestamp;
};

/**
 * Whether the row records the link after this one and marks the message for
 * that link as not yet sent. That happens when a delivery of this message
 * recorded the next link and then failed to send its message or stopped
 * before sending it.
 */
export function isUnsentNextLocalStepSweepLink(
	row: LocalStepSweepRow | undefined,
	link: LocalStepSweepLink
): row is UnsentLocalStepSweepRow {
	return (
		row?.chain === link.chain &&
		row.link === link.link + 1 &&
		!row.sent &&
		row.nextAt !== null
	);
}

/**
 * Claims the batch for this link for one delivery of its message. The claim
 * succeeds when no delivery has claimed the batch, or when an earlier attempt
 * of the same message claimed it. The queue delivers a message again only
 * after the earlier attempt has ended, so that attempt no longer runs the
 * batch. Returns the link, or `undefined` when the row no longer records this
 * link of a chain that has not ended, or another message has claimed the
 * batch.
 */
export async function claimLocalStepSweepBatch(
	database: Database,
	link: LocalStepSweepLink,
	delivery: LocalStepSweepDelivery
): Promise<LocalStepSweepLink | undefined> {
	const { batchMessage, batchAttempts, nextAt } = d1Schema.localStepSweep;
	const unclaimed = isNull(batchMessage);
	const earlierAttempt = and(
		eq(batchMessage, delivery.id),
		lt(batchAttempts, delivery.attempts)
	);
	const [claimed] = await database
		.update(d1Schema.localStepSweep)
		.set({ batchMessage: delivery.id, batchAttempts: delivery.attempts })
		.where(and(atLink(link), isNotNull(nextAt), or(unclaimed, earlierAttempt)))
		.returning(linkColumns);

	return claimed;
}

/**
 * Records the chain's next link as not yet sent, extends the lease and records
 * the batch. Returns `undefined` when the row no longer records this link,
 * because another chain claimed the row or replaced this chain.
 */
export async function recordNextLocalStepSweepLink(
	database: Database,
	current: LocalStepSweepLink,
	update: LocalStepSweepUpdate,
	now: Date
): Promise<LocalStepSweepLink | undefined> {
	const [next] = await database
		.update(d1Schema.localStepSweep)
		.set({
			link: sql`${d1Schema.localStepSweep.link} + 1`,
			...rowFor(update, now)
		})
		.where(atLink(current))
		.returning(linkColumns);

	return next;
}

/**
 * Records that the queue accepted the message for this link, and extends the
 * lease from now so that it covers every delivery of that message.
 */
export async function markLocalStepSweepSent(
	database: Database,
	link: LocalStepSweepLink,
	delaySeconds: number,
	now: Date
): Promise<void> {
	await database
		.update(d1Schema.localStepSweep)
		.set({ sent: true, expiresAt: leaseEnd(delaySeconds, now) })
		.where(atLink(link))
		.run();
}

function endValues(batch: LocalStepSweepBatch, now: Date) {
	return {
		expiresAt: isoTimestamp(now),
		nextAt: sql`null`,
		updatedAt: isoTimestamp(now),
		batchAt: batch.batchAt,
		lastOutcomes: JSON.stringify(batch.outcomes)
	};
}

/**
 * Ends the chain, if the row still records this link: its lease expires now,
 * so a new chain may claim the row at once, and the batch's outcomes stay
 * readable until one does. Returns the ended link, or `undefined` when the
 * row no longer records it.
 */
export async function endLocalStepSweep(
	database: Database,
	link: LocalStepSweepLink,
	batch: LocalStepSweepBatch,
	now: Date
): Promise<LocalStepSweepLink | undefined> {
	const [ended] = await database
		.update(d1Schema.localStepSweep)
		.set(endValues(batch, now))
		.where(atLink(link))
		.returning(linkColumns);

	return ended;
}

/**
 * Ends whichever chain has not ended, after a wake that left no tenant
 * pending, and records the wake's batch as the last. Its next message then
 * runs no batch.
 */
export async function endCurrentLocalStepSweep(
	database: Database,
	batch: LocalStepSweepBatch,
	now: Date
): Promise<void> {
	await database
		.update(d1Schema.localStepSweep)
		.set(endValues(batch, now))
		.where(
			and(
				eq(d1Schema.localStepSweep.id, sweepRowId),
				isNotNull(d1Schema.localStepSweep.nextAt)
			)
		)
		.run();
}

/**
 * The chain's progress as the row records it, for the update after its next
 * batch.
 */
export function localStepSweepProgressOf(
	logger: Logger,
	row: LocalStepSweepRow
): LocalStepSweepProgress {
	return {
		wokenWithoutWork: row.wokenWithoutWork,
		...(row.stalledAt !== null && { stalledAt: row.stalledAt }),
		failing: storedFailingTenants(logger, row),
		delaySeconds: row.delaySeconds
	};
}

/**
 * The sweep as `localStep.status` reports it. A chain has the lease while the
 * row's lease has not expired and the row has a next message. The sweep is
 * then `stalled` once the chain has confirmed a stall, and `running` before
 * that. Otherwise the sweep is idle, and the row, if any, describes the last
 * chain.
 */
export async function readLocalStepSweep(
	logger: Logger,
	database: Database,
	now: Date
): Promise<LocalStepSweep> {
	const row = await readLocalStepSweepRow(database);

	if (row === undefined) {
		return { state: 'idle' };
	}

	const last = {
		chain: row.chain,
		link: row.link,
		updatedAt: row.updatedAt,
		batchAt: row.batchAt,
		outcomes: storedLocalStepSweepOutcomes(logger, row),
		failing: storedFailingTenants(logger, row)
	};

	if (row.nextAt === null || row.expiresAt <= isoTimestamp(now)) {
		return { state: 'idle', last };
	}

	const chain = {
		...last,
		nextAt: row.nextAt,
		wokenWithoutWork: row.wokenWithoutWork
	};

	if (row.stalledAt === null) {
		return { state: 'running', ...chain };
	}

	return { state: 'stalled', ...chain, stalledAt: row.stalledAt };
}

/**
 * The last batch's outcomes as the row records them. After a rollback, the row
 * can record an outcome kind that the running build does not define, and the
 * outcomes do not parse. This function then returns no outcomes and logs a
 * warning, and the chain's next batch writes the row again.
 */
export function storedLocalStepSweepOutcomes(
	logger: Logger,
	row: Pick<LocalStepSweepRow, 'chain' | 'link' | 'lastOutcomes'>
): LocalStepWakeOutcomes {
	return parseStored(
		logger,
		row,
		row.lastOutcomes,
		localStepWakeOutcomesSchema,
		{
			notJson: 'local step sweep outcomes are not JSON',
			unknownShape: 'local step sweep outcomes have an unknown shape'
		}
	);
}

const failingTenantsSchema = z
	.array(localStepSweepFailingTenantSchema)
	.max(localStepWakeMaxTenants);

// The failing tenants as the row records them. A value that does not parse
// reads as no failing tenants, with a warning, as the outcomes do.
function storedFailingTenants(
	logger: Logger,
	row: Pick<LocalStepSweepRow, 'chain' | 'link' | 'failingTenants'>
): LocalStepSweepFailingTenant[] {
	return parseStored(logger, row, row.failingTenants, failingTenantsSchema, {
		notJson: 'local step sweep failing tenants are not JSON',
		unknownShape: 'local step sweep failing tenants have an unknown shape'
	});
}

function parseStored<Schema extends z.ZodType>(
	logger: Logger,
	row: Pick<LocalStepSweepRow, 'chain' | 'link'>,
	stored: string,
	schema: Schema,
	messages: { readonly notJson: string; readonly unknownShape: string }
): z.output<Schema> | [] {
	let json: unknown;

	try {
		json = JSON.parse(stored);
	} catch (error) {
		logger.warn(messages.notJson, {
			chain: row.chain,
			link: row.link,
			error
		});

		return [];
	}

	const parsed = schema.safeParse(json);

	if (!parsed.success) {
		logger.warn(messages.unknownShape, {
			chain: row.chain,
			link: row.link,
			error: parsed.error
		});

		return [];
	}

	return parsed.data;
}

function atLink(link: LocalStepSweepLink) {
	return and(
		eq(d1Schema.localStepSweep.id, sweepRowId),
		eq(d1Schema.localStepSweep.chain, link.chain),
		eq(d1Schema.localStepSweep.link, link.link)
	);
}
