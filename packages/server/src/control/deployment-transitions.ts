import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type DeploymentTransition,
	type DeploymentTransitionsResponse,
	readTransitionRow,
	schemaTransitions,
	type TransitionId,
	transitionIds
} from '@cupboard/protocol/deployment';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';

/**
 * Returns how far each schema transition has got, in the order that the deploy
 * applies them. The list is empty until a deploy of this release has run.
 *
 * A row whose transition id or state this server version does not define goes
 * in `unrecognised`. A rollback past the release that added the transition
 * leaves such a row. `cupboard deployment status` lists it with what the
 * CLI's own `cupboard deploy` does with it.
 */
export async function controlDeploymentTransitions(
	env: Env
): Promise<DeploymentTransitionsResponse> {
	const database: DrizzleD1Database<typeof d1Schema> = drizzleD1(
		env.CUPBOARD_DB,
		{ schema: d1Schema }
	);
	const rows = await database
		.select()
		.from(d1Schema.deploymentTransition)
		.all();
	const recorded = new Map<TransitionId, DeploymentTransition>();
	const unrecognised: DeploymentTransitionsResponse['unrecognised'] = [];

	for (const row of rows) {
		const reading = readTransitionRow(transitionIds, row);

		if (reading.kind !== 'defined') {
			unrecognised.push({
				id: row.id,
				state: row.state,
				updatedAt: row.updatedAt,
				...(row.contractedAt !== null && { contractedAt: row.contractedAt })
			});
			continue;
		}

		recorded.set(reading.id, {
			id: reading.id,
			state: reading.state,
			updatedAt: row.updatedAt
		});
	}

	return {
		transitions: schemaTransitions.flatMap(
			(transition) => recorded.get(transition.id) ?? []
		),
		unrecognised: unrecognised.toSorted((left, right) =>
			byCodeUnit(left.id, right.id)
		)
	};
}
