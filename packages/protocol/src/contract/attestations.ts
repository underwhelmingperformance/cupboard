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
	cacheScopedProcedure,
	writableCacheScopedProcedure
} from './cache-scoped.ts';

const retentionMigrationPendingError = {
	CACHE_RETENTION_MIGRATION_PENDING: { status: 409 }
};

const bundleNegotiation = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/attestations/bundles',
		requires: 'attestation:negotiate',
		maintenance: true
	},
	attestationBundleNegotiateRequestSchema.shape,
	attestationBundleNegotiateResponseSchema
);

const pathNegotiation = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/attestations',
		requires: 'attestation:negotiate',
		maintenance: true
	},
	attestationNegotiateRequestSchema.shape,
	attestationNegotiateResponseSchema
);

// Negotiation tells the client which bundles to upload or skip. The client uses
// the push credential to stream each required bundle to its staging key, then
// attach verifies the staged bundle and records its reference. Nix-facing list
// and bundle reads stay outside this contract.
export const attestationsContract = {
	negotiateBundles: {
		inDefaultCache: bundleNegotiation.inDefaultCache.errors(
			retentionMigrationPendingError
		),
		inNamedCache: bundleNegotiation.inNamedCache.errors(
			retentionMigrationPendingError
		)
	},
	attachPaths: cacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/attestations/bundles/{id}/attach',
			requires: 'attestation:attach',
			resource: { cache: { pending: true, missingDenies: false } },
			maintenance: true,
			replaySafety: 'replay-safe'
		},
		attestationAttachPathsRequestSchema.shape,
		attestationAttachPathsResponseSchema
	),
	negotiate: {
		inDefaultCache: pathNegotiation.inDefaultCache.errors(
			retentionMigrationPendingError
		),
		inNamedCache: pathNegotiation.inNamedCache.errors(
			retentionMigrationPendingError
		)
	},

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
