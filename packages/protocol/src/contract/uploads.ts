import { StatusCodes } from 'http-status-codes';
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
	cacheRemovedErrors,
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

const confirmPresentErrors = {
	...uploadNegotiateErrors,
	...cacheRemovedErrors,
	CONFLICT: { status: StatusCodes.CONFLICT }
};

// Confirms paths that a plan reported as already served, without staging or
// committing them. For a path that the server serves, it answers `confirmed`
// or `diverged`, extends the path's grace when the cache has grace, and
// attaches the path to `attachRoot` when the request has one. It answers
// `missing` for a path that the client must publish. The procedure also needs
// `upload:negotiate`, as publication does, and `root:attach` for the run root.
//
// A replay re-evaluates the paths and can only move grace deadlines and
// run-root expiries later, so the procedure is `replay-safe`. Applying the same
// confirmation again changes nothing while the cache's state is unchanged and
// the replay's deadlines fall in the same clock hours. Maintenance runs only
// after a confirmation that wrote rows or failed, so such a repeat writes
// nothing.
const confirmPresent = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/uploads/confirm-present',
		requires: 'upload:commit',
		maintenance: 'when-changed',
		replaySafety: 'replay-safe',
		workBound: 'size'
	},
	uploadConfirmPresentRequestSchema.shape,
	uploadConfirmPresentResponseSchema
);

const negotiate = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/uploads',
		requires: 'upload:negotiate',
		maintenance: true,
		workBound: 'size'
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
		replaySafety: 'replay-safe',
		workBound: 'size'
	},
	uploadPreviewRequestSchema.shape,
	uploadPreviewResponseSchema
);

// Plans at most one direct upload page, the limit that its responses
// advertise in `x-cupboard-upload-max-paths`. A larger request receives
// `UPLOAD_REQUEST_LIMIT_EXCEEDED` before the server reads any storage.
const plan = cacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/uploads/plan',
		requires: 'upload:negotiate',
		replaySafety: 'replay-safe',
		workBound: 'size'
	},
	uploadPlanRequestSchema.shape,
	uploadPlanResponseSchema
);

export const uploadsContract = {
	plan: {
		inDefaultCache: plan.inDefaultCache.errors({
			...uploadRequestErrors,
			...cacheRemovedErrors
		}),
		inNamedCache: plan.inNamedCache.errors({
			...uploadRequestErrors,
			...cacheRemovedErrors
		})
	},
	// Issues temporary R2 credentials for a push. Without a `pushId`, the server
	// creates and signs a new identifier. With an existing `pushId`, the server
	// issues replacement credentials for the same staging prefix after authorising
	// the current token. Replacement credentials let a long push continue using
	// bytes already staged. Their expiry never exceeds the token expiry.
	credential: cacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/uploads/credential',
			requires: 'upload:negotiate',
			workBound: 'time'
		},
		{ pushId: pushIdSchema.optional() },
		pushCredentialSchema
	),

	negotiate: {
		inDefaultCache: negotiate.inDefaultCache.errors({
			...uploadNegotiateErrors,
			...cacheRemovedErrors
		}),
		inNamedCache: negotiate.inNamedCache.errors({
			...uploadNegotiateErrors,
			...cacheRemovedErrors
		})
	},
	preview: {
		inDefaultCache: preview.inDefaultCache.errors(uploadRequestErrors),
		inNamedCache: preview.inNamedCache.errors(uploadRequestErrors)
	},
	confirmPresent: {
		inDefaultCache: confirmPresent.inDefaultCache.errors(confirmPresentErrors),
		inNamedCache: confirmPresent.inNamedCache.errors(confirmPresentErrors)
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
			replaySafety: 'replay-safe',
			workBound: 'size'
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
			replaySafety: 'replay-safe',
			workBound: 'time'
		})
		.route({ method: 'GET', path: '/uploads/{id}/status' })
		.input(z.strictObject({ id: uploadIdSchema }))
		.output(uploadStatusResponseSchema)
};
