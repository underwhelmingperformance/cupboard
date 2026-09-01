import { z } from 'zod';

import { managedPolicyIdSchema } from '../managed-caches.ts';
import {
	reuseViewListResponseSchema,
	reuseViewNameSchema,
	reuseViewRemoveResponseSchema,
	reuseViewSetBodySchema,
	reuseViewSummarySchema
} from '../reuse-views.ts';

import { baseProcedure } from './base.ts';

const managedViewConflictError = {
	MANAGED_POLICY_CONFLICT: {
		status: 409,
		data: z.strictObject({ policyId: managedPolicyIdSchema.optional() })
	}
};

// Reuse views are tenant-wide configuration. They specify the caches that may
// satisfy another cache's reads. Mutations require tenant-domain authority, not
// authority over the caches in the view, so these procedures declare no
// resource.
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
		.errors(managedViewConflictError)
		.output(reuseViewSummarySchema),

	remove: baseProcedure
		.meta({ requires: 'reuse-view:remove' })
		.route({ method: 'DELETE', path: '/reuse-views/{name}' })
		.input(z.strictObject({ name: reuseViewNameSchema }))
		.errors(managedViewConflictError)
		.output(reuseViewRemoveResponseSchema)
};
