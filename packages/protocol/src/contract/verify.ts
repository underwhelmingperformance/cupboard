import { z } from 'zod';

import { verifyReportSchema } from '../reports.ts';

import { adminProcedure } from './base.ts';

export const verifyContract = {
	// A maintenance pass: settle deferred uploads, then re-verify a batch of
	// committed blobs. Deployment-wide, since blobs are shared. An optional
	// `limit` caps the batch; the server clamps it to its own ceiling.
	run: adminProcedure
		.meta({ scope: 'admin', maintenance: true })
		.route({ method: 'POST', path: '/verify' })
		.input(z.strictObject({ limit: z.number().int().min(1).optional() }))
		.output(verifyReportSchema)
};
