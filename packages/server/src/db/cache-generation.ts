import {
	type CacheGeneration,
	cacheGenerationSchema,
	type CacheReadRevision,
	cacheReadRevisionSchema,
	type CacheScope,
	firstCacheGeneration,
	type NarInfoGeneration,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import {
	and,
	eq,
	getTableName,
	isNull,
	not,
	or,
	type SQL,
	sql
} from 'drizzle-orm';
import { type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

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
 * The generation and read revision recorded in a cache's lifecycle row.
 * Registration returns the values after updating that row.
 */
export interface CacheLifecycleVersion {
	readonly generation: CacheGeneration;
	readonly readRevision: CacheReadRevision;
}

// A cache with no lifecycle row counts as the first generation. Migration
// `0024_cache_access_backfill` gave a row to every cache with an edge.
// Registration and projection cover caches that held nothing at the backfill.
const currentGeneration = sql`coalesce(${d1Schema.cacheLifecycle.generation}, ${firstCacheGeneration})`;

/**
 * Joins each `blob_ref_storage` row to the lifecycle row for the same tenant and cache
 * identity. {@link authorisedByCacheGeneration} and
 * {@link revokedByCacheGeneration} rely on this join.
 *
 * Migration `0024_cache_access_backfill` gave every cache appearing in
 * `blob_ref_storage`, `attestation_ref_storage` or a read credential a lifecycle row, so an
 * inner join over `blob_ref_storage` drops no edge. `narInfoReferenceQuery` and
 * `queueRevokedCacheEdges` use `leftJoin`, which also treats an edge without a
 * lifecycle row as first-generation.
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
 * Matches a readable `blob_ref_storage` row in the cache's current generation.
 *
 * The statement must left join `cache_lifecycle_storage` to `blob_ref_storage` on
 * {@link referencedCacheLifecycle}.
 */
export function authorisedByCacheGeneration(): SQL {
	return (
		and(currentCacheGenerationReference(), authorisedByPathGeneration()) ??
		sql`false`
	);
}

/**
 * Matches a `blob_ref_storage` row left by a deleted cache. A later cache with the same
 * name uses the generation created by the deletion, so retiring the old row
 * cannot affect the later cache's reference edges.
 *
 * The same join requirement as {@link authorisedByCacheGeneration} applies.
 */
export function revokedByCacheGeneration(): SQL {
	return not(currentCacheGenerationReference());
}

/**
 * Returns the current generation for a statement that inserts a `blob_ref_storage`
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

/**
 * Matches references in the current cache generation, including protected references.
 */
export function currentCacheGenerationReference(): SQL {
	return sql`${d1Schema.blobReference.cacheGeneration} = ${currentGeneration}`;
}

/**
Matches readable references above the path's revocation fence.
*/
export function authorisedByPathGeneration(): SQL<boolean> {
	const reference = d1Schema.blobReference;
	const revoked = d1Schema.pathReadRevocation;
	return sql<boolean>`${qualifiedColumn(reference.readable)} and not exists (select 1 from ${d1Schema.pathReadRevocation}
		where ${qualifiedColumn(revoked.tenant)} = ${qualifiedColumn(reference.tenant)} and ${qualifiedColumn(revoked.cacheKind)} = ${qualifiedColumn(reference.cacheKind)}
		and ${qualifiedColumn(revoked.cacheName)} is ${qualifiedColumn(reference.cacheName)} and ${qualifiedColumn(revoked.storePathHash)} = ${qualifiedColumn(reference.storePathHash)}
		and ${qualifiedColumn(revoked.cacheGeneration)} = ${qualifiedColumn(reference.cacheGeneration)} and ${qualifiedColumn(revoked.generation)} >= ${qualifiedColumn(reference.generation)})`;
}

/**
Checks path authority within the statement that inserts a reference.
*/
export function pathReferenceReadability(
	tenant: TenantId,
	cache: CacheScope,
	storePathHash: StorePathHash,
	generation: NarInfoGeneration
): SQL<boolean> {
	const fence = d1Schema.pathReadRevocation;
	const identity = cacheIdentityCondition(
		fence.cacheKind,
		fence.cacheName,
		cache
	);
	return sql<boolean>`not exists (select 1 from ${fence} where ${fence.tenant} = ${tenant} and ${identity} and ${fence.storePathHash} = ${storePathHash} and ${fence.cacheGeneration} = ${currentCacheGeneration(tenant, cache)} and ${fence.generation} >= ${generation})`;
}

// Drizzle removes column qualifiers in single-table projections, including
// within correlated subqueries. Explicit identifiers preserve the correlation.
function qualifiedColumn(column: AnySQLiteColumn): SQL {
	const table = getTableName(column.table);
	return sql`${sql.identifier(table)}.${sql.identifier(column.name)}`;
}
