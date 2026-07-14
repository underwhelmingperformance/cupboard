import { cacheSelectorSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	pushCredentialSchema,
	pushIdSchema,
	uploadConfirmRequestSchema,
	uploadConfirmResponseSchema,
	uploadNegotiateRequestSchema,
	uploadNegotiateResponseSchema,
	uploadPreviewResponseSchema,
	uploadStatusResponseSchema
} from '../upload.ts';

import { baseProcedure } from './base.ts';

// The upload conversation up to the commit: a credential scopes the push to its
// staging prefix, negotiation decides per path whether to upload, reuse or skip,
// and the missing NARs stream straight to R2 with the credential. The commit is
// a WebSocket outside the contract.
export const uploadsContract = {
	// Issues the temporary R2 credential a push uploads its blobs with. Called
	// without a push id at push start, the server signs a fresh one and scopes the
	// credential to that push's staging prefix. Called with an existing push id, it
	// refreshes the credential for the same prefix off the caller's current token,
	// so a long push can renew before the credential lapses without abandoning the
	// bytes it has already staged. The credential never outlives the token.
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

	// The read-only twin of negotiate: classifies a closure exactly as negotiate
	// would, with the grace facts a report needs, without planning an upload,
	// healing a stale narinfo, or extending any deadline. It requests the same
	// body negotiate does (the signed pushId is the existence-oracle protection,
	// so it stays required even though nothing is staged), and is never a
	// mutation, so it carries no `maintenance` flag and never wakes the
	// scheduler.
	preview: baseProcedure
		.meta({
			requires: 'upload:preview',
			resource: { cache: { field: 'cacheName' } }
		})
		.route({ method: 'POST', path: '/cache/{cacheName}/uploads/preview' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				...uploadNegotiateRequestSchema.shape
			})
		)
		.output(uploadPreviewResponseSchema),

	// Confirms an unretained publication by store path without uploading bytes:
	// the same exact-generation check and monotonic grace extension as an
	// already-present negotiate decision, for a path a mutating push already
	// committed. It mutates retention state (a successful confirm extends a
	// grace deadline and can mark the cache grace-managed), so it carries
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

	// A deferred upload's status, polled by the uploadId the client holds; the
	// id is unique across caches, so the cache is read from the pending row. A
	// settled upload leaves no row and reads as `absent`, so a missing row does
	// not deny the holder of the status operation.
	status: baseProcedure
		.meta({
			requires: 'upload:status',
			resource: { cache: { pending: true, missingDenies: false } }
		})
		.route({ method: 'GET', path: '/uploads/{id}/status' })
		.input(z.strictObject({ id: z.string() }))
		.output(uploadStatusResponseSchema)
};
