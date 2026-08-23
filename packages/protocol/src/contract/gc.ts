import { cacheSelectorSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { gcResponseSchema } from '../retention.ts';

import { baseProcedure } from './base.ts';

export const gcContract = {
	// One tenant-wide call advances a bounded collection continuation. It does
	// not necessarily reach every cache; alarms resume the remaining work.
	runAll: baseProcedure
		.meta({ requires: 'gc:run', maintenance: true })
		.route({ method: 'POST', path: '/gc' })
		.output(gcResponseSchema),

	runCache: baseProcedure
		.meta({
			requires: 'gc:run',
			resource: { cache: { field: 'cacheName' } },
			maintenance: true
		})
		.route({ method: 'POST', path: '/cache/{cacheName}/gc' })
		.input(z.strictObject({ cacheName: cacheSelectorSchema }))
		.output(gcResponseSchema)
};
