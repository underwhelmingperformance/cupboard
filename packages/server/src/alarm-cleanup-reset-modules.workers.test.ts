import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { type CupboardServer } from './do/server.ts';
import { tenantServer } from './routing/durable-object.ts';

// Resetting the module registry gives the Durable Objects a copy of the test
// support modules that differs from the copy that the shared hooks use.
vi.hoisted(() => {
	vi.resetModules();
});

const farFuture = new Date('2100-01-01T00:00:00Z');
const progress: { armedAlarm: number | undefined } = {
	armedAlarm: undefined
};

function probe(): DurableObjectStub<CupboardServer> {
	return tenantServer(env, tenantIdSchema.parse('reset-modules-probe'));
}

describe('alarm cleanup in a file that resets modules', () => {
	// The next test relies on the end of this one. The shared `afterEach`
	// deletes the alarm that this test leaves armed.
	it('arms an alarm and leaves it armed', async () => {
		const armedAlarm = await runInDurableObject(
			probe(),
			async (_instance, state) => {
				await state.storage.setAlarm(farFuture);

				return state.storage.getAlarm();
			}
		);
		progress.armedAlarm = armedAlarm ?? undefined;

		expect(progress.armedAlarm).toBe(farFuture.getTime());
	});

	it('finds no alarm on an object that the previous test left armed', async () => {
		const alarm = await runInDurableObject(probe(), (_instance, state) =>
			state.storage.getAlarm()
		);

		expect({
			previousTestArmedAlarm: progress.armedAlarm,
			alarm: alarm ?? undefined
		}).toStrictEqual({
			previousTestArmedAlarm: farFuture.getTime(),
			alarm: undefined
		});
	});
});
