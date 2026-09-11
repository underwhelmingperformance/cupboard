import {
	DEFAULT_CACHE,
	identityForCache,
	type StoredCache,
	storedCacheSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { eq } from 'drizzle-orm';

import { cacheIdentityColumns } from '../db/cache.ts';
import { firstCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import { chunk } from './bulk.ts';
import { type ServerContext } from './context.ts';

// A lifecycle row binds seven values, so this many rows fit one statement
// within D1's parameter limit.
const projectedRowsPerStatement = 12;

// Insert at most this many rows per invocation. The read and these statements
// together stay far below the invocation's D1 allowance, and a tenant with more
// caches than this finishes over the wakes that follow.
export const maxCachesProjectedPerRun = projectedRowsPerStatement * 3;

export interface CacheProjectionOutcome {
	readonly projected: number;
	readonly hasMore: boolean;
}

/**
 * Writes the missing `cache_lifecycle` rows for this tenant's local caches, up
 * to {@link maxCachesProjectedPerRun} of them per call.
 *
 * The backfill projects a named cache only where a reference or a credential
 * mentions it, so a cache that holds nothing has no row. The control plane and
 * the read paths both consult that table, so a cache missing from it is
 * invisible to them.
 *
 * The work is bounded: one read, then at most {@link maxCachesProjectedPerRun}
 * rows across three statements. A tenant with more caches than that keeps rows
 * to project, and the caller leaves the local step unrecorded so the control
 * plane wakes the object again.
 */
export async function projectLocalCacheLifecycles(
	context: ServerContext,
	tenant: TenantId
): Promise<CacheProjectionOutcome> {
	const local = context.db
		.select({ name: schema.caches.name })
		.from(schema.caches)
		.all()
		.map((row) => row.name);
	const projected = await context.d1
		.select({ cache: d1Schema.cacheLifecycle.cache })
		.from(d1Schema.cacheLifecycle)
		.where(eq(d1Schema.cacheLifecycle.tenant, tenant))
		.all();
	const known = new Set<string>(projected.map((row) => row.cache));
	// The default cache is usually absent from the local table, so add it here
	// rather than relying on that table to name it. A commit does register it
	// locally, and a set drops that repeat: a cache counted twice would spend two
	// of this run's slots on one row.
	const missing: StoredCache[] = [
		...new Set<StoredCache>([
			storedCacheSchema.parse(DEFAULT_CACHE),
			...local
		]).difference(known)
	];
	const now = isoTimestamp(new Date());
	const batches = chunk(
		missing.slice(0, maxCachesProjectedPerRun),
		projectedRowsPerStatement
	);

	for (const batch of batches) {
		await context.d1
			.insert(d1Schema.cacheLifecycle)
			.values(
				batch.map((cache) => {
					const { scope, access } = identityForCache(cache);

					return {
						tenant,
						cache,
						...cacheIdentityColumns(scope),
						access,
						generation: firstCacheGeneration,
						updatedAt: now
					};
				})
			)
			.onConflictDoNothing()
			.run();
	}

	return {
		projected: Math.min(missing.length, maxCachesProjectedPerRun),
		hasMore: missing.length > maxCachesProjectedPerRun
	};
}
