import {
	type CacheGeneration,
	cacheGenerationSchema,
	type CacheScope,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { and, eq, isNull, not, or, type SQL, sql } from 'drizzle-orm';

import { cacheIdentityCondition } from './cache.ts';
import * as d1Schema from './d1-schema.ts';

/**
 * The generation assigned when a cache is first created.
 */
export const firstCacheGeneration = cacheGenerationSchema.parse(1);

/**
 * The generation written when a deletion first creates a cache's lifecycle
 * row.
 */
export const secondCacheGeneration = cacheGenerationSchema.parse(
	firstCacheGeneration + 1
);

/**
 * Joins each `blob_ref` row to the lifecycle row for the same tenant and cache
 * identity. {@link authorisedByCacheGeneration} and
 * {@link revokedByCacheGeneration} rely on this join.
 *
 * Use this condition with `innerJoin`. Every cache has a lifecycle row, and a
 * reference without one must not authorise a read.
 */
export function referencedCacheLifecycle(): SQL | undefined {
	const sameTenant = eq(
		d1Schema.cacheLifecycle.tenant,
		d1Schema.blobReference.tenant
	);
	const defaultCache = and(
		eq(d1Schema.blobReference.cacheKind, 'default'),
		eq(d1Schema.cacheLifecycle.cacheKind, 'default')
	);
	const defaultLifecycle = isNull(d1Schema.cacheLifecycle.cacheName);
	const defaultReference = isNull(d1Schema.blobReference.cacheName);
	const namedCache = and(
		eq(d1Schema.blobReference.cacheKind, 'named'),
		eq(d1Schema.cacheLifecycle.cacheKind, 'named')
	);
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

	return and(sameTenant, or(sameDefaultCache, sameNamedCache));
}

/**
 * Matches a `blob_ref` row authorised by the cache's current generation.
 *
 * The statement must join `cache_lifecycle` to `blob_ref` with `innerJoin`
 * using {@link referencedCacheLifecycle}.
 */
export function authorisedByCacheGeneration(): SQL {
	return eq(
		d1Schema.blobReference.cacheGeneration,
		d1Schema.cacheLifecycle.generation
	);
}

/**
 * Matches a `blob_ref` row left by a deleted cache. A later cache with the same
 * name uses the generation created by the deletion, so retiring the old row
 * cannot affect its reference edges.
 *
 * The same join requirement as {@link authorisedByCacheGeneration} applies.
 */
export function revokedByCacheGeneration(): SQL {
	return not(authorisedByCacheGeneration());
}

/**
 * Returns the current generation for a statement that inserts a `blob_ref`
 * row. Keeping the lookup inside the insert makes the generation lookup and
 * edge creation one D1 statement. The insert fails its non-null constraint if
 * the cache has no lifecycle row.
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

	return sql<CacheGeneration>`(select ${d1Schema.cacheLifecycle.generation} from ${d1Schema.cacheLifecycle} where ${d1Schema.cacheLifecycle.tenant} = ${tenant} and ${identity})`;
}
