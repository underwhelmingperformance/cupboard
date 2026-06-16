import { z } from 'zod';

import {
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
		.output(retentionPolicyRemoveResponseSchema)
};
