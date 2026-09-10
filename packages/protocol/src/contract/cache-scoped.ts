import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { type AuthzMeta, baseProcedure, type ResourceSpec } from './base.ts';

// A cache-scoped operation has two paths: a bare one for the tenant's default
// cache, and one under `/cache/<name>` for a named cache. Nix reads use the
// same two spellings, so a client addresses a cache the same way whatever it
// asks for.
const namedCachePrefix = '/cache/{cacheName}';

interface CacheScopedRoute {
	readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	// The part of the path that follows the cache selection.
	readonly suffix: `/${string}`;
	readonly requires: NonNullable<AuthzMeta['requires']>;
	// The cache resource comes from the request path. A procedure that reads it
	// from a pending row instead overrides the location here.
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
 * Declares a procedure that a named cache alone can be asked for. Use it only
 * where the bare path already belongs to a tenant-wide operation, so the
 * default cache cannot be addressed there.
 */
export function namedCacheProcedure<
	Shape extends z.core.$ZodLooseShape,
	Output extends z.ZodType
>(route: CacheScopedRoute, shape: Shape, output: Output) {
	return baseProcedure
		.meta(scopedMeta(route))
		.route({ method: route.method, path: `${namedCachePrefix}${route.suffix}` })
		.input(z.strictObject({ cacheName: cacheNameSchema, ...shape }))
		.output(output);
}

/**
 * Declares a cache-scoped procedure whose path parameters and body arrive as
 * one object. `shape` supplies every input field except the cache selection,
 * which only the named-cache variant carries.
 */
export function cacheScopedProcedure<
	Shape extends z.core.$ZodLooseShape,
	Output extends z.ZodType
>(route: CacheScopedRoute, shape: Shape, output: Output) {
	const procedure = baseProcedure.meta(scopedMeta(route));

	return {
		inDefaultCache: procedure
			.route({ method: route.method, path: route.suffix })
			.input(z.strictObject({ ...shape }))
			.output(output),
		inNamedCache: namedCacheProcedure(route, shape, output)
	};
}
