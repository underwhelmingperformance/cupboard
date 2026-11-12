import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { runAlarmHandler } from './alarm-fence.test-support.ts';
import { maintenanceRetryKey } from './do/alarm.ts';
import { type CupboardServer } from './do/server.ts';
import { TenantNotConfiguredError } from './errors.ts';
import { tenantServer } from './routing/durable-object.ts';
import {
	clearAbandonedAlarms,
	currentServer,
	finishTestServerLifecycle,
	fixtureWorkerServer,
	resetTestServer,
	takeStalledMaintenancePasses,
	testServerFor,
	useTestServer,
	withoutAlarmArming
} from './test-support.ts';

const farFuture = new Date('2100-01-01T00:00:00Z');

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

	it("reports a stalled pass on the fixture tenant's object after a later reset", async () => {
		await takeStalledMaintenancePasses();
		await resetTestServer();
		await runInDurableObject(
			fixtureWorkerServer(),
			async (_instance, state) => {
				await state.storage.put(
					maintenanceRetryKey('reconcile'),
					Date.now() + 1000
				);
			}
		);

		await expect(finishTestServerLifecycle()).resolves.toStrictEqual([
			{ pass: 'reconcile', waitMs: 1000 }
		]);
	});

	it('stops alarms on an object when its test ends', async () => {
		const stub = testServerFor('alarms-stopped-probe');
		const whileTestRuns = {
			alarm: await alarmOutcome(stub),
			canArm: await canArmAlarm(stub)
		};
		await finishTestServerLifecycle();
		const afterTestEnds = {
			alarm: await alarmOutcome(stub),
			canArm: await canArmAlarm(stub)
		};

		expect({ whileTestRuns, afterTestEnds }).toStrictEqual({
			whileTestRuns: { alarm: 'rejected', canArm: true },
			afterTestEnds: { alarm: 'returned', canArm: false }
		});
	});

	it('stops alarms on an instance that was built while a fence was open', async () => {
		const stub = testServerFor('fenced-replacement-probe');
		const canArmInFence = await withoutAlarmArming(async () => {
			await evictDurableObject(stub);

			return canArmAlarm(stub);
		}, stub);
		const canArmAfterFence = await canArmAlarm(stub);
		await finishTestServerLifecycle();
		const canArmAfterTestEnds = await canArmAlarm(stub);

		expect({
			canArmInFence,
			canArmAfterFence,
			canArmAfterTestEnds
		}).toStrictEqual({
			canArmInFence: false,
			canArmAfterFence: true,
			canArmAfterTestEnds: false
		});
	});

	// The next test relies on the end of this one. The shared `afterEach`
	// stops alarms on every object that the test used.
	it('uses an object that the next test reaches without the harness', async () => {
		const isArmed = await canArmAlarm(testServerFor('cross-test-probe'));
		pairProgress.crossTestObjectUsed = true;

		expect(isArmed).toBe(true);
	});

	it('arms alarms on an object that the previous test used and this test reaches without the harness', async () => {
		const stub = tenantServer(env, tenantIdSchema.parse('cross-test-probe'));
		const isArmed = await canArmAlarm(stub);

		expect({
			previousTestRan: pairProgress.crossTestObjectUsed,
			isArmed
		}).toStrictEqual({ previousTestRan: true, isArmed: true });
	});

	// The next test relies on the start of this one, which aborts the fixture
	// tenant's object while the handler below is still running.
	it('starts an alarm handler that is aborted before it finishes', async () => {
		await runInDurableObject(fixtureWorkerServer(), (_instance, state) => {
			unfinishedHandlers.push(
				runAlarmHandler(state, () => Promise.withResolvers<undefined>().promise)
			);
		});
		pairProgress.handlerStarted = true;
	});

	it('arms alarms on an object whose handler an earlier test aborted', async () => {
		const isArmed = await canArmAlarm(fixtureWorkerServer());

		expect({
			previousTestRan: pairProgress.handlerStarted,
			isArmed
		}).toStrictEqual({ previousTestRan: true, isArmed: true });
	});

	// The next test relies on the end of this one. The handler below belongs to
	// this test, and the next test lets it continue.
	it('starts an alarm handler that waits for the next test', async () => {
		const stub = testServerFor('straggler-probe');
		await runInDurableObject(stub, (_instance, state) => {
			straggler.handler = runAlarmHandler(state, async () => {
				await straggler.gate.promise;
				await state.storage.setAlarm(farFuture);
			});
		});
		pairProgress.stragglerStarted = true;
	});

	it('refuses the alarm that a handler from an earlier test arms, and arms the alarm of this test', async () => {
		const stub = testServerFor('straggler-probe');
		const canArmWhileHandlerRuns = await canArmAlarm(stub);
		straggler.gate.resolve(undefined);
		await straggler.handler;
		const armedByHandler = await runInDurableObject(stub, (_instance, state) =>
			state.storage.getAlarm()
		);

		expect({
			previousTestRan: pairProgress.stragglerStarted,
			canArmWhileHandlerRuns,
			armedByHandler: armedByHandler ?? undefined
		}).toStrictEqual({
			previousTestRan: true,
			canArmWhileHandlerRuns: true,
			armedByHandler: undefined
		});
	});
});

interface StragglerCall {
	readonly name: string;
	readonly objectName: string;
	/**
	Finds the object whose method the call waits in, starting from the instance.
	*/
	readonly waitingObject: (instance: CupboardServer) => object;
	readonly waitingMethod: string;
	readonly start: (instance: CupboardServer) => Promise<unknown>;
}

// Each entry point of the test worker starts a call in the first test of a
// pair. The call waits for a gate, then arms an alarm in the second test.
describe.each<StragglerCall>([
	{
		name: 'fetch request',
		objectName: 'fetch-straggler-probe',
		waitingObject: (instance) => instance,
		waitingMethod: 'fetchInitialised',
		start: (instance) => instance.fetch(new Request('https://cupboard.test/'))
	},
	{
		name: 'RPC method call',
		objectName: 'rpc-straggler-probe',
		waitingObject: (instance) => objectField(instance, 'commitPipeline'),
		waitingMethod: 'requestVerification',
		start: (instance) => instance.requestVerificationPass()
	}
])(
	'a $name from an earlier test',
	({ name, objectName, waitingObject, waitingMethod, start }) => {
		const call = {
			gate: Promise.withResolvers<undefined>(),
			reachedGate: Promise.withResolvers<undefined>(),
			result: Promise.resolve<unknown>(undefined),
			hasReachedGate: false,
			hasRequestedAlarm: false
		};

		// The next test relies on the end of this one.
		it('starts and waits for the next test', async () => {
			await useTestServer(objectName);
			await runInDurableObject(
				testServerFor(objectName),
				async (instance, state) => {
					Reflect.set(waitingObject(instance), waitingMethod, async () => {
						call.hasReachedGate = true;
						call.reachedGate.resolve(undefined);
						await call.gate.promise;
						await state.storage.setAlarm(farFuture);
						call.hasRequestedAlarm = true;

						return new Response();
					});
					call.result = start(instance);
					// A method that the patch does not replace finishes the call
					// without reaching the gate, and the next test reports it.
					await Promise.race([call.reachedGate.promise, call.result]);
				}
			);
		});

		it('cannot arm alarms, and does not stop this test from arming them', async () => {
			const stub = testServerFor(objectName);
			const canArmWhileCallRuns = await canArmAlarm(stub);
			call.gate.resolve(undefined);
			await call.result;
			const armedByCall = await runInDurableObject(stub, (_instance, state) =>
				state.storage.getAlarm()
			);

			expect({
				name,
				hasReachedGate: call.hasReachedGate,
				hasRequestedAlarm: call.hasRequestedAlarm,
				canArmWhileCallRuns,
				armedByCall: armedByCall ?? undefined
			}).toStrictEqual({
				name,
				hasReachedGate: true,
				hasRequestedAlarm: true,
				canArmWhileCallRuns: true,
				armedByCall: undefined
			});
		});
	}
);

function objectField(instance: object, name: string): object {
	const field: unknown = Reflect.get(instance, name);

	if (typeof field !== 'object' || field === null) {
		throw new TypeError(`${name} is not an object`);
	}

	return field;
}

const pairProgress = {
	crossTestObjectUsed: false,
	handlerStarted: false,
	stragglerStarted: false
};
const straggler: {
	gate: PromiseWithResolvers<undefined>;
	handler: Promise<void>;
} = { gate: Promise.withResolvers<undefined>(), handler: Promise.resolve() };
const unfinishedHandlers: Promise<void>[] = [];

function canArmAlarm(
	stub: DurableObjectStub<CupboardServer>
): Promise<boolean> {
	return runInDurableObject(stub, async (_instance, state) => {
		await state.storage.setAlarm(farFuture);
		const alarm = await state.storage.getAlarm();
		await state.storage.deleteAlarm();

		return alarm === farFuture.getTime();
	});
}

/**
Runs the alarm handler on an object that no test configured. A handler that
runs rejects, because the tenant is not configured. A handler that the test
worker skips returns.
*/
async function alarmOutcome(
	stub: DurableObjectStub<CupboardServer>
): Promise<'rejected' | 'returned'> {
	try {
		await runInDurableObject(stub, (instance) => instance.alarm());
	} catch (error) {
		if (error instanceof TenantNotConfiguredError) {
			return 'rejected';
		}

		throw error;
	}

	return 'returned';
}
