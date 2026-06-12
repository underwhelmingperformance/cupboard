import { cacheSelectorSchema } from '@cupboard/nix/scalars';
import { z } from 'zod';

import {
	uploadNegotiateRequestSchema,
	uploadNegotiateResponseSchema,
	uploadPrepareRequestSchema,
	uploadPrepareResponseSchema,
	uploadStatusResponseSchema
} from '../upload.ts';

import { adminProcedure } from './base.ts';

// The upload conversation up to the commit: negotiation decides per path
// whether to upload, reuse or skip; preparation presigns the staging PUT. The
// commit itself is a WebSocket outside the contract, and the staged bytes go
// straight to the presigned URL.
export const uploadsContract = {
	negotiate: adminProcedure
		.meta({ scope: 'write', maintenance: true })
		.route({ method: 'POST', path: '/cache/{cacheName}/uploads' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				...uploadNegotiateRequestSchema.shape
			})
		)
		.output(uploadNegotiateResponseSchema),

	prepare: adminProcedure
		.meta({ scope: 'write', maintenance: true })
		.route({ method: 'PUT', path: '/cache/{cacheName}/uploads/{id}' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				id: z.string(),
				...uploadPrepareRequestSchema.shape
			})
		)
		.output(uploadPrepareResponseSchema),

	// A deferred upload's status, polled by the uploadId the client holds; the
	// id is unique across caches, so the route carries no cache.
	status: adminProcedure
		.meta({ scope: 'write' })
		.route({ method: 'GET', path: '/uploads/{id}/status' })
		.input(z.strictObject({ id: z.string() }))
		.output(uploadStatusResponseSchema)
};
