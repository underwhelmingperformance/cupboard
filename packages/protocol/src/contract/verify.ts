import { z } from 'zod';

import { verifyReportSchema } from '../reports.ts';

import { baseProcedure } from './base.ts';

export const verifyContract = {
	// One call first attempts a bounded set of pending uploads, then advances the
	// tenant-wide cursor through a bounded batch of committed narinfo rows. It
	// restores missing narinfo objects and removes metadata whose NAR object is
	// absent. The server clamps `limit` to 500.
	run: baseProcedure
		.meta({ requires: 'verification:run', maintenance: true })
		.route({ method: 'POST', path: '/verify' })
		.input(z.strictObject({ limit: z.number().int().min(1).optional() }))
		.output(verifyReportSchema)
};
