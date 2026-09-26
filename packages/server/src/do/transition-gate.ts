import {
	hasReachedTransitionState,
	type TransitionId,
	type TransitionState
} from '@cupboard/protocol/deployment';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import {
	readRecordedTransitions,
	type RecordedTransitions
} from '../db/deployment-transitions.ts';
import { readWithOneRetry } from '../db/transient.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

// How long the gate uses the states that it last read. Reading on every
// request would add a D1 statement to each one.
//
// An object can use its previous reading for up to this interval after a
// deploy records a new state.
export const transitionCacheMs = 60_000;

/**
 * Reads how far each schema transition has got, and returns results from that
 * reading for `transitionCacheMs`. A stale result is safe for choosing a grant
 * spelling, because readers accept both spellings. A caller that makes an
 * irreversible decision, such as reporting step 5 or allowing an access
 * change, calls `refresh()` first.
 *
 * The gate reads only `deployment_transition`. `cupboard deploy` reconciles
 * those rows with the `deployment_phase` row of v0.0.34 and v0.0.35 and
 * writes them before it uploads this build's Workers.
 */
export class TransitionGate {
	private cached: RecordedTransitions = new Map();
	private readAt = -Infinity;

	constructor(
		private readonly d1: DrizzleD1Database<typeof d1Schema>,
		private readonly now: () => number = () => Date.now()
	) {}

	private async read(): Promise<RecordedTransitions> {
		try {
			return await readWithOneRetry(() => readRecordedTransitions(this.d1));
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	/**
	Reads the states again. Call it before starting irreversible local work.
	*/
	async refresh(): Promise<void> {
		this.cached = await this.read();
		this.readAt = this.now();
	}

	/**
	 * Whether the transition has reached the state, reading the rows again once
	 * the last reading is older than `transitionCacheMs`. `recordedTransitions`
	 * describes how rows that this build does not define are read.
	 */
	async hasReached(id: TransitionId, state: TransitionState): Promise<boolean> {
		const moment = this.now();

		if (moment - this.readAt >= transitionCacheMs) {
			this.cached = await this.read();
			this.readAt = moment;
		}

		return hasReachedTransitionState(this.cached.get(id), state);
	}
}
