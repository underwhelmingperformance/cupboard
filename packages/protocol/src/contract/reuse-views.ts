import { z } from 'zod';

import {
	reuseViewListResponseSchema,
	reuseViewNameSchema,
	reuseViewRemoveResponseSchema,
	reuseViewSetBodySchema,
	reuseViewSummarySchema
} from '../reuse-views.ts';

import { baseProcedure } from './base.ts';

// Reuse views are tenant-wide configuration. They specify the caches that may
// satisfy another cache's reads. Mutations require tenant-domain authority, not
// authority over the caches in the view, so these procedures declare no
// resource.
export const reuseViewsContract = {
	list: baseProcedure
		.meta({ requires: 'reuse-view:list' })
		.route({ method: 'GET', path: '/reuse-views' })
		.output(reuseViewListResponseSchema),

	// The write compares the complete definition inside its transaction and keeps
	// the current revision when nothing changed, so a repeat stores nothing new.
	set: baseProcedure
		.meta({ requires: 'reuse-view:set', replaySafety: 'replay-safe' })
		.route({ method: 'PUT', path: '/reuse-views/{name}' })
		.input(
			z.strictObject({
				name: reuseViewNameSchema,
				...reuseViewSetBodySchema.shape
			})
		)
		.output(reuseViewSummarySchema),

	// Removal stays `replay-unsafe`. It deletes by name, so a retry sent after the
	// name was defined again would delete the new view.
	remove: baseProcedure
		.meta({ requires: 'reuse-view:remove' })
		.route({ method: 'DELETE', path: '/reuse-views/{name}' })
		.input(z.strictObject({ name: reuseViewNameSchema }))
		.output(reuseViewRemoveResponseSchema)
};
