import { cacheSelectorSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { statsResponseSchema, usageResponseSchema } from '../upload.ts';

import { baseProcedure } from './base.ts';

export const statsContract = {
	// Use `_default` to request counts and sizes for the default cache.
	cache: baseProcedure
		.meta({
			requires: 'stats:read',
			resource: { cache: { field: 'cacheName' } }
		})
		.route({ method: 'GET', path: '/cache/{cacheName}/stats' })
		.input(z.strictObject({ cacheName: cacheSelectorSchema }))
		.output(statsResponseSchema),

	// Usage covers the tenant and therefore declares no cache resource.
	usage: baseProcedure
		.meta({ requires: 'stats:read' })
		.route({ method: 'GET', path: '/usage' })
		.output(usageResponseSchema)
};
