import { cacheSelectorSchema } from '@cupboard/nix/scalars';
import { z } from 'zod';

import { statsResponseSchema, usageResponseSchema } from '../upload.ts';

import { baseProcedure } from './base.ts';

export const statsContract = {
	// Per-cache counts and sizes; the default cache is addressed as `_default`.
	cache: baseProcedure
		.meta({
			requires: 'stats:read',
			resource: { cache: { field: 'cacheName' } }
		})
		.route({ method: 'GET', path: '/cache/{cacheName}/stats' })
		.input(z.strictObject({ cacheName: cacheSelectorSchema }))
		.output(statsResponseSchema),

	// Tenant-wide usage against the quota, independent of any one cache.
	usage: baseProcedure
		.meta({ requires: 'stats:read' })
		.route({ method: 'GET', path: '/usage' })
		.output(usageResponseSchema)
};
