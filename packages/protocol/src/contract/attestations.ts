import { cacheSelectorSchema } from '@cupboard/nix/scalars';
import { z } from 'zod';

import {
	attestationAttachResponseSchema,
	attestationNegotiateRequestSchema,
	attestationNegotiateResponseSchema,
	attestationPrepareResponseSchema
} from '../attestations.ts';

import { adminProcedure } from './base.ts';

// The attestation upload conversation: negotiation decides per bundle whether
// to upload or skip, preparation presigns the staging PUT, and attach
// verifies and references the staged bundle. The Nix-facing list and bundle
// reads stay outside the contract.
export const attestationsContract = {
	negotiate: adminProcedure
		.meta({ scope: 'write', maintenance: true })
		.route({ method: 'POST', path: '/cache/{cacheName}/attestations' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				...attestationNegotiateRequestSchema.shape
			})
		)
		.output(attestationNegotiateResponseSchema),

	prepare: adminProcedure
		.meta({ scope: 'write', maintenance: true })
		.route({ method: 'PUT', path: '/cache/{cacheName}/attestations/{id}' })
		.input(z.strictObject({ cacheName: cacheSelectorSchema, id: z.string() }))
		.output(attestationPrepareResponseSchema),

	attach: adminProcedure
		.meta({ scope: 'write', maintenance: true })
		.route({
			method: 'POST',
			path: '/cache/{cacheName}/attestations/{id}/attach'
		})
		.input(z.strictObject({ cacheName: cacheSelectorSchema, id: z.string() }))
		.output(attestationAttachResponseSchema)
};
