import { type Logger } from '@cupboard/logger';
import {
	localStepSweepBatchSize,
	type LocalStepSweepChainId,
	localStepSweepChainIdSchema,
	type LocalStepWakeBatch,
	type LocalStepWakeChain,
	type LocalStepWakeResponse
} from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';

import {
	controlLocalStepPending,
	controlLocalStepPendingAmong,
	controlLocalStepWake,
	summariseWakeError
} from './local-step.ts';
import {
	claimLocalStepSweep,
	claimLocalStepSweepBatch,
	claimLocalStepSweepForWake,
	endCurrentLocalStepSweep,
	endLocalStepSweep,
	isCurrentLocalStepSweepLink,
	isUnsentNextLocalStepSweepLink,
	type LocalStepSweepDelivery,
	type LocalStepSweepLink,
	type LocalStepSweepProgress,
	localStepSweepProgressOf,
	localStepSweepRestart,
	type LocalStepSweepRow,
	type LocalStepSweepUpdate,
	localStepSweepUpdateAfter,
	markLocalStepSweepSent,
	readLocalStepSweepRow,
	recordNextLocalStepSweepLink,
	storedLocalStepSweepOutcomes,
	type UnsentLocalStepSweepRow
} from './local-step-sweep.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

/**
 * The maintenance message that runs one batch of a chain. Only a chain sends
 * it: the wake procedure or the cron tick starts a chain by sending its first
 * message, and each batch sends the chain's next message.
 */
export interface LocalStepSweepMessage {
	readonly kind: 'local-step-sweep';
	readonly chain: LocalStepSweepLink;
}

type LocalStepSweepQueue = Pick<Queue<LocalStepSweepMessage>, 'sendBatch'>;
type WakeLocalSteps = (
	logger: Logger,
	env: Env,
	limit: number
) => Promise<LocalStepWakeBatch>;

export interface LocalStepSweepOptions {
	readonly batchSize?: number;
	readonly queue?: LocalStepSweepQueue;
	readonly wake?: WakeLocalSteps;
	readonly countPending?: (env: Env) => Promise<number>;
	readonly newChain?: () => LocalStepSweepChainId;
}

interface SentContinuation {
	readonly kind: 'sent';
	readonly next: LocalStepSweepLink;
	readonly state: 'running' | 'stalled';
	readonly delaySeconds: number;
}

/**
 * The result of one delivery of a sweep message.
 *
 * - `sent`: the delivery sent the chain's next message. The queue delivers it
 *   after `delaySeconds`. `state` is `stalled` once the chain has confirmed a
 *   stall, and `running` before that.
 * - `done`: no tenant is pending, so the chain ended.
 * - `duplicate`: another message for this link has claimed its batch, so this
 *   delivery ran no batch.
 * - `superseded`: the row no longer records this message's link of a chain
 *   that has not ended. Another delivery for the link already sent the
 *   chain's next message, the chain ended, or a newer chain claimed the row.
 */
export type LocalStepSweepContinuation =
	| SentContinuation
	| { readonly kind: 'done' }
	| { readonly kind: 'duplicate' }
	| { readonly kind: 'superseded' };

/**
 * The result of starting a chain: `sent` when the chain sent its first
 * message, and `held-elsewhere` when another chain has the lease.
 */
export type LocalStepSweepStart =
	SentContinuation | { readonly kind: 'held-elsewhere' };

/**
 * Runs one batch of a chain: wakes a bounded batch of tenants that have not
 * recorded the required step, so each applies its pending migrations and
 * records its step, then sends the chain's next message while tenants remain.
 * A message runs a batch only while the row records its link, and only after
 * it has claimed that link's batch for its delivery. At most one message
 * therefore runs the batch and records the chain's next link.
 *
 * The chain records its next link before it sends the message for that link.
 * If the send fails, or the delivery stops between the two, the queue delivers
 * this message again, and the redelivery sends the recorded message without
 * running another batch. If the send succeeds and the update that marks the
 * link as sent fails, the redelivery sends the message a second time. The
 * second copy then runs no batch: the first copy has claimed the batch or has
 * already recorded a newer link.
 *
 * A batch in which no tenant did work does not end the chain. The row records
 * the batch's outcomes, so `localStep.status` reports which tenants are stuck
 * and in which way while the retries continue. The chain ends only when no
 * tenant is pending. `localStepSweepUpdateAfter` sets when the chain confirms
 * a stall and the delay before each batch.
 */
export async function runLocalStepSweep(
	logger: Logger,
	env: Env,
	chain: LocalStepSweepLink,
	delivery: LocalStepSweepDelivery,
	options: LocalStepSweepOptions = {}
): Promise<LocalStepSweepContinuation> {
	const database = controlDatabase(env);
	const row = await readLocalStepSweepRow(database);

	if (isUnsentNextLocalStepSweepLink(row, chain)) {
		const continuation = await sendRecorded(database, env, row, options);

		logger.info('local step sweep sent a recorded message', {
			next: continuation.next.link,
			delaySeconds: continuation.delaySeconds,
			...chain
		});

		return continuation;
	}

	if (row === undefined || !isCurrentLocalStepSweepLink(row, chain)) {
		logger.info('local step sweep superseded', { ...chain });

		return { kind: 'superseded' };
	}

	const claimed = await claimLocalStepSweepBatch(database, chain, delivery);

	if (claimed === undefined) {
		return unclaimed(logger, database, chain);
	}

	const batch = await (options.wake ?? controlLocalStepWake)(
		logger,
		env,
		options.batchSize ?? localStepSweepBatchSize
	);
	const pending = await (options.countPending ?? controlLocalStepPending)(env);
	const continuation = await continueChain(
		database,
		env,
		chain,
		{
			previous: await pendingProgress(logger, env, row, batch),
			batch,
			pending
		},
		options
	);

	logger.info('local step sweep finished', {
		woken: batch.woken,
		failed: batch.failed,
		pending,
		continuation: continuation.kind,
		...(continuation.kind === 'sent' && {
			state: continuation.state,
			delaySeconds: continuation.delaySeconds
		}),
		...chain
	});

	return continuation;
}

// The batch claim fails when another message has claimed the batch, or when
// the row has moved past this link since this delivery read it.
async function unclaimed(
	logger: Logger,
	database: Database,
	chain: LocalStepSweepLink
): Promise<LocalStepSweepContinuation> {
	const row = await readLocalStepSweepRow(database);

	if (isCurrentLocalStepSweepLink(row, chain)) {
		logger.info('local step sweep batch claimed by another message', {
			...chain
		});

		return { kind: 'duplicate' };
	}

	logger.info('local step sweep superseded', { ...chain });

	return { kind: 'superseded' };
}

// The chain's progress before this batch. A tenant that another wake has
// brought to the required step is no longer pending, so its failures no longer
// stop the chain from confirming a stall.
async function pendingProgress(
	logger: Logger,
	env: Env,
	row: LocalStepSweepRow,
	batch: LocalStepWakeBatch
): Promise<LocalStepSweepProgress> {
	const progress = localStepSweepProgressOf(logger, row);
	const inBatch = new Set(batch.outcomes.map((outcome) => outcome.tenant));
	const unseen = progress.failing
		.filter((failure) => !inBatch.has(failure.tenant))
		.map((failure) => failure.tenant);
	const stillPending = await controlLocalStepPendingAmong(env, unseen);

	return {
		...progress,
		failing: progress.failing.filter(
			(failure) =>
				inBatch.has(failure.tenant) || stillPending.has(failure.tenant)
		)
	};
}

interface ChainBatch {
	readonly previous: LocalStepSweepProgress;
	readonly batch: LocalStepWakeBatch;
	readonly pending: number;
}

// Ends the chain when no tenant is pending, and otherwise sends the chain's
// next message.
async function continueChain(
	database: Database,
	env: Env,
	chain: LocalStepSweepLink,
	progress: ChainBatch,
	options: LocalStepSweepOptions
): Promise<LocalStepSweepContinuation> {
	const { previous, batch, pending } = progress;
	const now = new Date();
	const batchAt = isoTimestamp(now);

	if (pending === 0) {
		const ended = await endLocalStepSweep(
			database,
			chain,
			{ outcomes: batch.outcomes, batchAt },
			now
		);

		return { kind: ended === undefined ? 'superseded' : 'done' };
	}

	const update = localStepSweepUpdateAfter(
		previous,
		{ outcomes: batch.outcomes, batchAt },
		pending,
		now
	);
	const next = await recordNextLocalStepSweepLink(database, chain, update, now);

	if (next === undefined) {
		return { kind: 'superseded' };
	}

	return send(database, env, next, deliveryFor(update), options);
}

interface Delivery {
	readonly state: SentContinuation['state'];
	readonly delaySeconds: number;
}

function deliveryFor(update: LocalStepSweepUpdate): Delivery {
	return {
		state: update.stalledAt === undefined ? 'running' : 'stalled',
		delaySeconds: update.delaySeconds
	};
}

// Sends the message for a link that an earlier delivery recorded but did not
// send. The queue delivers it once the rest of the recorded delay has passed.
function sendRecorded(
	database: Database,
	env: Env,
	row: UnsentLocalStepSweepRow,
	options: LocalStepSweepOptions
): Promise<SentContinuation> {
	const remainingMs = Date.parse(row.nextAt) - Date.now();

	return send(
		database,
		env,
		{ chain: row.chain, link: row.link },
		{
			state: row.stalledAt === null ? 'running' : 'stalled',
			delaySeconds: Math.max(0, Math.ceil(remainingMs / 1000))
		},
		options
	);
}

/**
 * Wakes a batch for the `localStep.wake` procedure, then acts on the sweep
 * chain, and reports what it did as the response's `chain`.
 *
 * When tenants remain, the wake starts a chain with this batch as its first.
 * The wake is an operator's request, so it replaces a chain that has confirmed
 * a stall. The new chain counts the tenant wakes without work from this batch
 * alone, and its delay returns to `localStepSweepPaceSeconds`. A chain that has
 * not confirmed a stall keeps the lease, and the row does not record this
 * batch. When no tenant remains, the wake ends any chain that has the lease,
 * so the sweep does not keep reporting an earlier stall.
 *
 * A running chain can wake the same batch at the same time, because both read
 * the same wake cursor. The cursor moves only if it has not moved since it was
 * read, so the two wakes move it once. A second wake of the same tenant does
 * no harm: it records the same step or continues the tenant's work.
 *
 * The batch has already run when the wake acts on the chain, so a failure to
 * count the pending tenants, or to start or end a chain, is logged and
 * reported as `failed` with the batch's result. The caller can wake again, and
 * the next cron tick starts a chain if none has the lease.
 */
export async function wakeLocalStepsAndContinue(
	logger: Logger,
	env: Env,
	limit: number,
	options: LocalStepSweepOptions = {}
): Promise<LocalStepWakeResponse> {
	const batch = await (options.wake ?? controlLocalStepWake)(
		logger,
		env,
		limit
	);
	let chain: LocalStepWakeChain;

	try {
		chain = await continueAfterWake(logger, env, batch, options);
	} catch (error) {
		logger.warn('local step wake could not start or end a sweep chain', {
			error
		});
		chain = { kind: 'failed', error: summariseWakeError(error) };
	}

	return { ...batch, chain };
}

async function continueAfterWake(
	logger: Logger,
	env: Env,
	batch: LocalStepWakeBatch,
	options: LocalStepSweepOptions
): Promise<LocalStepWakeChain> {
	const database = controlDatabase(env);
	const pending = await (options.countPending ?? controlLocalStepPending)(env);
	const now = new Date();
	const batchAt = isoTimestamp(now);

	if (pending === 0) {
		await endCurrentLocalStepSweep(
			database,
			{ outcomes: batch.outcomes, batchAt },
			now
		);

		return { kind: 'none' };
	}

	const update = localStepSweepUpdateAfter(
		undefined,
		{ outcomes: batch.outcomes, batchAt },
		pending,
		now
	);
	const chain = (options.newChain ?? newChainId)();
	const first = await claimLocalStepSweepForWake(database, chain, update, now);

	logger.info('local step wake finished with tenants pending', {
		pending,
		chain: first === undefined ? 'kept' : 'started'
	});

	if (first === undefined) {
		return { kind: 'kept' };
	}

	await sendFirst(database, env, first, update, options);

	return { kind: 'started', chain };
}

/**
 * The cron tick's start for the sweep: starts a chain when tenants are pending
 * and no chain has the lease, for example after a chain stopped because its
 * message was dead-lettered. It runs no batch itself. The new chain keeps the
 * previous chain's last outcomes and their batch time until its own first
 * batch runs.
 */
export async function restartLocalStepSweep(
	logger: Logger,
	env: Env,
	options: LocalStepSweepOptions = {}
): Promise<LocalStepSweepStart | { readonly kind: 'done' }> {
	const pending = await (options.countPending ?? controlLocalStepPending)(env);

	if (pending === 0) {
		logger.info('local step sweep restart', { pending, start: 'done' });

		return { kind: 'done' };
	}

	const database = controlDatabase(env);
	const previous = await readLocalStepSweepRow(database);
	const update = localStepSweepRestart({
		outcomes:
			previous === undefined
				? []
				: storedLocalStepSweepOutcomes(logger, previous),
		batchAt: previous?.batchAt ?? isoTimestamp(new Date())
	});
	const chain = (options.newChain ?? newChainId)();
	const claimed = await claimLocalStepSweep(
		database,
		chain,
		update,
		new Date()
	);
	const start: LocalStepSweepStart =
		claimed === undefined
			? { kind: 'held-elsewhere' }
			: await sendFirst(database, env, claimed, update, options);

	logger.info('local step sweep restart', { pending, start: start.kind });

	return start;
}

// No earlier message exists that could send a chain's first message again, so
// a first message that the queue rejects ends the chain, and the next wake or
// cron tick may then start a chain straight away. Once the queue has accepted
// the message, the chain continues even if marking the link as sent fails.
async function sendFirst(
	database: Database,
	env: Env,
	first: LocalStepSweepLink,
	update: LocalStepSweepUpdate,
	options: LocalStepSweepOptions
): Promise<SentContinuation> {
	const delivery = deliveryFor(update);

	try {
		await enqueue(env, first, delivery, options);
	} catch (sendError) {
		try {
			await endLocalStepSweep(database, first, update, new Date());
		} catch (endError) {
			// The row still records the unsent first link, so it reads as a
			// running chain until its lease expires.
			throw new AggregateError(
				[sendError, endError],
				'local step sweep could not send its first message or end the chain',
				{ cause: endError }
			);
		}

		throw sendError;
	}

	return markSent(database, first, delivery);
}

async function send(
	database: Database,
	env: Env,
	next: LocalStepSweepLink,
	delivery: Delivery,
	options: LocalStepSweepOptions
): Promise<SentContinuation> {
	await enqueue(env, next, delivery, options);

	return markSent(database, next, delivery);
}

async function enqueue(
	env: Env,
	next: LocalStepSweepLink,
	delivery: Delivery,
	options: LocalStepSweepOptions
): Promise<void> {
	const queue = options.queue ?? env.MAINTENANCE_QUEUE;

	await queue.sendBatch([
		{
			body: { kind: 'local-step-sweep', chain: next },
			delaySeconds: delivery.delaySeconds
		}
	]);
}

async function markSent(
	database: Database,
	next: LocalStepSweepLink,
	delivery: Delivery
): Promise<SentContinuation> {
	await markLocalStepSweepSent(
		database,
		next,
		delivery.delaySeconds,
		new Date()
	);

	return { kind: 'sent', next, ...delivery };
}

function controlDatabase(env: Env): Database {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function newChainId(): LocalStepSweepChainId {
	return localStepSweepChainIdSchema.parse(crypto.randomUUID());
}
