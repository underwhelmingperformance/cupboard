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

// How long the gate answers from the states it last read. Reading on every
// request would add a D1 statement to each one; a longer interval delays the
// object's response to a newly recorded transition by that much.
export const transitionCacheMs = 60_000;

/**
 * Reads how far each schema transition has got, and answers from that reading
 * for `transitionCacheMs`. Answering from a stale reading is safe only while
 * what the gate chooses between is read either way: a stored grant is read in
 * either spelling. That holds for every state this gate distinguishes.
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
	Refreshes the states before advancing irreversible local work.
	*/
	async refresh(): Promise<void> {
		this.cached = await this.read();
		this.readAt = this.now();
	}

	/**
	 * Whether the transition has reached the state, reading the rows again once
	 * the last reading is older than `transitionCacheMs`. A stored id or state
	 * this build does not define is treated as nothing recorded: a later release
	 * recorded it, and this build has no behaviour for it.
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
