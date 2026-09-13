import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { maintenanceRetryKey } from './do/alarm.ts';
import {
	clearAbandonedAlarms,
	currentServer,
	finishTestServerLifecycle,
	resetTestServer,
	useTestServer
} from './test-support.ts';

describe('test alarm cleanup', () => {
	beforeEach(resetTestServer);

	it('clears an alarm on an object used before the harness switched servers', async () => {
		const previous = currentServer();
		await runInDurableObject(previous, async (_instance, state) => {
			await state.storage.setAlarm(new Date('2100-01-01T00:00:00Z'));
		});
		await useTestServer('alarm-cleanup-replacement');
		await clearAbandonedAlarms();

		const alarm = await runInDurableObject(previous, (_instance, state) =>
			state.storage.getAlarm()
		);
		await runInDurableObject(previous, (_instance, state) =>
			state.storage.deleteAlarm()
		);

		expect(alarm).toBeNull();
	});

	it('reports a stalled pass on an object used before the harness switched servers', async () => {
		const previous = currentServer();
		await runInDurableObject(previous, async (_instance, state) => {
			await state.storage.put(
				maintenanceRetryKey('reconcile'),
				Date.now() + 1000
			);
		});
		await useTestServer('stalled-pass-cleanup-replacement');
		await expect(finishTestServerLifecycle()).resolves.toStrictEqual([
			{ pass: 'reconcile', waitMs: 1000 }
		]);
	});
});
