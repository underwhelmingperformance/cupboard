import {
	type LocalStep,
	localStepSchema,
	localStepStallWindowMs
} from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { z } from 'zod';

import {
	type LocalStepAttempt,
	recordLocalStepAttempt
} from '../db/local-step-attempts.ts';

import { type ServerContext } from './context.ts';
import {
	type LocalStepOutcome,
	localStepPendingKey,
	localStepStalledSinceKey
} from './local-step.ts';

/**
 * The shortest interval between two writes of a page that made progress and
 * left work to do. The instance keeps the time of the last such write in
 * memory, so after a failed page, a page without progress, a recorded step or
 * a restart, the next page that made progress is written at once.
 * The status classes use a window of `localStepStallWindowMs`, so a progress
 * time that is up to this old can make a working tenant read as stalled at
 * most this much earlier.
 */
export const localStepProgressWriteIntervalMs = 30_000;

/**
 * What follows a page of local-step work.
 *
 * - `done`: the page recorded the step that the last wake asked for, or the
 *   object is not configured. No page follows.
 * - `progressed`: the next page is due at once.
 * - `stalled`: the page made no progress, and the next page is due after the
 *   maintenance retry delay.
 * - `given-up`: no page has made progress for `localStepStallWindowMs`. No
 *   page follows until the next wake.
 */
export type LocalStepContinuation =
	'done' | 'progressed' | 'stalled' | 'given-up';

const stalledSinceSchema = z.number().int().nonnegative();

/**
 * The error that the tenant row records when the object stops retrying after
 * pages that made no progress and did not fail. The row then states why the
 * work stopped.
 */
export const localStepGaveUpError = `gave up after ${String(localStepStallWindowMs / 60_000)} minutes without progress`;

/**
 * The object's local-step work between a wake and the recorded step: whether
 * a wake is pending, since when the pages have made no progress, and the
 * attempts that the object writes to its tenant row.
 */
export class LocalStepRun {
	// When this instance last wrote a progress attempt. An evicted instance
	// starts without it and writes its first progress attempt at once.
	private progressWrittenAt: number | undefined;

	constructor(private readonly context: ServerContext) {}

	// A recorded page is done once its step reaches the step that the wake asked
	// for. When this build cannot read the request, any recorded page ends the
	// run.
	private async isDone(outcome: LocalStepOutcome): Promise<boolean> {
		if (outcome.kind !== 'recorded') {
			return false;
		}

		const wanted = localStepSchema.safeParse(
			await this.context.ctx.storage.get(localStepPendingKey)
		);

		return !wanted.success || outcome.step >= wanted.data;
	}

	/**
	 * Records that a wake asked for `required`. The give-up window starts
	 * again, so every wake gets `localStepStallWindowMs` of retries.
	 */
	async request(required: LocalStep): Promise<void> {
		const { storage } = this.context.ctx;

		await storage.put(localStepPendingKey, required);
		await storage.delete(localStepStalledSinceKey);
	}

	/**
	 * The step that the pending request asks for, or undefined when there is no
	 * request or this build cannot read it.
	 */
	async requested(): Promise<LocalStep | undefined> {
		const wanted = localStepSchema.safeParse(
			await this.context.ctx.storage.get(localStepPendingKey)
		);

		return wanted.success ? wanted.data : undefined;
	}

	async isPending(): Promise<boolean> {
		return (
			(await this.context.ctx.storage.get(localStepPendingKey)) !== undefined
		);
	}

	/**
	 * Updates the pending wake and the start of the run of pages without
	 * progress after a page, and returns what follows the page.
	 */
	async settle(
		outcome: LocalStepOutcome,
		now: number
	): Promise<LocalStepContinuation> {
		const { storage } = this.context.ctx;

		if (outcome.kind === 'unconfigured' || (await this.isDone(outcome))) {
			await storage.delete([localStepPendingKey, localStepStalledSinceKey]);

			return 'done';
		}

		if (outcome.kind !== 'failed' && outcome.progressed) {
			await storage.delete(localStepStalledSinceKey);

			return 'progressed';
		}

		const stored = stalledSinceSchema.safeParse(
			await storage.get(localStepStalledSinceKey)
		);

		if (!stored.success) {
			await storage.put(localStepStalledSinceKey, now);

			return 'stalled';
		}

		if (now - stored.data < localStepStallWindowMs) {
			return 'stalled';
		}

		await storage.delete([localStepPendingKey, localStepStalledSinceKey]);

		return 'given-up';
	}

	/**
	 * Writes the page's attempt to the tenant row. A page that recorded a step
	 * wrote its attempt in the same batch, and an unconfigured object has no
	 * tenant row. A page that made progress and left work to do is written at
	 * most once every `localStepProgressWriteIntervalMs`; a page without
	 * progress and a failed page are always written. When the object gives up
	 * after a page that did not fail, the attempt records
	 * `localStepGaveUpError`.
	 */
	async recordAttempt(
		outcome: LocalStepOutcome,
		now: number,
		continuation: LocalStepContinuation
	): Promise<void> {
		if (outcome.kind === 'unconfigured') {
			return;
		}

		if (outcome.kind === 'recorded') {
			this.progressWrittenAt = undefined;

			return;
		}

		const isProgress = outcome.kind === 'incomplete' && outcome.progressed;

		if (
			isProgress &&
			this.progressWrittenAt !== undefined &&
			now - this.progressWrittenAt < localStepProgressWriteIntervalMs
		) {
			return;
		}

		const tenant = this.context.tenant();

		if (tenant === undefined) {
			return;
		}

		const at = isoTimestamp(new Date(now));
		const attempt: LocalStepAttempt =
			outcome.kind === 'failed'
				? { kind: 'failed', at, error: outcome.error }
				: continuation === 'given-up'
					? { kind: 'failed', at, error: localStepGaveUpError }
					: { kind: isProgress ? 'progressed' : 'unchanged', at };

		this.progressWrittenAt = undefined;
		await recordLocalStepAttempt(this.context.d1, tenant, attempt).run();

		if (isProgress) {
			this.progressWrittenAt = now;
		}
	}
}
