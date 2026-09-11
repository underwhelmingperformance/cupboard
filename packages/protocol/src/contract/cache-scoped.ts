import { namedCacheSelectorSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { type AuthzMeta, baseProcedure, type ResourceSpec } from './base.ts';

// A cache-scoped operation has two paths: a bare one for the tenant's default
// cache, and one under `/cache/<selector>` for a named cache. The named-cache
// path accepts only a named cache's selector, and the server reads the cache
// each request addresses from its path unless the procedure declares another
// location.
const namedCachePrefix = '/cache/{cacheName}';

interface CacheScopedRoute {
	readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	// The path under `/cache/{cacheName}`, which is also the whole path of the
	// default-cache variant.
	readonly suffix: `/${string}`;
	readonly requires: NonNullable<AuthzMeta['requires']>;
	// The cache comes from the request path. Declare `resource` to add another
	// resource, such as a root, or to read the cache from a pending row instead.
	readonly resource?: ResourceSpec;
	readonly maintenance?: boolean;
	readonly replaySafety?: AuthzMeta['replaySafety'];
}

function scopedMeta(route: CacheScopedRoute): AuthzMeta {
	return {
		requires: route.requires,
		resource: { cache: { fromPath: true }, ...route.resource },
		...(route.maintenance !== undefined && { maintenance: route.maintenance }),
		...(route.replaySafety !== undefined && {
			replaySafety: route.replaySafety
		})
	};
}

/**
 * Declares a cache-scoped procedure under `/cache/{cacheName}` only, as a single
 * procedure whose input gains `cacheName`. Use it when the bare path already
 * belongs to a tenant-wide operation and therefore cannot also mean the default
 * cache. That operation then has no route for the default cache, so record in
 * the declaration what reaches it instead.
 */
export function namedCacheProcedure<
	Shape extends z.core.$ZodLooseShape,
	Output extends z.ZodType
>(route: CacheScopedRoute, shape: Shape, output: Output) {
	return baseProcedure
		.meta(scopedMeta(route))
		.route({ method: route.method, path: `${namedCachePrefix}${route.suffix}` })
		.input(z.strictObject({ cacheName: namedCacheSelectorSchema, ...shape }))
		.output(output);
}

/**
 * Declares one cache-scoped operation as a pair of procedures: `inDefaultCache`
 * on the bare path and `inNamedCache` under `/cache/{cacheName}`. The tenant
 * router implements both, and the CLI calls them through `callInCache`.
 *
 * `shape` supplies every input field except the cache selection, which only
 * `inNamedCache` carries. The fields arrive as one flat object: oRPC takes the
 * path parameters from the path and sends the rest in the body, or in the query
 * string for a GET.
 */
export function cacheScopedProcedure<
	Shape extends z.core.$ZodLooseShape,
	Output extends z.ZodType
>(route: CacheScopedRoute, shape: Shape, output: Output) {
	return {
		inDefaultCache: baseProcedure
			.meta(scopedMeta(route))
			.route({ method: route.method, path: route.suffix })
			.input(z.strictObject({ ...shape }))
			.output(output),
		inNamedCache: namedCacheProcedure(route, shape, output)
	};
}
