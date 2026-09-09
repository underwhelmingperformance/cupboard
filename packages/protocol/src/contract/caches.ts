import {
	cacheAccessModeSchema,
	cacheNameSchema,
	cacheScopeSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	cacheListResponseSchema,
	cachePutBodySchema,
	cacheRemoveResponseSchema,
	cacheSummarySchema,
	cacheUpdateBodySchema
} from '../caches.ts';

import { baseProcedure } from './base.ts';

const forceQuerySchema = z
	.strictObject({ force: z.boolean().default(false) })
	.default({ force: false });

const cacheAlreadyExistsError = {
	CACHE_ALREADY_EXISTS: {
		status: 409,
		data: z.strictObject({ cache: cacheScopeSchema })
	}
};

const cacheViewAccessMismatchError = {
	CACHE_VIEW_ACCESS_MISMATCH: {
		status: 409,
		data: z.strictObject({
			cache: cacheScopeSchema,
			views: z.array(z.string()),
			viewAccess: z.array(cacheAccessModeSchema)
		})
	}
};

const namedCacheUpdateSchema = z.intersection(
	cacheUpdateBodySchema,
	z.strictObject({ cacheName: cacheNameSchema })
);

export const cachesContract = {
	list: baseProcedure
		.meta({ requires: 'cache:list', replaySafety: 'replay-safe' })
		.route({ method: 'GET', path: '/caches' })
		.output(cacheListResponseSchema),
	get: {
		inDefaultCache: baseProcedure
			.meta({
				requires: 'cache:read',
				resource: { cache: { fromPath: true } },
				replaySafety: 'replay-safe'
			})
			.route({ method: 'GET', path: '/cache' })
			.output(cacheSummarySchema),

		inNamedCache: baseProcedure
			.meta({
				requires: 'cache:read',
				resource: { cache: { field: 'cacheName' } },
				replaySafety: 'replay-safe'
			})
			.route({ method: 'GET', path: '/caches/{cacheName}' })
			.input(z.strictObject({ cacheName: cacheNameSchema }))
			.output(cacheSummarySchema)
	},

	// Registration upserts by name, and clears a stored deletion timestamp only
	// where one is present, so a repeat leaves the same rows behind.
	put: {
		inDefaultCache: baseProcedure
			.meta({
				requires: 'cache:create',
				resource: { cache: { fromPath: true } },
				replaySafety: 'replay-safe'
			})
			.route({ method: 'PUT', path: '/cache' })
			.input(cachePutBodySchema)
			.errors({ ...cacheAlreadyExistsError, ...cacheViewAccessMismatchError })
			.output(cacheSummarySchema),

		inNamedCache: baseProcedure
			.meta({
				requires: 'cache:create',
				resource: { cache: { field: 'cacheName' } },
				replaySafety: 'replay-safe'
			})
			.route({ method: 'PUT', path: '/caches/{cacheName}' })
			.input(
				z.strictObject({
					cacheName: cacheNameSchema,
					...cachePutBodySchema.shape
				})
			)
			.errors({ ...cacheAlreadyExistsError, ...cacheViewAccessMismatchError })
			.output(cacheSummarySchema)
	},

	update: {
		inDefaultCache: baseProcedure
			.meta({
				requires: 'cache:update',
				resource: { cache: { fromPath: true } }
			})
			.route({ method: 'PATCH', path: '/cache' })
			.input(cacheUpdateBodySchema)
			.output(cacheSummarySchema),

		inNamedCache: baseProcedure
			.meta({
				requires: 'cache:update',
				resource: { cache: { field: 'cacheName' } }
			})
			.route({ method: 'PATCH', path: '/caches/{cacheName}' })
			.input(namedCacheUpdateSchema)
			.output(cacheSummarySchema)
	},

	// Removal stays `replay-unsafe`. It deletes by name, so a retry sent after the
	// name was registered again would tear down the new cache, and every call
	// advances the cache lifecycle generation.
	remove: baseProcedure
		.meta({
			requires: 'cache:delete',
			resource: { cache: { field: 'cacheName' } },
			maintenance: true
		})
		.route({
			method: 'DELETE',
			path: '/caches/{cacheName}',
			// DELETE carries no body, so `force` is a query parameter.
			inputStructure: 'detailed'
		})
		.input(
			// The detailed shape also carries headers and body, so the top level
			// stays open; the parts we consume are strict.
			z.object({
				params: z.strictObject({ cacheName: cacheNameSchema }),
				query: forceQuerySchema
			})
		)
		.errors({
			CACHE_NOT_EMPTY: {
				status: 409,
				data: z.strictObject({ cache: cacheScopeSchema })
			}
		})
		.output(cacheRemoveResponseSchema)
};
