import type { UploadId } from '@cupboard/protocol/upload';

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

const intervalSchedule: RenewalSchedule = (tick, intervalMs) => {
	const timer = setInterval(tick, intervalMs);
	timer.unref();

	return () => {
		clearInterval(timer);
	};
};

/**
 * Runs `transfer`, which sends the bytes of one upload, and renews the upload
 * over `session` at every interval until the transfer finishes or fails.
 * Without a session that supports renewal, it only runs the transfer.
 */
export async function whileRenewingUpload<T>(
	session: CommitSession | undefined,
	uploadId: UploadId,
	transfer: () => Promise<T>,
	schedule: RenewalSchedule = intervalSchedule
): Promise<T> {
	if (session?.renewUploads === undefined) {
		return transfer();
	}

	const cancel = schedule(() => {
		void renewQuietly(session, uploadId);
	}, uploadRenewalIntervalMs);

	try {
		return await transfer();
	} finally {
		cancel();
	}
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
