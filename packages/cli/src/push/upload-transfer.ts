import type { UploadId } from '@cupboard/protocol/upload';
import { formatDuration, type Reporter } from '@cupboard/reporter';

import type { CommitSession } from '../client/commit-socket.ts';

/**
 * How often an upload is renewed while its bytes are being sent. Each renewal
 * sets the upload's expiry to 15 minutes after the renewal, so two renewals in
 * a row can be missed before the upload expires.
 */
export const uploadRenewalIntervalMs = 5 * 60 * 1000;

/**
 * Calls `tick` every `intervalMs` until the returned function cancels it.
 */
export type RenewalSchedule = (
	tick: () => void,
	intervalMs: number
) => () => void;

/**
 * Times uploads and schedules their renewals. Tests replace it to drive both
 * without a real clock.
 */
export interface UploadClock {
	/**
	Returns milliseconds from an arbitrary origin.
	*/
	readonly now: () => number;
	readonly schedule: RenewalSchedule;
}

export const systemUploadClock: UploadClock = {
	now: () => performance.now(),
	schedule: (tick, intervalMs) => {
		const timer = setInterval(tick, intervalMs);
		timer.unref();

		return () => {
			clearInterval(timer);
		};
	}
};

/**
 * Runs `transfer`, which sends the bytes of one upload, and returns how long
 * it took in milliseconds. Until the transfer finishes or fails, the upload is
 * renewed over `session` at every interval. Without a session that supports
 * renewal, the transfer is only timed.
 */
export async function sendUpload(
	session: CommitSession | undefined,
	uploadId: UploadId,
	transfer: () => Promise<void>,
	clock: UploadClock = systemUploadClock
): Promise<number> {
	const startedAt = clock.now();
	const cancel =
		session?.renewUploads === undefined
			? undefined
			: clock.schedule(() => {
					void renewQuietly(session, uploadId);
				}, uploadRenewalIntervalMs);

	try {
		await transfer();
	} finally {
		cancel?.();
	}

	return clock.now() - startedAt;
}

// A renewal is advisory: the next tick sends another, and the commit decides
// whether the upload is still live.
async function renewQuietly(
	session: CommitSession,
	uploadId: UploadId
): Promise<void> {
	try {
		await session.renewUploads?.([uploadId]);
	} catch {
		return;
	}
}

/**
 * Reports how long one path's upload took. The message appears with `--debug`
 * and in every JSON event stream, so a slow upload is visible after a run.
 */
export function reportUploadDuration(
	reporter: Pick<Reporter, 'info'>,
	storePathName: string,
	durationMs: number
): void {
	reporter.info(`${storePathName}: uploaded in ${formatDuration(durationMs)}`, {
		level: 'debug'
	});
}
