import { statsResponseSchema, usageResponseSchema } from '../upload.ts';

import { baseProcedure } from './base.ts';
import { cacheScopedProcedure } from './cache-scoped.ts';

export const statsContract = {
	// Use `_default` to request counts and sizes for the default cache.
	cache: cacheScopedProcedure(
		{ method: 'GET', suffix: '/stats', requires: 'stats:read' },
		{},
		statsResponseSchema
	),

	// Usage covers the tenant and therefore declares no cache resource.
	usage: baseProcedure
		.meta({ requires: 'stats:read' })
		.route({ method: 'GET', path: '/usage' })
		.output(usageResponseSchema)
};
