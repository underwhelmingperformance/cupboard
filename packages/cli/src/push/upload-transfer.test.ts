import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import type { CommitSession } from '../client/commit-socket.ts';

import { sendUpload, type UploadClock } from './upload-transfer.ts';

const uploadId = uploadIdSchema.parse('upload-1');

// Runs each scheduled tick only when the test calls `tick`, records when the
// schedule is cancelled, and reads the time from `times` in order.
function manualClock(
	events: string[],
	times: readonly number[]
): { readonly clock: UploadClock; readonly tick: () => void } {
	let scheduled: (() => void) | undefined;
	let reads = 0;

	return {
		clock: {
			now: () => {
				const time = times[reads] ?? 0;
				reads += 1;

				return time;
			},
			schedule: (tick, intervalMs) => {
				events.push(`schedule ${String(intervalMs)}`);
				scheduled = tick;

				return () => {
					events.push('cancel');
					scheduled = undefined;
				};
			}
		},
		tick: () => {
			scheduled?.();
		}
	};
}

function renewingSession(events: string[]): CommitSession {
	return {
		commit: () => Promise.reject(new Error('unexpected commit')),
		renewUploads: (uploadIds: readonly UploadId[]) => {
			events.push(`renew ${uploadIds.join(',')}`);

			return Promise.resolve();
		},
		close() {
			return;
		}
	};
}

describe('sendUpload', () => {
	it('renews while the transfer runs, stops when it ends and reports its duration', async () => {
		const events: string[] = [];
		const { clock, tick } = manualClock(events, [1000, 4000]);
		const transfer = Promise.withResolvers<undefined>();
		const sending = sendUpload(
			renewingSession(events),
			uploadId,
			() => transfer.promise,
			clock
		);

		tick();
		tick();
		transfer.resolve(undefined);
		const durationMs = await sending;
		tick();

		expect({ durationMs, events }).toStrictEqual({
			durationMs: 3000,
			events: ['schedule 300000', 'renew upload-1', 'renew upload-1', 'cancel']
		});
	});

	it('stops renewing when the transfer fails', async () => {
		const events: string[] = [];
		const { clock, tick } = manualClock(events, [0]);
		const failure = new Error('transfer failed');
		const sending = sendUpload(
			renewingSession(events),
			uploadId,
			() => Promise.reject(failure),
			clock
		);

		await expect(sending).rejects.toBe(failure);
		tick();

		expect(events).toStrictEqual(['schedule 300000', 'cancel']);
	});

	it.each([
		{ name: 'no session', session: undefined },
		{
			name: 'a session without renewal',
			session: {
				commit: () => Promise.reject(new Error('unexpected commit')),
				close() {
					return;
				}
			}
		}
	])('only times the transfer for $name', async ({ session }) => {
		const events: string[] = [];
		const { clock } = manualClock(events, [500, 2500]);

		await expect(
			sendUpload(session, uploadId, () => Promise.resolve(), clock)
		).resolves.toBe(2000);
		expect(events).toStrictEqual([]);
	});
});
