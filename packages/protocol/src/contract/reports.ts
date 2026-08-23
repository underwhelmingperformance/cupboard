import { z } from 'zod';

import { checkReportSchema } from '../reports.ts';

import { baseProcedure } from './base.ts';

export const checkContract = {
	// One read-only call checks at most 1,000 narinfo rows across this tenant's
	// caches. It compares committed metadata with the corresponding narinfo and
	// NAR objects. Deep mode also re-derives compressed and uncompressed hashes.
	run: baseProcedure
		.meta({ requires: 'check:run' })
		.route({ method: 'GET', path: '/check' })
		.input(z.strictObject({ deep: z.boolean().default(false) }))
		.output(checkReportSchema)
};
