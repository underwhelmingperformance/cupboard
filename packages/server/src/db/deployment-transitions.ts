import {
	type TransitionId,
	transitionIdSchema,
	type TransitionState,
	transitionStateSchema
} from '@cupboard/protocol/deployment';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from './d1-schema.ts';

export type RecordedTransitions = ReadonlyMap<TransitionId, TransitionState>;

export interface DeploymentTransitionRow {
	readonly id: string;
	readonly state: string;
}

/**
 * The transition states this build defines, from the rows the deploy
 * recorded. A row this build does not define, whether its id or its state, is
 * left out: a later release recorded it, and this build has no behaviour for
 * it, so it gates as if nothing were recorded.
 */
export function recordedTransitions(
	rows: readonly DeploymentTransitionRow[]
): RecordedTransitions {
	const recorded = new Map<TransitionId, TransitionState>();

	for (const row of rows) {
		const id = transitionIdSchema.safeParse(row.id);
		const state = transitionStateSchema.safeParse(row.state);

		if (!id.success || !state.success) {
			continue;
		}

		recorded.set(id.data, state.data);
	}

	return recorded;
}

export async function readRecordedTransitions(
	database: DrizzleD1Database<typeof d1Schema>
): Promise<RecordedTransitions> {
	const rows = await database
		.select({
			id: d1Schema.deploymentTransition.id,
			state: d1Schema.deploymentTransition.state
		})
		.from(d1Schema.deploymentTransition)
		.all();

	return recordedTransitions(rows);
}
