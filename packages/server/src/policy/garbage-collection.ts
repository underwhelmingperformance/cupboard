import { z } from 'zod';

import { MinScanIntervalInvalidError } from '../errors.ts';

interface GarbageCollectionEnv {
	readonly CUPBOARD_GC_MIN_SCAN_INTERVAL_SECONDS: string;
}

export const defaultMinScanIntervalSeconds = 6 * 60 * 60;

export const maxMinScanIntervalSeconds = 30 * 24 * 60 * 60;

const intervalSecondsSchema = z
	.string()
	.regex(/^\d+$/u)
	.transform(Number)
	.pipe(z.number().max(maxMinScanIntervalSeconds));

/**
Parses `CUPBOARD_GC_MIN_SCAN_INTERVAL_SECONDS`, the shortest time between
the completion of one garbage-collection scan of a cache and the start of
the next. An empty setting selects six hours. Any other setting must consist
of decimal digits only, giving a whole number of seconds of at most 30 days.
*/
export function minScanIntervalMs(env: GarbageCollectionEnv): number {
	const raw = env.CUPBOARD_GC_MIN_SCAN_INTERVAL_SECONDS;

	if (!raw) {
		return defaultMinScanIntervalSeconds * 1000;
	}

	const result = intervalSecondsSchema.safeParse(raw);

	if (!result.success) {
		throw new MinScanIntervalInvalidError(raw);
	}

	return result.data * 1000;
}
