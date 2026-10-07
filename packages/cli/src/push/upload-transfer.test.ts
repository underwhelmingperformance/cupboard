import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import type { CommitSession } from '../client/commit-socket.ts';

import {
	type RenewalSchedule,
	whileRenewingUpload
} from './upload-transfer.ts';

const uploadId = uploadIdSchema.parse('upload-1');

// Runs each scheduled tick only when the test calls `tick`, and records when
// the schedule is cancelled.
function manualSchedule(events: string[]): {
	readonly schedule: RenewalSchedule;
	readonly tick: () => void;
} {
	let scheduled: (() => void) | undefined;

	return {
		schedule: (tick, intervalMs) => {
			events.push(`schedule ${String(intervalMs)}`);
			scheduled = tick;

			return () => {
				events.push('cancel');
				scheduled = undefined;
			};
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

describe('whileRenewingUpload', () => {
	it.each([
		{ name: 'completes', outcome: 'resolve' },
		{ name: 'fails', outcome: 'reject' }
	] as const)(
		'renews while the transfer runs and stops when it $name',
		async ({ outcome }) => {
			const events: string[] = [];
			const { schedule, tick } = manualSchedule(events);
			const transfer = Promise.withResolvers<undefined>();
			const failure = new Error('transfer failed');
			const running = whileRenewingUpload(
				renewingSession(events),
				uploadId,
				() => transfer.promise,
				schedule
			);

			tick();
			tick();

			if (outcome === 'resolve') {
				transfer.resolve(undefined);
				await running;
			} else {
				transfer.reject(failure);
				await expect(running).rejects.toBe(failure);
			}

			tick();

			expect(events).toStrictEqual([
				'schedule 300000',
				'renew upload-1',
				'renew upload-1',
				'cancel'
			]);
		}
	);

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
	])('schedules nothing for $name', async ({ session }) => {
		const events: string[] = [];
		const { schedule } = manualSchedule(events);

		await expect(
			whileRenewingUpload(
				session,
				uploadId,
				() => Promise.resolve('sent'),
				schedule
			)
		).resolves.toBe('sent');
		expect(events).toStrictEqual([]);
	});
});
