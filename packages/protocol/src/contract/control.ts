import { oc } from '@orpc/contract';
import { z } from 'zod';

import {
	controlKeyListResponseSchema,
	controlKeyRetireResponseSchema,
	controlKeyRotateResponseSchema
} from '../control-keys.ts';
import {
	oidcTrustAddBodySchema,
	oidcTrustListResponseSchema,
	oidcTrustRemoveResponseSchema,
	oidcTrustSummarySchema
} from '../oidc.ts';
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

import { type AuthzMeta } from './base.ts';

// Control procedures carry the same grant metadata as tenant ones; the control
// plane just verifies the token against its own issuer and keys first. Each
// procedure declares the operation it requires.
const controlProcedure = oc.$meta<AuthzMeta>({}).errors({
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
		.meta({ requires: 'control:check' })
		.route({ method: 'GET', path: '/check' })
		.output(controlCheckReportSchema),

	keys: {
		list: controlProcedure
			.meta({ requires: 'control-key:list' })
			.route({ method: 'GET', path: '/keys' })
			.output(controlKeyListResponseSchema),

		rotate: controlProcedure
			.meta({ requires: 'control-key:rotate' })
			.route({ method: 'POST', path: '/keys/rotate' })
			.output(controlKeyRotateResponseSchema),

		retire: controlProcedure
			.meta({ requires: 'control-key:retire' })
			.route({ method: 'POST', path: '/keys/retire/{kid}' })
			.input(z.strictObject({ kid: z.string() }))
			.output(controlKeyRetireResponseSchema)
	},

	tenants: {
		list: controlProcedure
			.meta({ requires: 'tenant:list' })
			.route({ method: 'GET', path: '/tenants' })
			.output(tenantListResponseSchema),

		create: controlProcedure
			.meta({
				requires: 'tenant:create',
				resource: { tenant: { field: 'id' } }
			})
			.route({ method: 'POST', path: '/tenants' })
			.input(tenantCreateBodySchema)
			.output(tenantSummarySchema),

		suspend: controlProcedure
			.meta({
				requires: 'tenant:suspend',
				resource: { tenant: { field: 'id' } }
			})
			.route({ method: 'POST', path: '/tenants/{id}/suspend' })
			.input(z.strictObject({ id: z.string() }))
			.output(tenantMutateResponseSchema),

		resume: controlProcedure
			.meta({
				requires: 'tenant:resume',
				resource: { tenant: { field: 'id' } }
			})
			.route({ method: 'POST', path: '/tenants/{id}/resume' })
			.input(z.strictObject({ id: z.string() }))
			.output(tenantMutateResponseSchema),

		setReadMode: controlProcedure
			.meta({
				requires: 'tenant:set-read-mode',
				resource: { tenant: { field: 'id' } }
			})
			.route({ method: 'POST', path: '/tenants/{id}/read-mode' })
			.input(z.strictObject({ id: z.string(), readMode: tenantReadModeSchema }))
			.output(tenantReadModeResponseSchema),

		rotateReadCredential: controlProcedure
			.meta({
				requires: 'tenant:rotate-read-credential',
				resource: { tenant: { field: 'id' } }
			})
			.route({ method: 'POST', path: '/tenants/{id}/read-credential' })
			.input(
				z.strictObject({ id: z.string(), read: tenantReadCredentialSchema })
			)
			.output(tenantReadModeResponseSchema),

		clearReadCredential: controlProcedure
			.meta({
				requires: 'tenant:clear-read-credential',
				resource: { tenant: { field: 'id' } }
			})
			.route({ method: 'DELETE', path: '/tenants/{id}/read-credential' })
			.input(z.strictObject({ id: z.string() }))
			.output(tenantReadModeResponseSchema),

		remove: controlProcedure
			.meta({
				requires: 'tenant:remove',
				resource: { tenant: { field: 'id' } }
			})
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
			.meta({ requires: 'membership:rebuild' })
			.route({ method: 'POST', path: '/membership/rebuild' })
			.output(membershipRebuildResponseSchema)
	},

	// The control plane's own trust rules: which external identity may exchange
	// for control grants. The bootstrap owner is seeded; scoped control
	// identities are managed here.
	oidcTrust: {
		list: controlProcedure
			.meta({ requires: 'control-oidc-trust:list' })
			.route({ method: 'GET', path: '/oidc-trust' })
			.output(oidcTrustListResponseSchema),

		get: controlProcedure
			.meta({ requires: 'control-oidc-trust:read' })
			.route({ method: 'GET', path: '/oidc-trust/{id}' })
			.input(z.strictObject({ id: z.string() }))
			.output(oidcTrustSummarySchema),

		add: controlProcedure
			.meta({ requires: 'control-oidc-trust:add' })
			.route({ method: 'POST', path: '/oidc-trust' })
			.input(oidcTrustAddBodySchema)
			.output(oidcTrustSummarySchema),

		remove: controlProcedure
			.meta({ requires: 'control-oidc-trust:remove' })
			.route({ method: 'DELETE', path: '/oidc-trust/{id}' })
			.input(z.strictObject({ id: z.string() }))
			.output(oidcTrustRemoveResponseSchema)
	}
};
