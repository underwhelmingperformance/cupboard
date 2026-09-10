import { z } from 'zod';

import { checkReportSchema } from '../reports.ts';

import { baseProcedure } from './base.ts';

export const checkContract = {
	// One read-only call checks a page of this tenant's narinfo rows in
	// (cache, store path hash) order, comparing committed metadata with the
	// corresponding narinfo and NAR objects. Deep mode also re-derives compressed
	// and uncompressed hashes. The report carries the row the next call starts at,
	// so a caller checks every path by passing `cursor` and `cursorCache` back
	// until the report returns the end of the scan.
	run: baseProcedure
		.meta({ requires: 'check:run' })
		.route({ method: 'GET', path: '/check' })
		.input(
			z.strictObject({
				deep: z.boolean().default(false),
				cursor: z.string().default(''),
				cursorCache: z.coerce.number().int().nonnegative().default(0)
			})
		)
		.output(checkReportSchema)
};
