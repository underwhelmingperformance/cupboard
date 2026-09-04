import { gcResponseSchema } from '../retention.ts';

import { baseProcedure } from './base.ts';
import { namedCacheProcedure } from './cache-scoped.ts';

export const gcContract = {
	// One tenant-wide call advances a bounded collection continuation. It does
	// not necessarily reach every cache; alarms resume the remaining work.
	runAll: baseProcedure
		.meta({ requires: 'gc:run', maintenance: true })
		.route({ method: 'POST', path: '/gc' })
		.output(gcResponseSchema),

	// `POST /gc` is the tenant-wide pass, so a bare path cannot also mean the
	// default cache. Collecting the default cache alone therefore has no route;
	// the tenant-wide pass reaches it.
	runCache: namedCacheProcedure(
		{ method: 'POST', suffix: '/gc', requires: 'gc:run', maintenance: true },
		{},
		gcResponseSchema
	)
};
