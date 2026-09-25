import {
	type DeploymentTransition,
	deploymentTransitionSchema,
	type DeploymentTransitionsResponse,
	requiredLocalStepFrom,
	schemaTransitions,
	type TransitionId,
	type TransitionState
} from '@cupboard/protocol/deployment';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { StoredDeploymentTransitionInvalidError } from '../errors.ts';

/**
 * Returns how far each schema transition has got, in the order the deploy
 * walks them, and the local step they require of every active tenant now. A
 * deployment no deploy of this release has run against has recorded none.
 *
 * A stored transition id or state that this server version does not define
 * makes this throw. That is what a rollback past a release that added one
 * leaves behind, and this version has no behaviour for it.
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
	const states = new Map<TransitionId, TransitionState>();

	for (const row of rows) {
		const parsed = deploymentTransitionSchema.safeParse(row);

		if (!parsed.success) {
			throw new StoredDeploymentTransitionInvalidError(
				row.id,
				row.state,
				parsed.error
			);
		}

		recorded.set(parsed.data.id, parsed.data);
		states.set(parsed.data.id, parsed.data.state);
	}

	return {
		transitions: schemaTransitions.flatMap(
			(transition) => recorded.get(transition.id) ?? []
		),
		requiredLocalStep: requiredLocalStepFrom(states)
	};
}
