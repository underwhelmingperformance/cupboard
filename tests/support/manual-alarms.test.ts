import { expect, it, vi } from 'vitest';

import {
	type ManualAlarmControl,
	withManualAlarmControl
} from './manual-alarms.ts';

it.each([false, true])(
	'closes a fence when startup fails and preserves the startup failure (cleanup fails: %s)',
	async (doesCleanupFail) => {
		let isOpen = false;
		const failure = new Error('deleting the alarm failed');
		const use = vi.fn(() => Promise.resolve());
		const control: ManualAlarmControl = {
			beginManualAlarms: () => {
				isOpen = true;
				return Promise.reject(failure);
			},
			runAlarmPass: () => Promise.resolve(),
			endManualAlarms: () => {
				isOpen = false;
				if (doesCleanupFail) {
					return Promise.reject(new Error('closing the fence also failed'));
				}

				return Promise.resolve();
			}
		};

		await expect(withManualAlarmControl(control, use)).rejects.toBe(failure);
		expect({ isOpen, callbackCalls: use.mock.calls }).toStrictEqual({
			isOpen: false,
			callbackCalls: []
		});
	}
);
