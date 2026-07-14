import { z } from 'zod';

import {
	reuseViewListResponseSchema,
	reuseViewNameSchema,
	reuseViewRemoveResponseSchema,
	reuseViewSetBodySchema,
	reuseViewSummarySchema
} from '../reuse-views.ts';

import { baseProcedure } from './base.ts';

// Named reuse views: tenant-domain configuration naming a set of caches
// another cache's reads may substitute from. Defining, updating or removing
// one requires tenant-domain authority, not authority over any one cache a
// selector happens to match, so every procedure carries no resource.
export const reuseViewsContract = {
	list: baseProcedure
		.meta({ requires: 'reuse-view:list' })
		.route({ method: 'GET', path: '/reuse-views' })
		.output(reuseViewListResponseSchema),

	set: baseProcedure
		.meta({ requires: 'reuse-view:set' })
		.route({ method: 'PUT', path: '/reuse-views/{name}' })
		.input(
			z.strictObject({
				name: reuseViewNameSchema,
				...reuseViewSetBodySchema.shape
			})
		)
		.output(reuseViewSummarySchema),

	remove: baseProcedure
		.meta({ requires: 'reuse-view:remove' })
		.route({ method: 'DELETE', path: '/reuse-views/{name}' })
		.input(z.strictObject({ name: reuseViewNameSchema }))
		.output(reuseViewRemoveResponseSchema)
};
