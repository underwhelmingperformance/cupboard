import { z } from 'zod';

import {
	gracePolicyAddBodySchema,
	gracePolicyListResponseSchema,
	gracePolicyRemoveResponseSchema,
	gracePolicySummarySchema,
	retentionPolicyAddBodySchema,
	retentionPolicyListResponseSchema,
	retentionPolicyRemoveResponseSchema,
	retentionPolicySummarySchema
} from '../retention.ts';

import { baseProcedure } from './base.ts';

export const policiesContract = {
	list: baseProcedure
		.meta({ requires: 'policy:list' })
		.route({ method: 'GET', path: '/policies' })
		.output(retentionPolicyListResponseSchema),

	add: baseProcedure
		.meta({ requires: 'policy:add' })
		.route({ method: 'POST', path: '/policies' })
		.input(retentionPolicyAddBodySchema)
		.output(retentionPolicySummarySchema),

	remove: baseProcedure
		.meta({ requires: 'policy:remove' })
		.route({ method: 'DELETE', path: '/policies/{id}' })
		.input(z.strictObject({ id: z.string() }))
		.output(retentionPolicyRemoveResponseSchema),

	graceList: baseProcedure
		.meta({ requires: 'policy:list' })
		.route({ method: 'GET', path: '/policies/grace' })
		.output(gracePolicyListResponseSchema),

	graceAdd: baseProcedure
		.meta({ requires: 'policy:add' })
		.route({ method: 'POST', path: '/policies/grace' })
		.input(gracePolicyAddBodySchema)
		.output(gracePolicySummarySchema),

	graceRemove: baseProcedure
		.meta({ requires: 'policy:remove' })
		.route({ method: 'DELETE', path: '/policies/grace/{id}' })
		.input(z.strictObject({ id: z.string() }))
		.output(gracePolicyRemoveResponseSchema)
};
