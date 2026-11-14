import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	abandonAlarmHandlers,
	runAlarmHandler
} from './alarm-fence.test-support.ts';
import {
	currentServer,
	drainAlarmHandlers,
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

describe('drainAlarms', () => {
	beforeEach(resetTestServer);

	it('waits for a running alarm handler to finish', async () => {
		const gate = Promise.withResolvers<undefined>();
		const events: string[] = [];
		let handler: Promise<void> = Promise.resolve();

		await runInDurableObject(currentServer(), (_instance, state) => {
			handler = runAlarmHandler(state, async () => {
				await gate.promise;
				events.push('handler finished');
			});
		});
		const drained = (async () => {
			await drainAlarmHandlers();
			events.push('drained');
		})();

		gate.resolve(undefined);
		await Promise.all([handler, drained]);

		expect(events).toStrictEqual(['handler finished', 'drained']);
	});

	it('does not wait for a handler of an object that workerd aborted', async () => {
		await runInDurableObject(currentServer(), (_instance, state) => {
			// The promise of a handler that workerd aborts neither resolves nor
			// rejects.
			void runAlarmHandler(
				state,
				() => Promise.withResolvers<undefined>().promise
			);
			abandonAlarmHandlers(state.id);
		});

		await expect(drainAlarmHandlers()).resolves.toBeUndefined();
	});

	it('does not wait for a handler of an instance that a new instance replaced', async () => {
		const stub = currentServer();

		await runInDurableObject(stub, (_instance, state) => {
			void runAlarmHandler(
				state,
				() => Promise.withResolvers<undefined>().promise
			);
		});
		await evictDurableObject(stub);

		// No call has reached the object since the eviction, so the drain
		// constructs the replacement instance.
		await expect(drainAlarmHandlers()).resolves.toBeUndefined();
	});

	// Workerd runs a delivered alarm in the object's own context, and the object
	// finishes the handler there. The test awaits `started` inside the object,
	// because a test that awaits a promise that the object resolves continues in
	// the object's context.
	it('waits for an alarm that workerd delivers', async () => {
		const started = Promise.withResolvers<undefined>();
		const release = Promise.withResolvers<undefined>();
		const events: string[] = [];

		await runInDurableObject(currentServer(), async (instance, state) => {
			const initialise: unknown = Reflect.get(instance, 'initialise');

			if (typeof initialise !== 'function') {
				throw new TypeError('initialise is not a function');
			}

			Reflect.set(instance, 'initialise', async (...parameters: unknown[]) => {
				started.resolve(undefined);
				await release.promise;

				await Reflect.apply(initialise, instance, parameters);
			});
			await state.storage.setAlarm(Date.now());
		});
		await runInDurableObject(currentServer(), () => started.promise);
		const drained = (async () => {
			await drainAlarmHandlers();
			events.push('drained');
		})();
		await runInDurableObject(currentServer(), () => {
			events.push('released');
			release.resolve(undefined);
		});
		await drained;

		expect(events).toStrictEqual(['released', 'drained']);
	});
});
