import { cacheSelectorSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	attestationAttachResponseSchema,
	attestationNegotiateRequestSchema,
	attestationNegotiateResponseSchema
} from '../attestations.ts';
import { uploadIdSchema } from '../upload.ts';

import { baseProcedure } from './base.ts';

// Negotiation tells the client which bundles to upload or skip. The client uses
// the push credential to stream each required bundle to its staging key, then
// attach verifies the staged bundle and records its reference. Nix-facing list
// and bundle reads stay outside this contract.
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

	// Authorisation uses the cache recorded on the pending attestation row for
	// `id`. The path does not select the cache because negotiation already bound
	// the pending row to one.
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
