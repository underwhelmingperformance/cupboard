import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { cacheSummarySchema } from '../caches.ts';
import {
	managedCacheCapacityFailureSchema,
	managedCacheGroupIdSchema,
	managedCacheProvisionInputSchema,
	managedGroupAccessUpdateInputSchema,
	managedPolicyIdSchema,
	managedPolicyListSchema,
	managedPolicyPutBodySchema,
	managedPolicyRetireInputSchema,
	managedPolicySummarySchema
} from '../managed-caches.ts';

import { baseProcedure } from './base.ts';

const managedPolicyErrors = {
	MANAGED_POLICY_CONFLICT: {
		status: 409,
		data: z.strictObject({ policyId: managedPolicyIdSchema.optional() })
	}
};

export const managedCachesContract = {
	policies: {
		list: baseProcedure
			.meta({
				requires: 'managed-cache-policy:list',
				replaySafety: 'replay-safe'
			})
			.route({ method: 'GET', path: '/managed-cache-policies' })
			.output(managedPolicyListSchema),

		put: baseProcedure
			.meta({ requires: 'managed-cache-policy:set', maintenance: true })
			.route({
				method: 'PUT',
				path: '/managed-cache-policies/github/{repositoryId}'
			})
			.input(managedPolicyPutBodySchema)
			.errors(managedPolicyErrors)
			.output(managedPolicySummarySchema),

		retire: baseProcedure
			.meta({ requires: 'managed-cache-policy:retire', maintenance: true })
			.route({
				method: 'POST',
				path: '/managed-cache-policies/{policyId}/retire'
			})
			.input(managedPolicyRetireInputSchema)
			.errors(managedPolicyErrors)
			.output(managedPolicySummarySchema)
	},

	groups: {
		setAccess: baseProcedure
			.meta({ requires: 'managed-cache-group:update', maintenance: true })
			.route({
				method: 'POST',
				path: '/managed-cache-groups/{groupId}/access'
			})
			.input(managedGroupAccessUpdateInputSchema)
			.errors({
				MANAGED_GROUP_NOT_FOUND: {
					status: 404,
					data: z.strictObject({ groupId: managedCacheGroupIdSchema })
				},
				...managedPolicyErrors
			})
			.output(z.strictObject({ accepted: z.literal(true) }))
	},

	provision: baseProcedure
		.meta({
			requires: 'cache:provision',
			resource: { cache: { field: 'cacheName' } },
			maintenance: true
		})
		.route({ method: 'POST', path: '/caches/{cacheName}/provision' })
		.input(managedCacheProvisionInputSchema)
		.errors({
			MANAGED_CACHE_CAPACITY: {
				status: 503,
				data: managedCacheCapacityFailureSchema
			},
			MANAGED_CACHE_CONFLICT: {
				status: 409,
				data: z.strictObject({ cacheName: cacheNameSchema })
			}
		})
		.output(cacheSummarySchema)
};
