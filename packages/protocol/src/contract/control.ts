import { oc } from '@orpc/contract';
import { z } from 'zod';

import {
	controlKeyListResponseSchema,
	controlKeyRetireResponseSchema,
	controlKeyRotateResponseSchema
} from '../control-keys.ts';
import { controlCheckReportSchema } from '../reports.ts';
import {
	tenantCreateBodySchema,
	tenantListResponseSchema,
	tenantMutateResponseSchema,
	tenantSummarySchema
} from '../tenants.ts';

// Every control procedure requires a control-minted admin token; there is no
// scope gradation to declare, so the base carries only the auth failures.
const controlProcedure = oc.errors({
	UNAUTHORIZED: {},
	FORBIDDEN: {}
});

/**
 * The control-plane admin API: the operator surface the bare host serves
 * under `/control`, declared once. Paths are relative to that prefix. The
 * server implements this contract and the CLI derives its client from it, so
 * the two cannot drift.
 */
export const controlContract = {
	check: controlProcedure
		.route({ method: 'GET', path: '/check' })
		.output(controlCheckReportSchema),

	keys: {
		list: controlProcedure
			.route({ method: 'GET', path: '/keys' })
			.output(controlKeyListResponseSchema),

		rotate: controlProcedure
			.route({ method: 'POST', path: '/keys/rotate' })
			.output(controlKeyRotateResponseSchema),

		retire: controlProcedure
			.route({ method: 'POST', path: '/keys/retire/{kid}' })
			.input(z.strictObject({ kid: z.string() }))
			.output(controlKeyRetireResponseSchema)
	},

	tenants: {
		list: controlProcedure
			.route({ method: 'GET', path: '/tenants' })
			.output(tenantListResponseSchema),

		create: controlProcedure
			.route({ method: 'POST', path: '/tenants' })
			.input(tenantCreateBodySchema)
			.output(tenantSummarySchema),

		suspend: controlProcedure
			.route({ method: 'POST', path: '/tenants/{id}/suspend' })
			.input(z.strictObject({ id: z.string() }))
			.output(tenantMutateResponseSchema),

		remove: controlProcedure
			.route({ method: 'DELETE', path: '/tenants/{id}' })
			.input(z.strictObject({ id: z.string() }))
			.output(tenantMutateResponseSchema)
	}
};
