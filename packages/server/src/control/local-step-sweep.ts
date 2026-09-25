import {
	type LocalStepSweep,
	type LocalStepSweepChainId,
	localStepSweepChainIdSchema,
	localStepSweepPaceSeconds,
	type LocalStepWakeOutcomes,
	localStepWakeOutcomesSchema
} from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, lte, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import { StoredLocalStepSweepOutcomesInvalidError } from '../errors.ts';
import {
	maintenanceQueueMaxRetries,
	maintenanceQueueRetryDelaySeconds,
	queueConsumerWallClockMs
} from '../routing/maintenance-queue.ts';

type Database = DrizzleD1Database<typeof d1Schema>;
export type LocalStepSweepRow = typeof d1Schema.localStepSweep.$inferSelect;
type SweepRow = LocalStepSweepRow;

const sweepRowId = 1;

/**
 * One message's place in a chain of local-step sweeps: the chain it belongs
 * to and how many messages the chain handed on before it.
 */
export const localStepSweepLinkSchema = z.object({
	chain: localStepSweepChainIdSchema,
	link: z.number().int().nonnegative()
});
export type LocalStepSweepLink = z.output<typeof localStepSweepLinkSchema>;

/**
 * The longest a stalled chain waits before it tries again. Well within the
 * queue's delay limit of twelve hours.
 */
export const localStepSweepStallCapSeconds = 60 * 60;

// Allowance for the queue to deliver each attempt of a chained message.
const deliveryMarginMs = 5 * 60 * 1000;

/**
 * How long a chain holds the lease after handing on a message the queue
 * delivers `delaySeconds` later. It covers that delay and every delivery the
 * queue makes of the message before the dead-letter queue: each runs for at
 * most the consumer's wall-clock limit and each retry waits the retry delay
 * first. A redelivered message therefore finds its chain's lease still held,
 * so no other chain can claim it in the meantime. A chain that dies holds the
 * lease for no longer than this, and the next cron tick starts a new one.
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
 * What a chain records when it claims the row or hands on a message: whether
 * its last batch advanced a tenant, how long the queue waits before
 * delivering the next message, and the batch's per-tenant outcomes.
 */
export interface LocalStepSweepHandOn {
	readonly state: SweepRow['state'];
	readonly delaySeconds: number;
	readonly outcomes: LocalStepWakeOutcomes;
}

/**
 * The delay before the next batch after one that advanced nobody. The first
 * stall of a chain, or the first after progress, waits one pace; each stall
 * after that doubles the wait, up to the cap. The previous delay is what the
 * row records between its last change and its next message.
 */
export function localStepSweepStallDelaySeconds(
	previous: Pick<SweepRow, 'state' | 'updatedAt' | 'nextAt'> | undefined
): number {
	if (previous?.state !== 'stalled' || previous.nextAt === null) {
		return localStepSweepPaceSeconds;
	}

	const previousSeconds =
		(Date.parse(previous.nextAt) - Date.parse(previous.updatedAt)) / 1000;

	return Math.min(
		Math.max(Math.round(2 * previousSeconds), localStepSweepPaceSeconds),
		localStepSweepStallCapSeconds
	);
}

function rowFor(
	handOn: LocalStepSweepHandOn,
	now: Date
): Pick<
	SweepRow,
	'state' | 'expiresAt' | 'nextAt' | 'updatedAt' | 'lastOutcomes'
> {
	return {
		state: handOn.state,
		expiresAt: isoTimestamp(
			new Date(now.getTime() + localStepSweepLeaseMs(handOn.delaySeconds))
		),
		nextAt: isoTimestamp(new Date(now.getTime() + handOn.delaySeconds * 1000)),
		updatedAt: isoTimestamp(now),
		lastOutcomes: JSON.stringify(handOn.outcomes)
	};
}

/**
 * Claims the row for a new chain unless another chain holds it and its lease
 * has not expired. Returns the chain's first link, or `undefined` when
 * another chain holds the lease.
 */
export async function claimLocalStepSweep(
	database: Database,
	chain: LocalStepSweepChainId,
	handOn: LocalStepSweepHandOn,
	now: Date
): Promise<LocalStepSweepLink | undefined> {
	const values = { chain, link: 0, ...rowFor(handOn, now) };
	const [claimed] = await database
		.insert(d1Schema.localStepSweep)
		.values({ id: sweepRowId, ...values })
		.onConflictDoUpdate({
			target: d1Schema.localStepSweep.id,
			set: values,
			setWhere: lte(d1Schema.localStepSweep.expiresAt, isoTimestamp(now))
		})
		.returning({
			chain: d1Schema.localStepSweep.chain,
			link: d1Schema.localStepSweep.link
		});

	return claimed;
}

/**
 * The row as last written, whichever chain wrote it. An expired lease that no
 * other chain has claimed still names its chain.
 */
export function readLocalStepSweepRow(
	database: Database
): Promise<SweepRow | undefined> {
	return database
		.select()
		.from(d1Schema.localStepSweep)
		.where(eq(d1Schema.localStepSweep.id, sweepRowId))
		.get();
}

export function isLocalStepSweepLinkNamed(
	row: SweepRow | undefined,
	held: LocalStepSweepLink
): boolean {
	return row?.chain === held.chain && row.link === held.link;
}

/**
 * Moves the chain on to its next link, extends the lease and records the
 * batch. Returns `undefined` when the row no longer names this link, because
 * another delivery of the same message has already moved it on or another
 * chain claimed it after it expired.
 */
export async function handOnLocalStepSweep(
	database: Database,
	held: LocalStepSweepLink,
	handOn: LocalStepSweepHandOn,
	now: Date
): Promise<LocalStepSweepLink | undefined> {
	const [next] = await database
		.update(d1Schema.localStepSweep)
		.set({
			link: sql`${d1Schema.localStepSweep.link} + 1`,
			...rowFor(handOn, now)
		})
		.where(heldBy(held))
		.returning({
			chain: d1Schema.localStepSweep.chain,
			link: d1Schema.localStepSweep.link
		});

	return next;
}

/**
 * Ends the chain, if the row still names this link: its lease expires now, so
 * a new chain may claim the row at once, and the batch's outcomes stay
 * readable until one does.
 */
export async function endLocalStepSweep(
	database: Database,
	held: LocalStepSweepLink,
	outcomes: LocalStepWakeOutcomes,
	now: Date
): Promise<void> {
	await database
		.update(d1Schema.localStepSweep)
		.set({
			expiresAt: isoTimestamp(now),
			nextAt: sql`null`,
			updatedAt: isoTimestamp(now),
			lastOutcomes: JSON.stringify(outcomes)
		})
		.where(heldBy(held))
		.run();
}

/**
 * The sweep as `localStep.status` reports it. A chain holds the lease while
 * its row has not expired and names a next message; otherwise the sweep is
 * idle, and the row, if any, is the last chain.
 */
export async function readLocalStepSweep(
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
		outcomes: storedOutcomes(row.lastOutcomes)
	};

	if (row.nextAt === null || row.expiresAt <= isoTimestamp(now)) {
		return { state: 'idle', last };
	}

	return { state: row.state, ...last, nextAt: row.nextAt };
}

function storedOutcomes(text: string): LocalStepWakeOutcomes {
	let json: unknown;

	try {
		json = JSON.parse(text);
	} catch (error) {
		throw new StoredLocalStepSweepOutcomesInvalidError(error);
	}

	const parsed = localStepWakeOutcomesSchema.safeParse(json);

	if (!parsed.success) {
		throw new StoredLocalStepSweepOutcomesInvalidError(parsed.error);
	}

	return parsed.data;
}

function heldBy(held: LocalStepSweepLink) {
	return and(
		eq(d1Schema.localStepSweep.id, sweepRowId),
		eq(d1Schema.localStepSweep.chain, held.chain),
		eq(d1Schema.localStepSweep.link, held.link)
	);
}
