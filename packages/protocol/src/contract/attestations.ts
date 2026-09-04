import {
	attestationAttachResponseSchema,
	attestationNegotiateRequestSchema,
	attestationNegotiateResponseSchema
} from '../attestations.ts';
import { uploadIdSchema } from '../upload.ts';

import { cacheScopedProcedure } from './cache-scoped.ts';

// Negotiation tells the client which bundles to upload or skip. The client uses
// the push credential to stream each required bundle to its staging key, then
// attach verifies the staged bundle and records its reference. Nix-facing list
// and bundle reads stay outside this contract.
export const attestationsContract = {
	negotiate: cacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/attestations',
			requires: 'attestation:negotiate',
			maintenance: true
		},
		attestationNegotiateRequestSchema.shape,
		attestationNegotiateResponseSchema
	),

	// Authorisation uses the cache recorded on the pending attestation row for
	// `id`. The path does not select the cache because negotiation already bound
	// the pending row to one.
	attach: cacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/attestations/{id}/attach',
			requires: 'attestation:attach',
			resource: { cache: { pending: true } },
			maintenance: true,
			replaySafety: 'replay-safe'
		},
		{ id: uploadIdSchema },
		attestationAttachResponseSchema
	)
};
