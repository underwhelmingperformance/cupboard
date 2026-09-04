import {
	type DeploymentPhaseResponse,
	deploymentPhaseRowId,
	deploymentPhaseSchema
} from '@cupboard/protocol/deployment';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { StoredDeploymentPhaseInvalidError } from '../errors.ts';

/**
 * Returns the phase the deployed build runs in. A deployment set up before
 * phases existed has no phase row, and the phase is then absent.
 *
 * If the stored phase name is not one of the phases this server version
 * defines, this returns an error. That happens after a rollback past a release
 * that added a phase, and this version has no behaviour for such a phase.
 */
export async function controlDeploymentPhase(
	env: Env
): Promise<DeploymentPhaseResponse> {
	const database: DrizzleD1Database<typeof d1Schema> = drizzleD1(
		env.CUPBOARD_DB,
		{ schema: d1Schema }
	);
	const row = await database
		.select({
			name: d1Schema.deploymentPhase.phase,
			requiredLocalStep: d1Schema.deploymentPhase.requiredLocalStep,
			updatedAt: d1Schema.deploymentPhase.updatedAt
		})
		.from(d1Schema.deploymentPhase)
		.where(eq(d1Schema.deploymentPhase.id, deploymentPhaseRowId))
		.get();

	if (row === undefined) {
		return {};
	}

	const parsed = deploymentPhaseSchema.safeParse(row);

	if (!parsed.success) {
		throw new StoredDeploymentPhaseInvalidError(row.name, parsed.error);
	}

	return { phase: parsed.data };
}
