import { z } from 'zod';

import { checkReportSchema } from '../reports.ts';

import { adminProcedure } from './base.ts';

export const checkContract = {
	// A read-only storage check across every cache. Blobs are shared, so it is
	// deployment-wide. The deep flag re-derives stored hashes.
	run: adminProcedure
		.route({ method: 'GET', path: '/check' })
		.input(z.strictObject({ deep: z.boolean().default(false) }))
		.output(checkReportSchema)
};
