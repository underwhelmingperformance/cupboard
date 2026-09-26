import {
	readTransitionRow,
	type TransitionId,
	transitionIdSchema,
	type TransitionState
} from '@cupboard/protocol/deployment';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from './d1-schema.ts';

export type RecordedTransitions = ReadonlyMap<TransitionId, TransitionState>;

export interface DeploymentTransitionRow {
	readonly id: string;
	readonly state: string;
}

/**
 * The transition states that this build defines, read from the rows that the
 * deploy recorded. A later release's deploy can write two kinds of row that
 * this build does not define. A row with an unknown id is left out, because
 * this build does not handle that transition. A row with a known id and an
 * unknown state counts as `complete`: a later release may only append states
 * after `complete`, so the transition has at least completed. Treating it as
 * incomplete would make the Workers write the grant format from before the
 * contract migrations, which those migrations reject.
 */
export function recordedTransitions(
	rows: readonly DeploymentTransitionRow[]
): RecordedTransitions {
	return new Map(
		rows.flatMap((row): [TransitionId, TransitionState][] => {
			const reading = readTransitionRow(transitionIdSchema.options, row);

			switch (reading.kind) {
				case 'defined': {
					return [[reading.id, reading.state]];
				}

				case 'unknown-state': {
					return [[reading.id, 'complete']];
				}

				case 'unknown-transition': {
					return [];
				}
			}
		})
	);
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
