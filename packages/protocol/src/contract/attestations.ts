import {
	attestationAttachPathsRequestSchema,
	attestationAttachPathsResponseSchema,
	attestationAttachResponseSchema,
	attestationBundleNegotiateRequestSchema,
	attestationBundleNegotiateResponseSchema,
	attestationNegotiateRequestSchema,
	attestationNegotiateResponseSchema
} from '../attestations.ts';
import { uploadIdSchema } from '../upload.ts';

import {
	cacheRemovedErrors,
	cacheScopedProcedure,
	writableCacheScopedProcedure
} from './cache-scoped.ts';

const negotiationErrors = {
	CACHE_RETENTION_MIGRATION_PENDING: { status: 409 },
	...cacheRemovedErrors
};

const bundleNegotiation = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/attestations/bundles',
		requires: 'attestation:negotiate',
		maintenance: true,
		workBound: 'size'
	},
	attestationBundleNegotiateRequestSchema.shape,
	attestationBundleNegotiateResponseSchema
);

const pathNegotiation = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/attestations',
		requires: 'attestation:negotiate',
		maintenance: true,
		workBound: 'size'
	},
	attestationNegotiateRequestSchema.shape,
	attestationNegotiateResponseSchema
);

const bundleAttach = cacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/attestations/bundles/{id}/attach',
		requires: 'attestation:attach',
		resource: { cache: { pending: true, missingDenies: false } },
		maintenance: true,
		replaySafety: 'replay-safe',
		workBound: 'size'
	},
	attestationAttachPathsRequestSchema.shape,
	attestationAttachPathsResponseSchema
);

const pathAttach = cacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/attestations/{id}/attach',
		requires: 'attestation:attach',
		resource: { cache: { pending: true } },
		maintenance: true,
		replaySafety: 'replay-safe',
		workBound: 'size'
	},
	{ id: uploadIdSchema },
	attestationAttachResponseSchema
);

// Negotiation tells the client which bundles to upload or skip. The client uses
// the push credential to stream each required bundle to its staging key, then
// attach verifies the staged bundle and records its reference. Nix-facing list
// and bundle reads stay outside this contract.
export const attestationsContract = {
	negotiateBundles: {
		inDefaultCache: bundleNegotiation.inDefaultCache.errors(negotiationErrors),
		inNamedCache: bundleNegotiation.inNamedCache.errors(negotiationErrors)
	},
	attachPaths: {
		inDefaultCache: bundleAttach.inDefaultCache.errors(cacheRemovedErrors),
		inNamedCache: bundleAttach.inNamedCache.errors(cacheRemovedErrors)
	},
	negotiate: {
		inDefaultCache: pathNegotiation.inDefaultCache.errors(negotiationErrors),
		inNamedCache: pathNegotiation.inNamedCache.errors(negotiationErrors)
	},

	// Authorisation uses the cache recorded on the pending attestation row for
	// `id`. The path does not select the cache because negotiation already bound
	// the pending row to one.
	attach: {
		inDefaultCache: pathAttach.inDefaultCache.errors(cacheRemovedErrors),
		inNamedCache: pathAttach.inNamedCache.errors(cacheRemovedErrors)
	}
};
