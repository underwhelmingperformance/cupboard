import { z } from 'zod';

import { checkReportSchema } from '../reports.ts';

import { baseProcedure } from './base.ts';

export const checkContract = {
	// One read-only call checks a page of this tenant's narinfo rows in
	// (cache, store path hash) order, comparing committed metadata with the
	// corresponding narinfo and NAR objects. Deep mode also re-derives compressed
	// and uncompressed hashes. The report names the last row it checked, and the
	// next call starts after it, so a caller checks every path by passing
	// `cursor` and `cursorCache` back until the report returns them empty.
	run: baseProcedure
		.meta({ requires: 'check:run', replaySafety: 'replay-safe' })
		.route({ method: 'GET', path: '/check' })
		.input(
			z.strictObject({
				deep: z.boolean().default(false),
				cursor: z.string().default(''),
				cursorCache: z.string().default('')
			})
		)
		.output(checkReportSchema)
};
