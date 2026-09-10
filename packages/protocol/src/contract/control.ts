import {
	authKeyIdSchema,
	cacheNameSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { oc } from '@orpc/contract';
import { z } from 'zod';

import {
	controlKeyListResponseSchema,
	controlKeyRetireResponseSchema,
	controlKeyRotateResponseSchema
} from '../control-keys.ts';
import {
	configuredInstanceSummarySchema,
	instanceInitialiseBodySchema,
	instanceSummarySchema
} from '../instance.ts';
import {
	controlOidcTrustAddBodySchema,
	oidcTrustListResponseSchema,
	oidcTrustRemoveResponseSchema,
	oidcTrustSummarySchema,
	trustRuleIdSchema
} from '../oidc.ts';
import { controlCheckReportSchema } from '../reports.ts';
import {
	cacheReadCredentialResponseSchema,
	membershipRebuildResponseSchema,
	tenantCreateBodySchema,
	tenantListResponseSchema,
	tenantMutateResponseSchema,
	tenantReadCredentialResponseSchema,
	tenantReadCredentialSchema,
	tenantSummarySchema
} from '../tenants.ts';

import { type AuthzMeta, cacheNotFoundError } from './base.ts';

const controlProcedure = oc
	.$meta<AuthzMeta>({ replaySafety: 'replay-unsafe' })
	.errors({
		UNAUTHORIZED: {},
		FORBIDDEN: {}
	});

/**
 * The administrative API served under `/control` on the bare host. Paths in
 * this contract are relative to `/control`. The server implements this contract,
 * and the CLI derives its client from the same definition.
 */
export const controlContract = {
	check: controlProcedure
		.meta({ requires: 'control:check' })
		.route({ method: 'GET', path: '/check' })
		.output(controlCheckReportSchema),

	instance: {
		get: controlProcedure
			.meta({ requires: 'instance:read' })
			.route({ method: 'GET', path: '/instance' })
			.output(instanceSummarySchema),

		initialise: controlProcedure
			.meta({ requires: 'instance:initialise' })
			.route({ method: 'PUT', path: '/instance' })
			.input(instanceInitialiseBodySchema)
			.output(configuredInstanceSummarySchema)
	},

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
			.input(z.strictObject({ kid: authKeyIdSchema }))
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
			.input(z.strictObject({ id: tenantIdSchema }))
			.output(tenantMutateResponseSchema),

		resume: controlProcedure
			.meta({
				requires: 'tenant:resume',
				resource: { tenant: { field: 'id' } }
			})
			.route({ method: 'POST', path: '/tenants/{id}/resume' })
			.input(z.strictObject({ id: tenantIdSchema }))
			.output(tenantMutateResponseSchema),

		rotateReadCredential: controlProcedure
			.meta({
				requires: 'tenant:rotate-read-credential',
				resource: { tenant: { field: 'id' } }
			})
			.route({ method: 'POST', path: '/tenants/{id}/read-credential' })
			.input(
				z.strictObject({ id: tenantIdSchema, read: tenantReadCredentialSchema })
			)
			.output(tenantReadCredentialResponseSchema),

		clearReadCredential: controlProcedure
			.meta({
				requires: 'tenant:clear-read-credential',
				resource: { tenant: { field: 'id' } }
			})
			.route({ method: 'DELETE', path: '/tenants/{id}/read-credential' })
			.input(z.strictObject({ id: tenantIdSchema }))
			.output(tenantReadCredentialResponseSchema),

		rotateDefaultCacheReadCredential: controlProcedure
			.meta({
				requires: 'tenant:rotate-cache-read-credential',
				resource: { tenant: { field: 'id' } }
			})
			.route({
				method: 'POST',
				path: '/tenants/{id}/default-cache/read-credential'
			})
			.input(
				z.strictObject({ id: tenantIdSchema, read: tenantReadCredentialSchema })
			)
			.errors(cacheNotFoundError)
			.output(cacheReadCredentialResponseSchema),

		rotateNamedCacheReadCredential: controlProcedure
			.meta({
				requires: 'tenant:rotate-cache-read-credential',
				resource: { tenant: { field: 'id' } }
			})
			.route({
				method: 'POST',
				path: '/tenants/{id}/caches/{cacheName}/read-credential'
			})
			.input(
				z.strictObject({
					id: tenantIdSchema,
					cacheName: cacheNameSchema,
					read: tenantReadCredentialSchema
				})
			)
			.errors(cacheNotFoundError)
			.output(cacheReadCredentialResponseSchema),

		clearDefaultCacheReadCredential: controlProcedure
			.meta({
				requires: 'tenant:clear-cache-read-credential',
				resource: { tenant: { field: 'id' } }
			})
			.route({
				method: 'DELETE',
				path: '/tenants/{id}/default-cache/read-credential'
			})
			.input(z.strictObject({ id: tenantIdSchema }))
			.errors(cacheNotFoundError)
			.output(cacheReadCredentialResponseSchema),

		clearNamedCacheReadCredential: controlProcedure
			.meta({
				requires: 'tenant:clear-cache-read-credential',
				resource: { tenant: { field: 'id' } }
			})
			.route({
				method: 'DELETE',
				path: '/tenants/{id}/caches/{cacheName}/read-credential'
			})
			.input(z.strictObject({ id: tenantIdSchema, cacheName: cacheNameSchema }))
			.errors(cacheNotFoundError)
			.output(cacheReadCredentialResponseSchema),

		remove: controlProcedure
			.meta({
				requires: 'tenant:remove',
				resource: { tenant: { field: 'id' } }
			})
			.route({ method: 'DELETE', path: '/tenants/{id}' })
			.input(z.strictObject({ id: tenantIdSchema }))
			.output(tenantMutateResponseSchema)
	},

	membership: {
		// Rebuilds the admission filter and republishes each live tenant's marker
		// from the registry. Deployment calls this procedure after an admission-format
		// change so existing tenants remain admitted before the next hourly cron. It
		// changes only the KV admission data.
		rebuild: controlProcedure
			.meta({ requires: 'membership:rebuild' })
			.route({ method: 'POST', path: '/membership/rebuild' })
			.output(membershipRebuildResponseSchema)
	},

	// The control plane's OIDC trust rules determine which external identities can
	// request control grants. Deployment configuration creates the bootstrap owner
	// rule. Administrators manage additional scoped identities here.
	oidcTrust: {
		list: controlProcedure
			.meta({ requires: 'control-oidc-trust:list' })
			.route({ method: 'GET', path: '/oidc-trust' })
			.output(oidcTrustListResponseSchema),

		get: controlProcedure
			.meta({ requires: 'control-oidc-trust:read' })
			.route({ method: 'GET', path: '/oidc-trust/{id}' })
			.input(z.strictObject({ id: trustRuleIdSchema }))
			.output(oidcTrustSummarySchema),

		add: controlProcedure
			.meta({ requires: 'control-oidc-trust:add' })
			.route({ method: 'POST', path: '/oidc-trust' })
			.input(controlOidcTrustAddBodySchema)
			.output(oidcTrustSummarySchema),

		remove: controlProcedure
			.meta({ requires: 'control-oidc-trust:remove' })
			.route({ method: 'DELETE', path: '/oidc-trust/{id}' })
			.input(z.strictObject({ id: trustRuleIdSchema }))
			.output(oidcTrustRemoveResponseSchema)
	}
};
