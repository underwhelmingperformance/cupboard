import { cacheSelectorSchema } from '@cupboard/nix-store/scalars';
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

export const uploadsContract = {
	// Issues temporary R2 credentials for a push. Without a `pushId`, the server
	// creates and signs a new identifier. With an existing `pushId`, the server
	// issues replacement credentials for the same staging prefix after authorising
	// the current token. Replacement credentials let a long push continue using
	// bytes already staged. Their expiry never exceeds the token expiry.
	credential: baseProcedure
		.meta({
			requires: 'upload:negotiate',
			resource: { cache: { field: 'cacheName' } }
		})
		.route({ method: 'POST', path: '/cache/{cacheName}/uploads/credential' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				pushId: pushIdSchema.optional()
			})
		)
		.output(pushCredentialSchema),

	negotiate: baseProcedure
		.meta({
			requires: 'upload:negotiate',
			resource: { cache: { field: 'cacheName' } },
			maintenance: true
		})
		.route({ method: 'POST', path: '/cache/{cacheName}/uploads' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				...uploadNegotiateRequestSchema.shape
			})
		)
		.output(uploadNegotiateResponseSchema),

	// Classifies a closure exactly as negotiation would, including the grace facts
	// needed for a report. Preview creates no upload, repairs no stale narinfo, and
	// extends no deadline. It has no `pushId` because it creates no credentials.
	// The cache-scoped grant and ownership check prevent cross-tenant existence
	// disclosure. Preview does not set `maintenance` and does not schedule
	// background work.
	preview: baseProcedure
		.meta({
			requires: 'upload:preview',
			resource: { cache: { field: 'cacheName' } }
		})
		.route({ method: 'POST', path: '/cache/{cacheName}/uploads/preview' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				...uploadPreviewRequestSchema.shape
			})
		)
		.output(uploadPreviewResponseSchema),

	// Confirms an unretained publication by store path without uploading bytes.
	// It runs the same exact-generation check and monotonic grace extension as an
	// already-present negotiate decision, for a path a mutating push already
	// committed. A successful confirm extends a grace deadline and can mark the
	// cache grace-managed, so it mutates retention state and carries
	// `maintenance: true` like negotiate.
	confirm: baseProcedure
		.meta({
			requires: 'upload:confirm',
			resource: { cache: { field: 'cacheName' } },
			maintenance: true
		})
		.route({ method: 'POST', path: '/cache/{cacheName}/uploads/confirm' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				...uploadConfirmRequestSchema.shape
			})
		)
		.output(uploadConfirmResponseSchema),

	// Returns the status of the upload identified by `uploadId`. Upload IDs are
	// unique across caches, so the authoriser reads the cache from the pending row.
	// After the server removes a completed row, status returns `absent`; the missing
	// row does not deny an otherwise authorised request.
	status: baseProcedure
		.meta({
			requires: 'upload:status',
			resource: { cache: { pending: true, missingDenies: false } }
		})
		.route({ method: 'GET', path: '/uploads/{id}/status' })
		.input(z.strictObject({ id: uploadIdSchema }))
		.output(uploadStatusResponseSchema)
};
