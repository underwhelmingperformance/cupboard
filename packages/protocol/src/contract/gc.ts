import { gcResponseSchema } from '../retention.ts';

import { baseProcedure } from './base.ts';
import { cacheScopedProcedure } from './cache-scoped.ts';

export const gcContract = {
	// One tenant-wide call advances a bounded collection continuation. It does
	// not necessarily reach every cache; alarms resume the remaining work.
	runAll: baseProcedure
		.meta({ requires: 'gc:run', maintenance: true })
		.route({ method: 'POST', path: '/gc' })
		.output(gcResponseSchema),

	runCache: cacheScopedProcedure(
		{ method: 'POST', suffix: '/gc', requires: 'gc:run', maintenance: true },
		{},
		gcResponseSchema
	)
};
