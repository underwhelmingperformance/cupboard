/**
 * Drives the two maintenance passes from the cron tick. Each runs every tick,
 * independent of the other's outcome: a failing verify never holds back a
 * sweep, nor a failing sweep a verify. A garbage-collection failure is surfaced
 * first, its cleanup being the more time-sensitive of the two.
 */
export async function runScheduledMaintenance(
	runGarbageCollection: () => Promise<void>,
	runVerification: () => Promise<void>
): Promise<void> {
	const [gc, verify] = await Promise.allSettled([
		runGarbageCollection(),
		runVerification()
	]);

	if (gc.status === 'rejected') {
		throw gc.reason;
	}

	if (verify.status === 'rejected') {
		throw verify.reason;
	}
}
