import { z } from 'zod';

import {
	pushCredentialSchema,
	pushIdSchema,
	uploadConfirmPresentRequestSchema,
	uploadConfirmPresentResponseSchema,
	uploadConfirmRequestSchema,
	uploadConfirmResponseSchema,
	uploadIdSchema,
	uploadNegotiateRequestSchema,
	uploadNegotiateResponseSchema,
	uploadPlanRequestSchema,
	uploadPlanResponseSchema,
	uploadPreviewRequestSchema,
	uploadPreviewResponseSchema,
	uploadRequestLimitErrorCode,
	uploadRequestLimitErrorDataSchema,
	uploadStatusResponseSchema
} from '../upload.ts';

import { baseProcedure } from './base.ts';
import {
	cacheScopedProcedure,
	writableCacheScopedProcedure
} from './cache-scoped.ts';

const uploadRequestErrors = {
	[uploadRequestLimitErrorCode]: {
		status: 413,
		data: uploadRequestLimitErrorDataSchema
	}
};

const uploadNegotiateErrors = {
	...uploadRequestErrors,
	CACHE_RETENTION_MIGRATION_PENDING: { status: 409 }
};

// Match the existing HTTP error bridge: invalid push IDs use FORBIDDEN,
// generation changes use CONFLICT, and expired recovery uses
// SERVICE_UNAVAILABLE. Do not invent publication-frame refusal codes here.
const confirmPresentErrors = {
	...uploadNegotiateErrors,
	CONFLICT: { status: 409 },
	NOT_FOUND: { status: 404 },
	SERVICE_UNAVAILABLE: { status: 503 },
	PAYLOAD_TOO_LARGE: { status: 413 }
};

const confirmPresent = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/uploads/confirm-present',
		requires: 'upload:commit',
		maintenance: true,
		replaySafety: 'replay-safe'
	},
	uploadConfirmPresentRequestSchema.shape,
	uploadConfirmPresentResponseSchema
);

const negotiate = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/uploads',
		requires: 'upload:negotiate',
		maintenance: true
	},
	uploadNegotiateRequestSchema.shape,
	uploadNegotiateResponseSchema
);

// Classifies a closure exactly as negotiation would, including the grace facts
// needed for a report. Preview creates no upload, repairs no stale narinfo, and
// extends no deadline. It has no `pushId` because it creates no credentials.
// The cache-scoped grant and ownership check prevent cross-tenant existence
// disclosure. Preview does not set `maintenance` and does not schedule
// background work.
const preview = cacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/uploads/preview',
		requires: 'upload:preview',
		replaySafety: 'replay-safe'
	},
	uploadPreviewRequestSchema.shape,
	uploadPreviewResponseSchema
);

export const uploadsContract = {
	// Replay safety requires a durable page receipt: replay rechecks its exact
	// identities without renewing grace or root expiry. The implementation must
	// separately authorise attachRoot.name with the existing root:attach check;
	// upload:commit alone never grants root attachment.
	confirmPresent: {
		inDefaultCache: confirmPresent.inDefaultCache.errors(confirmPresentErrors),
		inNamedCache: confirmPresent.inNamedCache.errors(confirmPresentErrors)
	},
	plan: cacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/uploads/plan',
			requires: 'upload:negotiate',
			replaySafety: 'replay-safe'
		},
		uploadPlanRequestSchema.shape,
		uploadPlanResponseSchema
	),
	// Issues temporary R2 credentials for a push. Without a `pushId`, the server
	// creates and signs a new identifier. With an existing `pushId`, the server
	// issues replacement credentials for the same staging prefix after authorising
	// the current token. Replacement credentials let a long push continue using
	// bytes already staged. Their expiry never exceeds the token expiry.
	credential: cacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/uploads/credential',
			requires: 'upload:negotiate'
		},
		{ pushId: pushIdSchema.optional() },
		pushCredentialSchema
	),

	negotiate: {
		inDefaultCache: negotiate.inDefaultCache.errors(uploadNegotiateErrors),
		inNamedCache: negotiate.inNamedCache.errors(uploadNegotiateErrors)
	},
	preview: {
		inDefaultCache: preview.inDefaultCache.errors(uploadRequestErrors),
		inNamedCache: preview.inNamedCache.errors(uploadRequestErrors)
	},

	// Confirms an unretained publication by store path without uploading bytes.
	// It runs the same exact-generation check and monotonic grace extension as an
	// already-present negotiate decision, for a path a mutating push already
	// committed. A successful confirm extends a grace deadline and can mark the
	// cache grace-managed, so it mutates retention state and carries
	// `maintenance: true` like negotiate.
	//
	// `replay-safe` depends on `confirmPaths`: a repeat re-probes the same paths
	// and `extendGraceDeadlines` keeps the later of the stored and the requested
	// deadline, so a repeat can only move a deadline later. Negotiate creates a
	// pending upload with a fresh id on every call and keeps the default.
	confirm: writableCacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/uploads/confirm',
			requires: 'upload:confirm',
			maintenance: true,
			replaySafety: 'replay-safe'
		},
		uploadConfirmRequestSchema.shape,
		uploadConfirmResponseSchema
	),

	// Returns the status of the upload identified by `uploadId`. Upload IDs are
	// unique across caches, so the authoriser reads the cache from the pending row.
	// After the server removes a completed row, status returns `absent`; the missing
	// row does not deny an otherwise authorised request.
	status: baseProcedure
		.meta({
			requires: 'upload:status',
			resource: { cache: { pending: true, missingDenies: false } },
			replaySafety: 'replay-safe'
		})
		.route({ method: 'GET', path: '/uploads/{id}/status' })
		.input(z.strictObject({ id: uploadIdSchema }))
		.output(uploadStatusResponseSchema)
};
