import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStep
} from '@cupboard/protocol/deployment';
import { and, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import {
	contractCacheGrants,
	grantContractionBatchSize
} from '../migration/cache-grants.ts';
import {
	advanceCacheRetentionMigration,
	retentionMigrationBatchSize
} from '../migration/cache-retention.ts';

import {
	projectLocalCacheLifecycles,
	resetCacheLifecycleProjection
} from './cache-lifecycle-projection.ts';
import { type ServerContext } from './context.ts';
import {
	moveLegacyPrivateObjects,
	moveObjectsToCacheIncarnation,
	type ObjectFamily,
	resetObjectMoves
} from './object-move.ts';

/**
 * Matches a tenant row whose object has not recorded `step`. A null step means
 * it has not been woken since the column was added.
 */
export function belowLocalStep(step: LocalStep): SQL | undefined {
	return or(
		isNull(d1Schema.tenant.localStep),
		lt(d1Schema.tenant.localStep, step)
	);
}

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
 * Runs the work this build's steps require of the object and records the step
 * it reached in the tenant's D1 row.
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
 * The work runs on every call, without reading the recorded step first. A step
 * added here must reach the same state from any starting point, and must bound
 * its D1 and R2 calls, reporting `incomplete` when work remains, because
 * the control plane wakes the object again until it records the step.
 */
export async function recordLocalStep(
	context: ServerContext,
	families: readonly ObjectFamily[]
): Promise<LocalStepOutcome> {
	const tenant = context.tenant();

	if (tenant === undefined) {
		return { kind: 'unconfigured' };
	}

	const projection = await projectLocalCacheLifecycles(context, tenant);

	if (projection.hasMore) {
		return { kind: 'incomplete', projected: projection.projected };
	}

	for (const lifecycle of projection.lifecycles) {
		if (!lifecycle.isLive) {
			continue;
		}

		const cache = context.cacheRepository.resolve(lifecycle.scope);

		if (cache !== undefined && cache.generation < lifecycle.generation) {
			context.cacheRepository.stampGeneration(cache, lifecycle.generation);
		}
	}

	const legacyMove = await moveLegacyPrivateObjects(context, tenant, families);

	if (legacyMove.hasMore) {
		return { kind: 'incomplete', projected: legacyMove.moved };
	}

	const incarnationMove = await moveObjectsToCacheIncarnation(
		context,
		tenant,
		families
	);

	if (incarnationMove.hasMore) {
		return { kind: 'incomplete', projected: incarnationMove.moved };
	}

	const retention = await context.criticalSection(() =>
		advanceCacheRetentionMigration(context.db)
	);

	if (retention.status === 'pending') {
		return { kind: 'incomplete', projected: retentionMigrationBatchSize };
	}

	await context.transitions.refresh();
	const isContracted = await context.transitions.hasReached(
		'cache-identity',
		'complete'
	);
	if (isContracted && contractCacheGrants(context).status === 'pending') {
		return { kind: 'incomplete', projected: grantContractionBatchSize };
	}
	const reached = isContracted ? currentLocalStep : expansionLocalStep;

	await context.d1
		.update(d1Schema.tenant)
		.set({ localStep: reached })
		.where(and(eq(d1Schema.tenant.id, tenant), belowLocalStep(reached)))
		.run();

	await Promise.all([
		resetCacheLifecycleProjection(context),
		resetObjectMoves(context)
	]);
	return { kind: 'recorded', step: reached };
}
