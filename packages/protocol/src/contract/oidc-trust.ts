import { z } from 'zod';

import {
	oidcTrustAddBodySchema,
	oidcTrustListResponseSchema,
	oidcTrustRemoveResponseSchema,
	oidcTrustSummarySchema
} from '../oidc.ts';

import { adminProcedure } from './base.ts';

export const oidcTrustContract = {
	list: adminProcedure
		.route({ method: 'GET', path: '/oidc-trust' })
		.output(oidcTrustListResponseSchema),

	add: adminProcedure
		.route({ method: 'POST', path: '/oidc-trust' })
		.input(oidcTrustAddBodySchema)
		.output(oidcTrustSummarySchema),

	remove: adminProcedure
		.route({ method: 'DELETE', path: '/oidc-trust/{id}' })
		.input(z.strictObject({ id: z.string() }))
		.output(oidcTrustRemoveResponseSchema)
};
