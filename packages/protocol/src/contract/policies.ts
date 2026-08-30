import { z } from 'zod';

import {
	graceCoverageResponseSchema,
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
import { cacheScopedProcedure } from './cache-scoped.ts';

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
		.output(gracePolicyRemoveResponseSchema),

	// `upload:confirm` may read grace coverage; policy-admin authority is not
	// required. A grace-mode CI run checks coverage before it publishes, and a
	// confirm response already reports the resolved grace for each path.
	graceCoverage: cacheScopedProcedure(
		{
			method: 'GET',
			suffix: '/grace-coverage',
			requires: 'upload:confirm'
		},
		{},
		graceCoverageResponseSchema
	)
};
