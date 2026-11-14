import { type ManualClock } from '../../../../tests/support/manual-clock.ts';

import { type RefreshRetryTiming } from './refresh-retry.ts';

/**
Refresh retry timing on `clock`. Each delay that the client requests is
appended to `delays`.
*/
export function manualRefreshTiming(
	clock: ManualClock,
	delays: number[] = []
): RefreshRetryTiming {
	return {
		stopwatch: () => {
			const startedAtMs = clock.now();

			return () => clock.now() - startedAtMs;
		},
		wait: (milliseconds, signal) => {
			delays.push(milliseconds);

			return clock.wait(milliseconds, signal);
		}
	};
}
