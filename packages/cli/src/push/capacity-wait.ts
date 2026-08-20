import type { Reporter } from '@cupboard/reporter';

// How long the session has to be waiting before the wait is worth a line of
// output.
const sustainedCapacityWaitMs = 5000;

/**
 * Reports the session's capacity waits. The flag toggles once per path when the
 * cache grants one entry at a time, so a wait is announced only once it has
 * lasted `sustainedCapacityWaitMs`. The end of a wait is never announced: a run
 * that continues shows for itself that capacity arrived, and a run that gave up
 * reports the reason in the failure that follows.
 */
export function capacityWaitReporter(
	reporter: Reporter
): (isWaitingForCapacity: boolean) => void {
	let announcement: NodeJS.Timeout | undefined;

	return (isWaitingForCapacity) => {
		if (!isWaitingForCapacity) {
			if (announcement !== undefined) {
				clearTimeout(announcement);
				announcement = undefined;
			}

			return;
		}

		if (announcement !== undefined) {
			return;
		}

		announcement = setTimeout(() => {
			announcement = undefined;
			reporter.info('Waiting for the cache to grant capacity to commit');
		}, sustainedCapacityWaitMs);
		announcement.unref();
	};
}
