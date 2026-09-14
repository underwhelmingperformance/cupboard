import { identityForCache, type TenantId } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { cacheIdentityColumns } from '../db/cache.ts';
import { firstCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import { chunk } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { jsonValueLists } from './json-list.ts';

const projectionProgressKey = 'migration/lifecycle-projection/v1';
const progressSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('pending'), afterName: z.string() }),
	z.object({ status: z.literal('complete') })
]);

export async function resetCacheLifecycleProjection(
	context: ServerContext
): Promise<void> {
	await context.ctx.storage.delete(projectionProgressKey);
}

// A lifecycle row binds at most six values, so twelve rows stay within the 100
// bound parameters D1 accepts.
const projectedRowsPerStatement = 12;

// Rows inserted per wake, in three statements. With the read before them and
// the step's own update of `tenant.local_step`, a wake spends at most five D1
// statements. A tenant with more caches finishes over the wakes that follow.
export const maxCachesProjectedPerRun = projectedRowsPerStatement * 3;

export interface CacheProjectionOutcome {
	readonly projected: number;
	readonly hasMore: boolean;
}

/**
 * Writes the missing `cache_lifecycle` rows for this tenant's local caches, up
 * to {@link maxCachesProjectedPerRun} of them per call.
 *
 * The D1 backfill wrote a row for a named cache only where a reference or a
 * credential mentioned it, and registering a cache writes none, so a cache
 * that holds nothing has no row. A missing row reads as a live cache at
 * generation 1, but a release that reads a cache's access from this table
 * needs every cache to have one.
 *
 * A tenant with more caches than fit one call keeps rows to project. The
 * caller then leaves the local step unrecorded, so the control plane wakes
 * the object again.
 */
export async function projectLocalCacheLifecycles(
	context: ServerContext,
	tenant: TenantId
): Promise<CacheProjectionOutcome> {
	const stored = await context.ctx.storage.get(projectionProgressKey);
	const progress =
		stored === undefined ? undefined : progressSchema.parse(stored);
	if (progress?.status === 'complete') {
		return { projected: 0, hasMore: false };
	}
	const local = context.db
		.select({ name: schema.caches.name })
		.from(schema.caches)
		.where(
			progress === undefined
				? undefined
				: sql`${schema.caches.name} > ${progress.afterName}`
		)
		.orderBy(schema.caches.name)
		.limit(maxCachesProjectedPerRun)
		.all()
		.map((row) => row.name);
	const known = new Set<string>();
	for (const listed of jsonValueLists(local)) {
		const projected = await context.d1
			.select({ cache: d1Schema.cacheLifecycle.cache })
			.from(d1Schema.cacheLifecycle)
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					inArray(d1Schema.cacheLifecycle.cache, listed)
				)
			)
			.all();
		for (const row of projected) {
			known.add(row.cache);
		}
	}
	const missing = local.filter((cache) => !known.has(cache));
	const now = isoTimestamp(new Date());
	const batches = chunk(
		missing.slice(0, maxCachesProjectedPerRun),
		projectedRowsPerStatement
	);

	for (const batch of batches) {
		await context.d1
			.insert(d1Schema.cacheLifecycle)
			.values(
				// `access` is omitted so the D1 insert trigger fills it from the
				// tenant's read mode, as the backfill did for the rows it wrote.
				batch.map((cache) => ({
					tenant,
					cache,
					...cacheIdentityColumns(identityForCache(cache).scope),
					generation: firstCacheGeneration,
					updatedAt: now
				}))
			)
			.onConflictDoNothing()
			.run();
	}

	const last = local.at(-1);
	const hasMore = local.length === maxCachesProjectedPerRun;
	await context.ctx.storage.put(
		projectionProgressKey,
		last !== undefined && hasMore
			? { status: 'pending', afterName: last }
			: { status: 'complete' }
	);
	return { projected: missing.length, hasMore };
}
