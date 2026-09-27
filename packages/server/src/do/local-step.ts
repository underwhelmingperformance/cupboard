import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStep,
	localStepSchema
} from '@cupboard/protocol/deployment';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import { recordLocalStepAttempt } from '../db/local-step-attempts.ts';
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
 * The step that a page recorded when the tenant row already had it. A page that
 * raises the step deletes the key.
 */
export const repeatedRecordingKey = 'local-step:repeated-recording';

/**
 * The required local step that the last wake asked this object to record. The
 * `local-step` maintenance pass runs pages while the key is present.
 */
export const localStepPendingKey = 'local-step:pending';

/**
 * When the current run of pages without progress began. A page that
 * progresses deletes the key.
 */
export const localStepStalledSinceKey = 'local-step:stalled-since';

/**
 * The result of one page of local-step work. `unconfigured` is a tenant whose
 * create failed part way through, so the object has no tenant row to update.
 * `incomplete` is a page that left work to do. `failed` is a page that threw;
 * `error` summarises the error.
 *
 * `projected` counts the caches projected, the objects moved, or the rows
 * rewritten in a full batch of a retention or grant migration. `progressed` is
 * whether the page moved the object's durable state forward. An `incomplete`
 * page progressed when it committed a migration, completed a batch, projected
 * or moved an item, or saved a cursor, so it can progress with `projected` at
 * zero, for example when it only moved a cursor past prefixes that contain no
 * objects to move. A `recorded` page progressed when it raised the recorded
 * step or projected or moved an item.
 *
 * After a step is recorded, the projection and the object moves start again
 * and save their cursors again. Once a page has recorded the same step that
 * the tenant already had, those cursor saves are therefore not progress while
 * the requested step is not higher than that step: only an item projected or
 * moved counts. A request for a higher step counts them again, because the
 * pages then work towards a step that the tenant has not reached.
 */
export type LocalStepOutcome =
	| {
			readonly kind: 'recorded';
			readonly step: LocalStep;
			readonly progressed: boolean;
	  }
	| { readonly kind: 'unconfigured' }
	| {
			readonly kind: 'incomplete';
			readonly projected: number;
			readonly progressed: boolean;
	  }
	| { readonly kind: 'failed'; readonly error: string };

/**
 * The step that the tenant's row records, or undefined when it records none.
 */
export async function readRecordedLocalStep(
	context: ServerContext
): Promise<LocalStep | undefined> {
	const tenant = context.tenant();

	if (tenant === undefined) {
		return undefined;
	}

	const row = await context.d1
		.select({ localStep: d1Schema.tenant.localStep })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, tenant))
		.get();

	return row?.localStep ?? undefined;
}

/**
 * Runs one page of the work this build's steps require of the object. When no
 * work remains, records the step that the object reached in the tenant's D1
 * row, together with the attempt at `attemptedAt`, in one batch. The attempt
 * clears the attempt time when the step satisfies `requested`.
 *
 * An object that the control plane has not configured yet has no tenant state
 * to advance, and an object whose work does not fit one page has not reached
 * the step. In both cases the recorded step stays where it was.
 *
 * The stored value is a watermark. A build that has fewer steps than the one
 * that ran before it must not lower what that build recorded, so the update
 * applies only where the stored step is absent or lower. Rerunning it when the
 * row already contains the step writes only the attempt.
 *
 * The work runs on every call, without reading the recorded step first. A step
 * added here must reach the same state from any starting point, and must bound
 * its D1 and R2 calls, reporting `incomplete` when work remains, because the
 * object runs further pages until it records the step. `requested` is the step
 * that the pending request asks for, or undefined when the object cannot read
 * the request.
 */
export async function recordLocalStep(
	context: ServerContext,
	families: readonly ObjectFamily[],
	attemptedAt: IsoTimestamp,
	requested: LocalStep | undefined
): Promise<LocalStepOutcome> {
	const tenant = context.tenant();

	if (tenant === undefined) {
		return { kind: 'unconfigured' };
	}

	const repeated = localStepSchema.safeParse(
		await context.ctx.storage.get(repeatedRecordingKey)
	);
	const isRepeating =
		repeated.success && (requested === undefined || requested <= repeated.data);
	// Whether the stages that ran moved the object forward: an item projected or
	// moved, or a saved cursor while the stages are not repeating.
	const hasProgressed = (
		items: number,
		...cursors: readonly boolean[]
	): boolean => items > 0 || (!isRepeating && cursors.includes(true));
	const projection = await projectLocalCacheLifecycles(context, tenant);

	if (projection.hasMore) {
		return {
			kind: 'incomplete',
			projected: projection.projected,
			progressed: hasProgressed(projection.projected, projection.progressed)
		};
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
		return {
			kind: 'incomplete',
			projected: legacyMove.moved,
			progressed: hasProgressed(
				projection.projected + legacyMove.moved,
				projection.progressed,
				legacyMove.progressed
			)
		};
	}

	const incarnationMove = await moveObjectsToCacheIncarnation(
		context,
		tenant,
		families
	);

	if (incarnationMove.hasMore) {
		return {
			kind: 'incomplete',
			projected: incarnationMove.moved,
			progressed: hasProgressed(
				projection.projected + legacyMove.moved + incarnationMove.moved,
				projection.progressed,
				legacyMove.progressed,
				incarnationMove.progressed
			)
		};
	}

	const retention = await context.criticalSection(() =>
		advanceCacheRetentionMigration(context.db)
	);

	// The retention and grant migrations report more to do only after they have
	// rewritten a full batch.
	if (retention.status === 'pending') {
		return {
			kind: 'incomplete',
			projected: retentionMigrationBatchSize,
			progressed: true
		};
	}

	await context.transitions.refresh();
	const isContracted = await context.transitions.hasReached(
		'cache-identity',
		'complete'
	);
	if (isContracted && contractCacheGrants(context).status === 'pending') {
		return {
			kind: 'incomplete',
			projected: grantContractionBatchSize,
			progressed: true
		};
	}
	// This mapping covers only `cache-identity`, whose contract step is
	// `expansionLocalStep`. A later transition that declares a contract step
	// needs its own branch here, or objects never report that step.
	const reached = isContracted ? currentLocalStep : expansionLocalStep;
	const moved = projection.projected + legacyMove.moved + incarnationMove.moved;
	const belowReached = and(
		eq(d1Schema.tenant.id, tenant),
		belowLocalStep(reached)
	);
	const raise = context.d1
		.update(d1Schema.tenant)
		.set({ localStep: reached, localStepProgressedAt: attemptedAt })
		.where(belowReached)
		.returning({ id: d1Schema.tenant.id });
	// A step below the requested one leaves the object working, so the page
	// keeps its attempt time.
	const isSatisfied = requested === undefined || reached >= requested;
	const attempt = recordLocalStepAttempt(
		context.d1,
		tenant,
		isSatisfied
			? { kind: 'finished', at: attemptedAt, progressed: moved > 0 }
			: { kind: moved > 0 ? 'progressed' : 'unchanged', at: attemptedAt }
	);

	const [raised] = await context.d1.batch([raise, attempt]);

	const isRaised = raised.length > 0;

	await Promise.all([
		resetCacheLifecycleProjection(context),
		resetObjectMoves(context),
		isRaised
			? context.ctx.storage.delete(repeatedRecordingKey)
			: context.ctx.storage.put(repeatedRecordingKey, reached)
	]);
	return {
		kind: 'recorded',
		step: reached,
		progressed: isRaised || moved > 0
	};
}
