import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubrequestTimeoutError } from '../errors.ts';
import { r2ObjectKeySchema } from '../http/http.ts';

import { StagingDeletes } from './staging-deletes.ts';

const key = r2ObjectKeySchema.parse('staging-v2/tenant/push/operation.nar.zst');

function settlement(wait: Promise<void>): {
	readonly current: () => unknown;
} {
	let state: unknown = 'pending';
	const observe = async (): Promise<void> => {
		try {
			await wait;
			state = 'resolved';
		} catch (error) {
			state = {
				rejected:
					error instanceof SubrequestTimeoutError ? error.subrequest : error
			};
		}
	};
	void observe();
	return { current: () => state };
}

describe('StagingDeletes.finished', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('resolves when the recorded delete of the key ends', async () => {
		const deletes = new StagingDeletes();
		deletes.begin(key);
		const wait = settlement(deletes.finished(key));

		await vi.advanceTimersByTimeAsync(4999);
		const during = wait.current();
		deletes.end(key);
		await vi.advanceTimersByTimeAsync(0);

		expect({
			during,
			after: wait.current(),
			isRecorded: deletes.has(key)
		}).toStrictEqual({
			during: 'pending',
			after: 'resolved',
			isRecorded: false
		});
	});

	it('rejects as a timed-out subrequest after five seconds and keeps the key recorded for a later wait', async () => {
		const deletes = new StagingDeletes();
		deletes.begin(key);
		const wait = settlement(deletes.finished(key));

		await vi.advanceTimersByTimeAsync(4999);
		const during = wait.current();
		await vi.advanceTimersByTimeAsync(1);
		const timedOut = { wait: wait.current(), isRecorded: deletes.has(key) };
		const later = settlement(deletes.finished(key));
		deletes.end(key);
		await vi.advanceTimersByTimeAsync(0);

		expect({ during, timedOut, later: later.current() }).toStrictEqual({
			during: 'pending',
			timedOut: {
				wait: { rejected: 'r2.staging-delete-wait' },
				isRecorded: true
			},
			later: 'resolved'
		});
	});
});

describe('StagingDeletes.delete', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('keeps the key recorded until a delete that timed out finishes', async () => {
		const deletes = new StagingDeletes();
		const { promise: abandoned, resolve: finish } =
			Promise.withResolvers<undefined>();
		const bucket = {
			delete: () =>
				Promise.reject(new SubrequestTimeoutError('r2.delete', abandoned))
		};
		const deleted = settlement(deletes.delete(bucket, key));
		await vi.advanceTimersByTimeAsync(0);
		const during = { deleted: deleted.current(), isRecorded: deletes.has(key) };
		finish(undefined);
		await vi.advanceTimersByTimeAsync(0);

		expect({ during, isRecordedAfter: deletes.has(key) }).toStrictEqual({
			during: { deleted: { rejected: 'r2.delete' }, isRecorded: true },
			isRecordedAfter: false
		});
	});
});
