import { cacheSelectorSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	pushCredentialSchema,
	pushIdSchema,
	uploadNegotiateRequestSchema,
	uploadNegotiateResponseSchema,
	uploadPrepareBatchRequestSchema,
	uploadPrepareBatchResponseSchema,
	uploadPrepareRequestSchema,
	uploadPrepareResponseSchema,
	uploadStatusResponseSchema
} from '../upload.ts';

import { baseProcedure } from './base.ts';

// The upload conversation up to the commit: negotiation decides per path
// whether to upload, reuse or skip; preparation presigns the staging PUT. The
// commit itself is a WebSocket outside the contract, and the staged bytes go
// straight to the presigned URL.
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

	prepare: baseProcedure
		.meta({
			requires: 'upload:prepare',
			resource: { cache: { field: 'cacheName' } },
			maintenance: true
		})
		.route({ method: 'PUT', path: '/cache/{cacheName}/uploads/{id}' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				id: z.string(),
				...uploadPrepareRequestSchema.shape
			})
		)
		.output(uploadPrepareResponseSchema),

	// Presigns a chunk of uploads in one round-trip: the hot-path call a push
	// makes, so a whole closure presigns in a handful of requests. The per-path
	// single prepare above re-negotiates one slot at a time.
	prepareBatch: baseProcedure
		.meta({
			requires: 'upload:prepare',
			resource: { cache: { field: 'cacheName' } },
			maintenance: true
		})
		.route({ method: 'POST', path: '/cache/{cacheName}/uploads/prepare' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				...uploadPrepareBatchRequestSchema.shape
			})
		)
		.output(uploadPrepareBatchResponseSchema),

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
