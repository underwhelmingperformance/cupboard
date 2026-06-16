import { z } from 'zod';

import {
	oidcTrustAddBodySchema,
	oidcTrustListResponseSchema,
	oidcTrustRemoveResponseSchema,
	oidcTrustSummarySchema
} from '../oidc.ts';

import { baseProcedure } from './base.ts';

export const oidcTrustContract = {
	list: baseProcedure
		.meta({ requires: 'oidc-trust:list' })
		.route({ method: 'GET', path: '/oidc-trust' })
		.output(oidcTrustListResponseSchema),

	get: baseProcedure
		.meta({ requires: 'oidc-trust:read' })
		.route({ method: 'GET', path: '/oidc-trust/{id}' })
		.input(z.strictObject({ id: z.string() }))
		.output(oidcTrustSummarySchema),

	add: baseProcedure
		.meta({ requires: 'oidc-trust:add' })
		.route({ method: 'POST', path: '/oidc-trust' })
		.input(oidcTrustAddBodySchema)
		.output(oidcTrustSummarySchema),

	remove: baseProcedure
		.meta({ requires: 'oidc-trust:remove' })
		.route({ method: 'DELETE', path: '/oidc-trust/{id}' })
		.input(z.strictObject({ id: z.string() }))
		.output(oidcTrustRemoveResponseSchema)
};
