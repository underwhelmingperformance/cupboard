import { type Logger } from '@cupboard/logger';
import {
	type LocalStepSweepChainId,
	localStepSweepChainIdSchema,
	localStepSweepPaceSeconds,
	type LocalStepWakeResponse
} from '@cupboard/protocol/deployment';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	controlLocalStepPending,
	controlLocalStepWake
} from '../control/local-step.ts';
import {
	claimLocalStepSweep,
	endLocalStepSweep,
	handOnLocalStepSweep,
	isLocalStepSweepLinkNamed,
	type LocalStepSweepHandOn,
	type LocalStepSweepLink,
	type LocalStepSweepRow,
	localStepSweepStallDelaySeconds,
	readLocalStepSweepRow
} from '../control/local-step-sweep.ts';
import * as d1Schema from '../db/d1-schema.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

// Each wake is a subrequest, so keep a sweep well inside one invocation's
// subrequest budget. A chain of queue messages takes the batches that follow.
const localStepSweepSize = 20;

/**
 * The maintenance message that runs one batch of a chain. Only a chain sends
 * it: the wake procedure or the cron tick starts a chain by sending its first
 * link, and each batch sends the next.
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
) => Promise<LocalStepWakeResponse>;

export interface LocalStepSweepOptions {
	readonly batchSize?: number;
	readonly queue?: LocalStepSweepQueue;
	readonly wake?: WakeLocalSteps;
	readonly newChain?: () => LocalStepSweepChainId;
}

/**
 * What a sweep did about the tenants still pending after its batch.
 *
 * - `handed-on`: it sent the chain's next message, `running` one pace later
 *   when the batch advanced a tenant, or `stalled` after the backoff when it
 *   advanced nobody.
 * - `done`: no tenants are pending, so the chain ended.
 * - `held-elsewhere`: another chain holds the lease.
 * - `superseded`: the row no longer names this message's link. Another
 *   delivery of it already handed on, or a newer chain claimed the row.
 */
export type LocalStepSweepContinuation =
	| {
			readonly kind: 'handed-on';
			readonly next: LocalStepSweepLink;
			readonly state: LocalStepSweepHandOn['state'];
			readonly delaySeconds: number;
	  }
	| { readonly kind: 'done' }
	| { readonly kind: 'held-elsewhere' }
	| { readonly kind: 'superseded' };

/**
 * Runs one batch of a chain: wakes a bounded batch of tenants that have not
 * recorded the required step, so each applies its pending migrations and
 * records its step, then hands on to the chain's next message while tenants
 * remain. The chain runs only while the row names this message's link, so a
 * redelivered or duplicated message cannot fork it.
 *
 * A batch that advances nobody does not end the chain: the next message waits
 * out a backoff that doubles from one pace to an hour, and the row records the
 * stall with the batch's outcomes so an observer can see which tenants fail
 * and why while the retries continue. Progress resets the backoff. The chain
 * ends only when nothing is pending.
 */
export async function runLocalStepSweep(
	logger: Logger,
	env: Env,
	chain: LocalStepSweepLink,
	options: LocalStepSweepOptions = {}
): Promise<LocalStepSweepContinuation> {
	const database = controlDatabase(env);
	const row = await readLocalStepSweepRow(database);

	if (!isLocalStepSweepLinkNamed(row, chain)) {
		logger.info('local step sweep superseded', { ...chain });

		return { kind: 'superseded' };
	}

	const batch = await (options.wake ?? controlLocalStepWake)(
		logger,
		env,
		options.batchSize ?? localStepSweepSize
	);
	const pending = await controlLocalStepPending(env);
	const continuation = await continueChain(
		database,
		env,
		chain,
		{ previous: row, batch, pending },
		options
	);

	logger.info('local step sweep finished', {
		woken: batch.woken,
		failed: batch.failed,
		pending,
		continuation: continuation.kind,
		...(continuation.kind === 'handed-on' && {
			state: continuation.state,
			delaySeconds: continuation.delaySeconds
		}),
		...chain
	});

	return continuation;
}

interface SweepProgress {
	/**
	The row as it stood when this message's batch started.
	*/
	readonly previous: LocalStepSweepRow | undefined;
	readonly batch: LocalStepWakeResponse;
	readonly pending: number;
}

// Ends the chain when nothing is pending, and otherwise hands on: at the pace
// after progress, or after the backoff when the batch advanced nobody.
async function continueChain(
	database: Database,
	env: Env,
	chain: LocalStepSweepLink,
	progress: SweepProgress,
	options: LocalStepSweepOptions
): Promise<LocalStepSweepContinuation> {
	const { previous, batch, pending } = progress;
	const now = new Date();

	if (pending === 0) {
		await endLocalStepSweep(database, chain, batch.outcomes, now);

		return { kind: 'done' };
	}

	const handOn: LocalStepSweepHandOn =
		batch.woken > 0
			? {
					state: 'running',
					delaySeconds: localStepSweepPaceSeconds,
					outcomes: batch.outcomes
				}
			: {
					state: 'stalled',
					delaySeconds: localStepSweepStallDelaySeconds(previous),
					outcomes: batch.outcomes
				};
	const next = await handOnLocalStepSweep(database, chain, handOn, now);

	if (next === undefined) {
		return { kind: 'superseded' };
	}

	return send(database, env, next, handOn, options);
}

/**
 * Wakes a batch for the `localStep.wake` procedure. When tenants remain, it
 * also starts a chain to work through them, recording this batch as the
 * chain's first. The batch has already run, so a chain that cannot start is
 * logged rather than failing the call; the caller can wake again, and the
 * cron tick starts a chain in any case.
 */
export async function wakeLocalStepsAndContinue(
	logger: Logger,
	env: Env,
	limit: number,
	options: LocalStepSweepOptions = {}
): Promise<LocalStepWakeResponse> {
	const response = await (options.wake ?? controlLocalStepWake)(
		logger,
		env,
		limit
	);
	const pending = await controlLocalStepPending(env);

	if (pending === 0) {
		return response;
	}

	try {
		const continuation = await startChain(
			controlDatabase(env),
			env,
			{
				state: response.woken > 0 ? 'running' : 'stalled',
				delaySeconds: localStepSweepPaceSeconds,
				outcomes: response.outcomes
			},
			options
		);
		logger.info('local step wake continues in a sweep chain', {
			pending,
			continuation: continuation.kind
		});
	} catch (error) {
		logger.warn('local step sweep chain did not start', { pending, error });
	}

	return response;
}

/**
 * The cron tick's last resort for a chain whose message was dead-lettered:
 * starts a chain when tenants are pending and no chain holds the lease. It
 * runs no batch itself, and nothing waits for it.
 */
export async function restartLocalStepSweep(
	logger: Logger,
	env: Env,
	options: LocalStepSweepOptions = {}
): Promise<LocalStepSweepContinuation> {
	const pending = await controlLocalStepPending(env);

	if (pending === 0) {
		return { kind: 'done' };
	}

	const continuation = await startChain(
		controlDatabase(env),
		env,
		{ state: 'running', delaySeconds: localStepSweepPaceSeconds, outcomes: [] },
		options
	);

	logger.info('local step sweep restart considered', {
		pending,
		continuation: continuation.kind
	});

	return continuation;
}

async function startChain(
	database: Database,
	env: Env,
	handOn: LocalStepSweepHandOn,
	options: LocalStepSweepOptions
): Promise<LocalStepSweepContinuation> {
	const first = await claimLocalStepSweep(
		database,
		(options.newChain ?? newChainId)(),
		handOn,
		new Date()
	);

	if (first === undefined) {
		return { kind: 'held-elsewhere' };
	}

	return send(database, env, first, handOn, options);
}

// A message that could not be sent leaves no chain behind, so the chain ends
// and the next wake or cron tick may start one straight away.
async function send(
	database: Database,
	env: Env,
	next: LocalStepSweepLink,
	handOn: LocalStepSweepHandOn,
	options: LocalStepSweepOptions
): Promise<LocalStepSweepContinuation> {
	const queue = options.queue ?? env.MAINTENANCE_QUEUE;

	try {
		await queue.sendBatch([
			{
				body: { kind: 'local-step-sweep', chain: next },
				delaySeconds: handOn.delaySeconds
			}
		]);
	} catch (error) {
		await endLocalStepSweep(database, next, handOn.outcomes, new Date());
		throw error;
	}

	return {
		kind: 'handed-on',
		next,
		state: handOn.state,
		delaySeconds: handOn.delaySeconds
	};
}

function controlDatabase(env: Env): Database {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function newChainId(): LocalStepSweepChainId {
	return localStepSweepChainIdSchema.parse(crypto.randomUUID());
}
