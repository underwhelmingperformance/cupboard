import { namedCacheSelectorSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	cacheListResponseSchema,
	cachePutBodySchema,
	cacheRemoveResponseSchema,
	cacheSummarySchema
} from '../caches.ts';

import { baseProcedure } from './base.ts';

const forceQuerySchema = z
	.strictObject({ force: z.boolean().default(false) })
	.default({ force: false });

export const cachesContract = {
	list: baseProcedure
		.meta({ requires: 'cache:list', replaySafety: 'replay-safe' })
		.route({ method: 'GET', path: '/caches' })
		.output(cacheListResponseSchema),

	put: baseProcedure
		.meta({
			requires: 'cache:create',
			resource: { cache: { field: 'cacheName' } }
		})
		.route({ method: 'PUT', path: '/caches/{cacheName}' })
		.input(
			z.strictObject({
				cacheName: namedCacheSelectorSchema,
				...cachePutBodySchema.shape
			})
		)
		.output(cacheSummarySchema),

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
				params: z.strictObject({ cacheName: namedCacheSelectorSchema }),
				query: forceQuerySchema
			})
		)
		.errors({
			CACHE_NOT_EMPTY: {
				status: 409,
				data: z.strictObject({ cache: z.string() })
			}
		})
		.output(cacheRemoveResponseSchema)
};
