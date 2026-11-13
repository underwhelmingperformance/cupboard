import { statsResponseSchema, usageResponseSchema } from '../upload.ts';

import { baseProcedure } from './base.ts';
import { cacheScopedProcedure } from './cache-scoped.ts';
import { listingProjectionPendingError } from './caches.ts';

const cacheStats = cacheScopedProcedure(
	{
		method: 'GET',
		suffix: '/stats',
		requires: 'stats:read',
		replaySafety: 'replay-safe',
		workBound: 'time'
	},
	{},
	statsResponseSchema
);

export const statsContract = {
	cache: {
		inDefaultCache: cacheStats.inDefaultCache.errors(
			listingProjectionPendingError
		),
		inNamedCache: cacheStats.inNamedCache.errors(listingProjectionPendingError)
	},

	// Usage covers the tenant and therefore declares no cache resource.
	usage: baseProcedure
		.meta({
			requires: 'stats:read',
			replaySafety: 'replay-safe',
			workBound: 'time'
		})
		.route({ method: 'GET', path: '/usage' })
		.output(usageResponseSchema)
};
