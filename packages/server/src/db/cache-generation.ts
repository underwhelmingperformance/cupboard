import {
	type CacheGeneration,
	cacheGenerationSchema,
	type CacheReadRevision,
	cacheReadRevisionSchema,
	type CacheScope,
	firstCacheGeneration,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { and, eq, isNull, not, or, type SQL, sql } from 'drizzle-orm';

import { cacheIdentityCondition } from './cache.ts';
import * as d1Schema from './d1-schema.ts';

/**
 * The generation written when a deletion first creates a cache's lifecycle
 * row.
 */
export const secondCacheGeneration = cacheGenerationSchema.parse(
	firstCacheGeneration + 1
);

/**
 * The read revision a cache starts at, and the one a reader assumes for a cache
 * with no lifecycle row.
 */
export const firstCacheReadRevision = cacheReadRevisionSchema.parse(1);

/**
 * The read revision written when a deletion first creates a cache's lifecycle
 * row.
 */
export const secondCacheReadRevision = cacheReadRevisionSchema.parse(
	firstCacheReadRevision + 1
);

/**
 * Which incarnation of a cache name a reader is addressing, and which version
 * of that cache's access. The lifecycle row is authoritative for both, and a
 * registration returns the pair it published.
 */
export interface CacheLifecycleVersion {
	readonly generation: CacheGeneration;
	readonly readRevision: CacheReadRevision;
}

// A cache with no lifecycle row counts as the first generation. Migration
// `0024_cache_access_backfill` gave every cache one, so this covers a row a
// later insert has not reached rather than the ordinary case.
const currentGeneration = sql`coalesce(${d1Schema.cacheLifecycle.generation}, ${firstCacheGeneration})`;

/**
 * Joins each `blob_ref` row to the lifecycle row for the same tenant and cache
 * identity. {@link authorisedByCacheGeneration} and
 * {@link revokedByCacheGeneration} rely on this join.
 *
 * Migration `0024_cache_access_backfill` gave every cache appearing in
 * `blob_ref`, `attestation_ref` or a read credential a lifecycle row, so an
 * inner join over `blob_ref` drops no edge. `narInfoReferenceQuery` and
 * `queueRevokedCacheEdges` still use `leftJoin`, which is equivalent here and
 * tolerates a row a later insert has not reached.
 */
export function referencedCacheLifecycle(): SQL | undefined {
	const sameTenant = eq(
		d1Schema.cacheLifecycle.tenant,
		d1Schema.blobReference.tenant
	);
	const sameKind = eq(
		d1Schema.cacheLifecycle.cacheKind,
		d1Schema.blobReference.cacheKind
	);
	const defaultCache = eq(d1Schema.blobReference.cacheKind, 'default');
	const defaultLifecycle = isNull(d1Schema.cacheLifecycle.cacheName);
	const defaultReference = isNull(d1Schema.blobReference.cacheName);
	const namedCache = eq(d1Schema.blobReference.cacheKind, 'named');
	const sameName = eq(
		d1Schema.cacheLifecycle.cacheName,
		d1Schema.blobReference.cacheName
	);
	const sameDefaultCache = and(
		defaultCache,
		defaultLifecycle,
		defaultReference
	);
	const sameNamedCache = and(namedCache, sameName);

	return and(sameTenant, sameKind, or(sameDefaultCache, sameNamedCache));
}

/**
 * Matches a `blob_ref` row authorised by the cache's current generation.
 *
 * The statement must left join `cache_lifecycle` to `blob_ref` on
 * {@link referencedCacheLifecycle}.
 */
export function authorisedByCacheGeneration(): SQL {
	return sql`${d1Schema.blobReference.cacheGeneration} = ${currentGeneration}`;
}

/**
 * Matches a `blob_ref` row left by a deleted cache. A later cache with the same
 * name uses the generation created by the deletion, so retiring the old row
 * cannot affect the later cache's reference edges.
 *
 * The same join requirement as {@link authorisedByCacheGeneration} applies.
 */
export function revokedByCacheGeneration(): SQL {
	return not(authorisedByCacheGeneration());
}

/**
 * Returns the current generation for a statement that inserts a `blob_ref`
 * row. Keeping the subquery inside the insert makes reading the generation and
 * creating the edge one D1 statement.
 */
export function currentCacheGeneration(
	tenant: TenantId,
	cache: CacheScope
): SQL<CacheGeneration> {
	const identity = cacheIdentityCondition(
		d1Schema.cacheLifecycle.cacheKind,
		d1Schema.cacheLifecycle.cacheName,
		cache
	);

	return sql<CacheGeneration>`coalesce((select ${d1Schema.cacheLifecycle.generation} from ${d1Schema.cacheLifecycle} where ${d1Schema.cacheLifecycle.tenant} = ${tenant} and ${identity}), ${firstCacheGeneration})`;
}
