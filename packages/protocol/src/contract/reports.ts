import { z } from 'zod';

import { checkReportSchema } from '../reports.ts';

import { baseProcedure } from './base.ts';

export const checkContract = {
	// A read-only storage check across every cache. Blobs are shared, so it is
	// deployment-wide. The deep flag re-derives stored hashes.
	run: baseProcedure
		.meta({ requires: 'check:run' })
		.route({ method: 'GET', path: '/check' })
		.input(z.strictObject({ deep: z.boolean().default(false) }))
		.output(checkReportSchema)
};
