import { z } from 'zod';

import {
	gracePolicyListResponseSchema,
	gracePolicyRemoveResponseSchema,
	retentionPolicyListResponseSchema,
	retentionPolicyRemoveResponseSchema
} from '../retention.ts';

import { baseProcedure } from './base.ts';

export const policiesContract = {
	list: baseProcedure
		.meta({ requires: 'policy:list', replaySafety: 'replay-safe' })
		.route({ method: 'GET', path: '/policies' })
		.output(retentionPolicyListResponseSchema),
	remove: baseProcedure
		.meta({ requires: 'policy:remove', replaySafety: 'replay-safe' })
		.route({ method: 'DELETE', path: '/policies/{id}' })
		.input(z.strictObject({ id: z.string() }))
		.output(retentionPolicyRemoveResponseSchema),
	graceList: baseProcedure
		.meta({ requires: 'policy:list', replaySafety: 'replay-safe' })
		.route({ method: 'GET', path: '/policies/grace' })
		.output(gracePolicyListResponseSchema),
	graceRemove: baseProcedure
		.meta({ requires: 'policy:remove', replaySafety: 'replay-safe' })
		.route({ method: 'DELETE', path: '/policies/grace/{id}' })
		.input(z.strictObject({ id: z.string() }))
		.output(gracePolicyRemoveResponseSchema)
};
