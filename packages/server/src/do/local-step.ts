import {
	currentLocalStep,
	type LocalStep
} from '@cupboard/protocol/deployment';
import { and, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';

import { reconcileCacheIdentities } from './cache-identity-reconcile.ts';
import { type ServerContext } from './context.ts';

export type LocalStepOutcome =
	| { readonly kind: 'recorded'; readonly step: LocalStep }
	| { readonly kind: 'unconfigured' }
	| { readonly kind: 'incomplete'; readonly projected: number };

/**
 * Matches a tenant row whose object has not recorded the current step. A null
 * step means it has not been woken since the column was added.
 */
export const belowCurrentLocalStep: SQL | undefined = or(
	isNull(d1Schema.tenant.localStep),
	lt(d1Schema.tenant.localStep, currentLocalStep)
);

/**
 * Runs the work this build's steps require of the object, records the step
 * reached in the tenant's D1 row, and returns it. An object the control plane
 * has not configured yet holds no tenant state to advance; it does nothing and
 * returns an unconfigured outcome.
 *
 * The stored value is a watermark. A build that carries fewer steps than the
 * one that ran before it must not lower what that build recorded, so the update
 * applies only where the stored step is absent or lower. Rerunning it when the
 * row already holds the step writes nothing.
 *
 * The work runs on every call, without reading the recorded step first. A step
 * added here must therefore reach the same state from any starting point, and
 * must bound its statements per call, because the control plane wakes the
 * object again until it records the step.
 */
export async function recordLocalStep(
	context: ServerContext
): Promise<LocalStepOutcome> {
	const tenant = context.tenant();

	if (tenant === undefined) {
		return { kind: 'unconfigured' };
	}

	const backfill = await reconcileCacheIdentities(context);
	if (backfill.hasMore) {
		return { kind: 'incomplete', projected: backfill.processed };
	}

	await context.d1
		.update(d1Schema.tenant)
		.set({ localStep: currentLocalStep })
		.where(and(eq(d1Schema.tenant.id, tenant), belowCurrentLocalStep))
		.run();

	return { kind: 'recorded', step: currentLocalStep };
}
