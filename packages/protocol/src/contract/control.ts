import { oc } from '@orpc/contract';
import { z } from 'zod';

import {
	controlKeyListResponseSchema,
	controlKeyRetireResponseSchema,
	controlKeyRotateResponseSchema
} from '../control-keys.ts';
import { controlCheckReportSchema } from '../reports.ts';
import {
	membershipRebuildResponseSchema,
	tenantCreateBodySchema,
	tenantListResponseSchema,
	tenantMutateResponseSchema,
	tenantReadCredentialSchema,
	tenantReadModeResponseSchema,
	tenantReadModeSchema,
	tenantSummarySchema
} from '../tenants.ts';

// Every control procedure requires a control-issued admin token; there is no
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

		resume: controlProcedure
			.route({ method: 'POST', path: '/tenants/{id}/resume' })
			.input(z.strictObject({ id: z.string() }))
			.output(tenantMutateResponseSchema),

		setReadMode: controlProcedure
			.route({ method: 'POST', path: '/tenants/{id}/read-mode' })
			.input(z.strictObject({ id: z.string(), readMode: tenantReadModeSchema }))
			.output(tenantReadModeResponseSchema),

		rotateReadCredential: controlProcedure
			.route({ method: 'POST', path: '/tenants/{id}/read-credential' })
			.input(
				z.strictObject({ id: z.string(), read: tenantReadCredentialSchema })
			)
			.output(tenantReadModeResponseSchema),

		clearReadCredential: controlProcedure
			.route({ method: 'DELETE', path: '/tenants/{id}/read-credential' })
			.input(z.strictObject({ id: z.string() }))
			.output(tenantReadModeResponseSchema),

		remove: controlProcedure
			.route({ method: 'DELETE', path: '/tenants/{id}' })
			.input(z.strictObject({ id: z.string() }))
			.output(tenantMutateResponseSchema)
	},

	membership: {
		// Reassert every live tenant's admission marker and rebuild the filter
		// from the registry. The deploy runs this so a change to the admission
		// representation does not leave existing tenants dark until the hourly
		// cron; it touches only the KV gate, never any tenant's data.
		rebuild: controlProcedure
			.route({ method: 'POST', path: '/membership/rebuild' })
			.output(membershipRebuildResponseSchema)
	}
};
