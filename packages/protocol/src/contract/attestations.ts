import { cacheSelectorSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	attestationAttachResponseSchema,
	attestationNegotiateRequestSchema,
	attestationNegotiateResponseSchema
} from '../attestations.ts';
import { uploadIdSchema } from '../upload.ts';

import { baseProcedure } from './base.ts';

// The attestation upload conversation: negotiation decides per bundle whether
// to upload or skip, the bundle streams to its staging key with the push
// credential, and attach verifies and references the staged bundle. The
// Nix-facing list and bundle reads stay outside the contract.
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
		.input(
			z.strictObject({ cacheName: cacheSelectorSchema, id: uploadIdSchema })
		)
		.output(attestationAttachResponseSchema)
};
