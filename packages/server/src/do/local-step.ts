import {
	currentLocalStep,
	type LocalStep
} from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';

import { reconcileCacheIdentities } from './cache-identity-reconcile.ts';
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
 * Runs what this build's steps require of the object, records the step reached
 * in the tenant's D1 row, and returns it. An object the control plane has not
 * configured yet holds no tenant state to advance; it does nothing and returns
 * undefined.
 *
 * The stored value is a watermark. A build that carries fewer steps than the
 * one that ran before it must not lower what that build recorded, so the update
 * applies only where the stored step is absent or lower. Rerunning it when the
 * row already holds the step writes nothing.
 *
 * The work runs on every call rather than only when the recorded step is
 * lower. Each step reaches the same result whatever state it starts from, so a
 * repeat is harmless, and every statement it runs works on a whole set, so a
 * repeat costs a fixed number of local statements. The control plane stops
 * waking an object once that object has recorded the step.
 */
export async function recordLocalStep(
	context: ServerContext
): Promise<LocalStep | undefined> {
	const tenant = context.tenant();

	if (tenant === undefined) {
		return undefined;
	}

	reconcileCacheIdentities(context.db, isoTimestamp(new Date()));

	await context.d1
		.update(d1Schema.tenant)
		.set({ localStep: currentLocalStep })
		.where(and(eq(d1Schema.tenant.id, tenant), belowCurrentLocalStep))
		.run();

	return currentLocalStep;
}
