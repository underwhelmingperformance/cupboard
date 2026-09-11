import {
	currentLocalStep,
	type LocalStep
} from '@cupboard/protocol/deployment';
import { and, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';

import { type ServerContext } from './context.ts';

/**
 * Matches a tenant row whose object has not recorded the current step. A null
 * step is a tenant that has not run since the column was added.
 */
export const belowCurrentLocalStep: SQL | undefined = or(
	isNull(d1Schema.tenant.localStep),
	lt(d1Schema.tenant.localStep, currentLocalStep)
);

/**
 * Records in the tenant's D1 row the step this object has completed, and
 * returns it. An object the control plane has not configured yet holds no
 * tenant state to advance; it records nothing and returns undefined.
 *
 * The stored value is a watermark. A build that carries fewer steps than the
 * one that ran before it must not lower what that build recorded, so the update
 * applies only where the stored step is absent or lower. Rerunning it when the
 * row already holds the step writes nothing.
 */
export async function recordLocalStep(
	context: ServerContext
): Promise<LocalStep | undefined> {
	const tenant = context.tenant();

	if (tenant === undefined) {
		return undefined;
	}

	await context.d1
		.update(d1Schema.tenant)
		.set({ localStep: currentLocalStep })
		.where(and(eq(d1Schema.tenant.id, tenant), belowCurrentLocalStep))
		.run();

	return currentLocalStep;
}
