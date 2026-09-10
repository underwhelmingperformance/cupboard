import { cacheSelectorSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { type AuthzMeta, baseProcedure, type ResourceSpec } from './base.ts';

// Every cache-scoped procedure selects its cache in the same path segment and
// the same input field, so the authoriser reads one field name for all of them.
const cacheScopePrefix = '/cache/{cacheName}';

interface CacheScopedRoute {
	readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	// The part of the path that follows the cache selection, starting with `/`.
	readonly suffix: string;
	readonly requires: NonNullable<AuthzMeta['requires']>;
	// The cache resource defaults to the selection field. A procedure that reads
	// its cache from a pending row overrides it here.
	readonly resource?: ResourceSpec;
	readonly maintenance?: boolean;
	readonly replaySafety?: AuthzMeta['replaySafety'];
}

function scopedMeta(route: CacheScopedRoute): AuthzMeta {
	return {
		requires: route.requires,
		resource: { cache: { field: 'cacheName' }, ...route.resource },
		...(route.maintenance !== undefined && { maintenance: route.maintenance }),
		...(route.replaySafety !== undefined && {
			replaySafety: route.replaySafety
		})
	};
}

/**
 * Declares a cache-scoped procedure whose path parameters and body arrive as one
 * object. `shape` supplies every input field except the cache selection, which
 * this helper adds.
 */
export function cacheScopedProcedure<
	Shape extends z.core.$ZodLooseShape,
	Output extends z.ZodType
>(route: CacheScopedRoute, shape: Shape, output: Output) {
	return baseProcedure
		.meta(scopedMeta(route))
		.route({ method: route.method, path: `${cacheScopePrefix}${route.suffix}` })
		.input(z.strictObject({ cacheName: cacheSelectorSchema, ...shape }))
		.output(output);
}

/**
 * Declares a cache-scoped procedure that also reads a query string. oRPC's
 * detailed input structure separates the path parameters from the query, so the
 * top level stays open while both parts are strict.
 */
export function cacheScopedQueryProcedure<
	ParameterShape extends z.core.$ZodLooseShape,
	Query extends z.ZodType,
	Output extends z.ZodType
>(
	route: CacheScopedRoute,
	parameterShape: ParameterShape,
	query: Query,
	output: Output
) {
	return baseProcedure
		.meta(scopedMeta(route))
		.route({
			method: route.method,
			path: `${cacheScopePrefix}${route.suffix}`,
			inputStructure: 'detailed'
		})
		.input(
			z.object({
				params: z.strictObject({
					cacheName: cacheSelectorSchema,
					...parameterShape
				}),
				query
			})
		)
		.output(output);
}
