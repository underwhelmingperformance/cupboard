import { cacheSelectorSchema } from '@cupboard/nix/scalars';
import { z } from 'zod';

import { gcResponseSchema } from '../retention.ts';

import { adminProcedure } from './base.ts';

export const gcContract = {
	// The bare form sweeps every cache; the scoped form sweeps one.
	runAll: adminProcedure
		.meta({ scope: 'admin', maintenance: true })
		.route({ method: 'POST', path: '/gc' })
		.output(gcResponseSchema),

	runCache: adminProcedure
		.meta({ scope: 'admin', maintenance: true })
		.route({ method: 'POST', path: '/cache/{cacheName}/gc' })
		.input(z.strictObject({ cacheName: cacheSelectorSchema }))
		.output(gcResponseSchema)
};
