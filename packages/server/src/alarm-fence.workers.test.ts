import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	currentServer,
	resetTestServer,
	withoutAlarmArming
} from './test-support.ts';

/**
Asks the current server to arm an alarm, then reports whether one is armed.
*/
function armAlarm(): Promise<'armed' | 'unarmed'> {
	return runInDurableObject(currentServer(), async (_instance, state) => {
		await state.storage.setAlarm(Date.now() + 3_600_000);
		const alarm = await state.storage.getAlarm();
		await state.storage.deleteAlarm();

		return alarm === null ? 'unarmed' : 'armed';
	});
}

describe('withoutAlarmArming', () => {
	beforeEach(resetTestServer);

	// Workerd replaces an idle Durable Object after ten seconds. Eviction
	// replaces it at once, so the test does not have to wait.
	it('keeps alarms disarmed on an instance that replaces the fenced one', async () => {
		const inFence = await withoutAlarmArming(async () => {
			await evictDurableObject(currentServer());

			return armAlarm();
		});
		const afterFence = await armAlarm();

		expect({ inFence, afterFence }).toStrictEqual({
			inFence: 'unarmed',
			afterFence: 'armed'
		});
	});
});
