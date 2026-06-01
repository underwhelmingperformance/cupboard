import {
	CronGarbageCollectionFailedError,
	CronVerificationFailedError
} from './errors.ts';

/**
 * Drives the two maintenance passes from the cron tick. Each runs every tick,
 * independent of the other's outcome: a failing verify never holds back a
 * sweep, nor a failing sweep a verify. A GC failure is surfaced first, its
 * cleanup being the more time-sensitive of the two.
 */
export async function runScheduledMaintenance(
	postAdmin: (path: string) => Promise<Response>
): Promise<void> {
	const gc = await postAdmin('/gc');
	const verify = await postAdmin('/verify');

	if (!gc.ok) {
		throw new CronGarbageCollectionFailedError(gc.status, await gc.text());
	}

	if (!verify.ok) {
		throw new CronVerificationFailedError(verify.status, await verify.text());
	}
}
