import { z } from 'zod';

import {
	pushCredentialSchema,
	pushIdSchema,
	uploadConfirmRequestSchema,
	uploadConfirmResponseSchema,
	uploadIdSchema,
	uploadNegotiateRequestSchema,
	uploadNegotiateResponseSchema,
	uploadPreviewRequestSchema,
	uploadPreviewResponseSchema,
	uploadStatusResponseSchema
} from '../upload.ts';

import { baseProcedure } from './base.ts';
import { cacheScopedProcedure } from './cache-scoped.ts';

export const uploadsContract = {
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

	negotiate: cacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/uploads',
			requires: 'upload:negotiate',
			maintenance: true
		},
		uploadNegotiateRequestSchema.shape,
		uploadNegotiateResponseSchema
	),

	// Classifies a closure exactly as negotiation would, including the grace facts
	// needed for a report. Preview creates no upload, repairs no stale narinfo, and
	// extends no deadline. It has no `pushId` because it creates no credentials.
	// The cache-scoped grant and ownership check prevent cross-tenant existence
	// disclosure. Preview does not set `maintenance` and does not schedule
	// background work.
	preview: cacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/uploads/preview',
			requires: 'upload:preview',
			replaySafety: 'replay-safe'
		},
		uploadPreviewRequestSchema.shape,
		uploadPreviewResponseSchema
	),

	// Confirms an unretained publication by store path without uploading bytes.
	// It runs the same exact-generation check and monotonic grace extension as an
	// already-present negotiate decision, for a path a mutating push already
	// committed. A successful confirm extends a grace deadline and can mark the
	// cache grace-managed, so it mutates retention state and carries
	// `maintenance: true` like negotiate.
	confirm: cacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/uploads/confirm',
			requires: 'upload:confirm',
			maintenance: true
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
