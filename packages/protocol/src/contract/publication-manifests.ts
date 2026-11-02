import {
	publicationCaptureBeginRequestSchema,
	publicationCaptureBeginResponseSchema,
	publicationCapturePageRequestSchema,
	publicationCapturePageResponseSchema,
	publicationCaptureSealRequestSchema,
	publicationCaptureSealResponseSchema,
	publicationEnsureRequestSchema,
	publicationEnsureResponseSchema,
	publicationLookupRequestSchema,
	publicationLookupResponseSchema,
	publicationManifestLimitErrorCode,
	publicationManifestLimitErrorDataSchema,
	publicationStatusRequestSchema,
	publicationStatusResponseSchema
} from '../publication-manifests.ts';

import {
	cacheScopedProcedure,
	writableCacheScopedProcedure
} from './cache-scoped.ts';

// Named errors pass through the existing ORPCError bridge. A stale result is
// never a successful missing/unavailable lookup. Generic codes cover lifecycle,
// payload and provider errors without inventing a new permission taxonomy.
const publicationErrors = {
	BAD_REQUEST: { status: 400 },
	NOT_FOUND: { status: 404 },
	CONFLICT: { status: 409 },
	GONE: { status: 410 },
	PAYLOAD_TOO_LARGE: { status: 413 },
	SERVICE_UNAVAILABLE: { status: 503 },
	PUBLICATION_RESULT_CHANGED: { status: 409 },
	PUBLICATION_SCOPE_CHANGED: { status: 409 },
	PUBLICATION_GENERATION_CONFLICT: { status: 409 },
	PUBLICATION_IDEMPOTENCY_CONFLICT: { status: 409 },
	PUBLICATION_INVALID_PAGE: { status: 400 },
	PUBLICATION_DIVERGENCE: { status: 409 },
	[publicationManifestLimitErrorCode]: {
		status: 413,
		data: publicationManifestLimitErrorDataSchema
	}
};
const publicationWriteErrors = {
	...publicationErrors,
	CACHE_RETENTION_MIGRATION_PENDING: { status: 409 }
};

// Every route cache is the destination, including lookup. The explicit lookup
// source and ensure source require independent current ReuseAuthority checks;
// destination commit authority is not private source-read authority. Only use
// the same-destination shortcut with the actual destination identity.
const lookup = cacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/publication-results/lookup',
		requires: 'upload:commit',
		replaySafety: 'replay-safe'
	},
	publicationLookupRequestSchema.shape,
	publicationLookupResponseSchema
);

const captureBegin = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/publication-results/captures',
		requires: 'upload:commit',
		maintenance: true,
		replaySafety: 'replay-safe'
	},
	publicationCaptureBeginRequestSchema.shape,
	publicationCaptureBeginResponseSchema
);

// The implementation binds contiguous page numbers and canonical payloads to
// durable work. Changed replay payloads conflict; retries do not append twice.
const capturePage = writableCacheScopedProcedure(
	{
		method: 'PUT',
		suffix: '/publication-results/captures/{operationId}/pages/{page}',
		requires: 'upload:commit',
		maintenance: true,
		replaySafety: 'replay-safe'
	},
	publicationCapturePageRequestSchema.shape,
	publicationCapturePageResponseSchema
);

// First complete authorised association wins. Each call advances at most one
// bounded phase step. A captured winner is metadata, not ensured materialisation;
// competing valid captures never replace or union the winner's members.
const captureSeal = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/publication-results/captures/{operationId}/seal',
		requires: 'upload:commit',
		maintenance: true,
		replaySafety: 'replay-safe'
	},
	publicationCaptureSealRequestSchema.shape,
	publicationCaptureSealResponseSchema
);

// Independently require root:attach for runRoot, if provided. It must already
// exist; ensure only appends its exact result, never replaces targets or retention.
const ensure = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/publication-results/ensure',
		requires: 'upload:commit',
		maintenance: true,
		replaySafety: 'replay-safe'
	},
	publicationEnsureRequestSchema.shape,
	publicationEnsureResponseSchema
);

// Observation only: durable status reads must not advance pending work.
const status = cacheScopedProcedure(
	{
		method: 'GET',
		suffix: '/publication-results/operations/{operationId}',
		requires: 'upload:commit',
		replaySafety: 'replay-safe'
	},
	publicationStatusRequestSchema.shape,
	publicationStatusResponseSchema
);

export const publicationManifestsContract = {
	lookup: {
		inDefaultCache: lookup.inDefaultCache.errors(publicationErrors),
		inNamedCache: lookup.inNamedCache.errors(publicationErrors)
	},
	captureBegin: {
		inDefaultCache: captureBegin.inDefaultCache.errors(publicationWriteErrors),
		inNamedCache: captureBegin.inNamedCache.errors(publicationWriteErrors)
	},
	capturePage: {
		inDefaultCache: capturePage.inDefaultCache.errors(publicationWriteErrors),
		inNamedCache: capturePage.inNamedCache.errors(publicationWriteErrors)
	},
	captureSeal: {
		inDefaultCache: captureSeal.inDefaultCache.errors(publicationWriteErrors),
		inNamedCache: captureSeal.inNamedCache.errors(publicationWriteErrors)
	},
	ensure: {
		inDefaultCache: ensure.inDefaultCache.errors(publicationWriteErrors),
		inNamedCache: ensure.inNamedCache.errors(publicationWriteErrors)
	},
	status: {
		inDefaultCache: status.inDefaultCache.errors(publicationErrors),
		inNamedCache: status.inNamedCache.errors(publicationErrors)
	}
};
