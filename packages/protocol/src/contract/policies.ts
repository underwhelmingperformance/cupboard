import { z } from 'zod';

import {
	retentionPolicyAddBodySchema,
	retentionPolicyListResponseSchema,
	retentionPolicyRemoveResponseSchema,
	retentionPolicySummarySchema
} from '../retention.ts';

import { adminProcedure } from './base.ts';

export const policiesContract = {
	list: adminProcedure
		.route({ method: 'GET', path: '/policies' })
		.output(retentionPolicyListResponseSchema),

	add: adminProcedure
		.route({ method: 'POST', path: '/policies' })
		.input(retentionPolicyAddBodySchema)
		.output(retentionPolicySummarySchema),

	remove: adminProcedure
		.route({ method: 'DELETE', path: '/policies/{id}' })
		.input(z.strictObject({ id: z.string() }))
		.output(retentionPolicyRemoveResponseSchema)
};
