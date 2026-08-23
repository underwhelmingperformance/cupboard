import type { Reporter } from '@cupboard/reporter';

const sustainedCapacityWaitMs = 5000;

/**
 * Reports a capacity wait only after it has lasted five seconds. The session
 * may briefly leave and re-enter the waiting state as it commits each path, so
 * shorter waits produce no output and repeated waiting does not produce a line
 * for every path.
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
