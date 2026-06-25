import { cacheSelectorSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	attestationAttachResponseSchema,
	attestationNegotiateRequestSchema,
	attestationNegotiateResponseSchema,
	attestationPrepareResponseSchema
} from '../attestations.ts';

import { baseProcedure } from './base.ts';

// The attestation upload conversation: negotiation decides per bundle whether
// to upload or skip, preparation presigns the staging PUT, and attach
// verifies and references the staged bundle. The Nix-facing list and bundle
// reads stay outside the contract.
export const attestationsContract = {
	negotiate: baseProcedure
		.meta({
			requires: 'attestation:negotiate',
			resource: { cache: { field: 'cacheName' } },
			maintenance: true
		})
		.route({ method: 'POST', path: '/cache/{cacheName}/attestations' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				...attestationNegotiateRequestSchema.shape
			})
		)
		.output(attestationNegotiateResponseSchema),

	prepare: baseProcedure
		.meta({
			requires: 'attestation:prepare',
			resource: { cache: { field: 'cacheName' } },
			maintenance: true
		})
		.route({ method: 'PUT', path: '/cache/{cacheName}/attestations/{id}' })
		.input(z.strictObject({ cacheName: cacheSelectorSchema, id: z.string() }))
		.output(attestationPrepareResponseSchema),

	// The cache is taken from the pending attestation row the id addresses, not
	// the path: the bundle was negotiated against that row's cache.
	attach: baseProcedure
		.meta({
			requires: 'attestation:attach',
			resource: { cache: { pending: true } },
			maintenance: true
		})
		.route({
			method: 'POST',
			path: '/cache/{cacheName}/attestations/{id}/attach'
		})
		.input(z.strictObject({ cacheName: cacheSelectorSchema, id: z.string() }))
		.output(attestationAttachResponseSchema)
};
