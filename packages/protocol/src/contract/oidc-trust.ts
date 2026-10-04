import { z } from 'zod';

import {
	oidcTrustAddBodySchema,
	oidcTrustExtendBodySchema,
	oidcTrustListResponseSchema,
	oidcTrustRemoveResponseSchema,
	oidcTrustSummarySchema,
	trustRuleIdSchema
} from '../oidc.ts';

import { baseProcedure } from './base.ts';

export const oidcTrustContract = {
	list: baseProcedure
		.meta({ requires: 'oidc-trust:list', replaySafety: 'replay-safe' })
		.route({ method: 'GET', path: '/oidc-trust' })
		.output(oidcTrustListResponseSchema),

	get: baseProcedure
		.meta({ requires: 'oidc-trust:read', replaySafety: 'replay-safe' })
		.route({ method: 'GET', path: '/oidc-trust/{id}' })
		.input(z.strictObject({ id: trustRuleIdSchema }))
		.output(oidcTrustSummarySchema),

	add: baseProcedure
		.meta({ requires: 'oidc-trust:add' })
		.route({ method: 'POST', path: '/oidc-trust' })
		.input(oidcTrustAddBodySchema)
		.errors({ CACHE_GRANT_MIGRATION_PENDING: { status: 409 } })
		.output(oidcTrustSummarySchema),

	extend: baseProcedure
		.meta({ requires: 'oidc-trust:add' })
		.route({ method: 'POST', path: '/oidc-trust/{id}/grants' })
		.input(oidcTrustExtendBodySchema.extend({ id: trustRuleIdSchema }))
		.errors({
			OIDC_TRUST_RULE_CHANGED: { status: 409 },
			CACHE_GRANT_MIGRATION_PENDING: { status: 409 }
		})
		.output(oidcTrustSummarySchema),

	remove: baseProcedure
		.meta({ requires: 'oidc-trust:remove' })
		.route({ method: 'DELETE', path: '/oidc-trust/{id}' })
		.input(z.strictObject({ id: trustRuleIdSchema }))
		.output(oidcTrustRemoveResponseSchema)
};
