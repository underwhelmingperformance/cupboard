import {
	currentLocalStep,
	type LocalStep
} from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';

import { reconcileCacheIdentities } from './cache-identity-reconcile.ts';
import { projectLocalCacheLifecycles } from './cache-lifecycle-projection.ts';
import { type ServerContext } from './context.ts';
import {
	type LegacyObjectFamily,
	moveLegacyPrivateObjects
} from './legacy-object-move.ts';

/**
 * Matches a tenant row whose object has not recorded the current step. A null
 * step is a tenant that has not run since the column was added.
 */
export const belowCurrentLocalStep: SQL | undefined = or(
	isNull(d1Schema.tenant.localStep),
	lt(d1Schema.tenant.localStep, currentLocalStep)
);

/**
 * The result of one `recordLocalStep` call. `unconfigured` and `incomplete`
 * both leave the recorded step where it was, so the control plane wakes the
 * object again, but they mean different things: `unconfigured` is a tenant
 * whose create failed part way through, and `incomplete` is ordinary progress
 * with work still to do.
 */
export type LocalStepOutcome =
	| { readonly kind: 'recorded'; readonly step: LocalStep }
	| { readonly kind: 'unconfigured' }
	| { readonly kind: 'incomplete'; readonly projected: number };

/**
 * Runs what this build's steps require of the object and records the step it
 * reached in the tenant's D1 row.
 *
 * An object the control plane has not configured yet holds no tenant state to
 * advance, and an object whose work does not fit one invocation has not
 * reached the step. In both cases the recorded step stays where it was.
 *
 * The stored value is a watermark. A build that carries fewer steps than the
 * one that ran before it must not lower what that build recorded, so the update
 * applies only where the stored step is absent or lower. Rerunning it when the
 * row already holds the step writes nothing.
 *
 * The work runs on every call rather than only when the recorded step is
 * lower. Each step reaches the same result whatever state it starts from, so a
 * repeat is harmless, and a step that cannot finish within one invocation
 * reports `incomplete` instead of carrying on, so a repeat costs a bounded
 * number of local and D1 statements. The control plane stops waking an object
 * once that object has recorded the step.
 */
export async function recordLocalStep(
	context: ServerContext,
	families: readonly LegacyObjectFamily[]
): Promise<LocalStepOutcome> {
	const tenant = context.tenant();

	if (tenant === undefined) {
		return { kind: 'unconfigured' };
	}

	reconcileCacheIdentities(context.db, isoTimestamp(new Date()));

	const projection = await projectLocalCacheLifecycles(context, tenant);

	if (projection.hasMore) {
		return { kind: 'incomplete', projected: projection.projected };
	}

	const move = await moveLegacyPrivateObjects(context, tenant, families);

	if (move.hasMore) {
		return { kind: 'incomplete', projected: move.moved };
	}

	await context.d1
		.update(d1Schema.tenant)
		.set({ localStep: currentLocalStep })
		.where(and(eq(d1Schema.tenant.id, tenant), belowCurrentLocalStep))
		.run();

	return { kind: 'recorded', step: currentLocalStep };
}
