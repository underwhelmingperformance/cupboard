import { AsyncLocalStorage } from 'node:async_hooks';

/**
Alarm controls for the Workers test pool. The test worker's `CupboardServer`
calls {@link controlAlarms} in its constructor. That installs one `setAlarm`
wrapper on the instance's storage, and the wrapper decides each time that it
is called whether the object may arm an alarm. Three controls apply:

- A fence disables arming on one object while a test needs to run alarm
  passes itself.
- Stopping disables arming and skips the alarm handler on the objects that a
  test used, from the end of that test until the next test starts.
- A call that started in an earlier test cannot arm an alarm. The test
  worker wraps every method of its `CupboardServer` in {@link
  runInTestGeneration}, so each call enters the generation of the test in which
  it started. Work that an earlier test started keeps that test's generation,
  even when a call in a later test waits for the work.

Workerd replaces an instance of a Durable Object when it evicts or resets the
object, and the replacement has its own storage object. The state is
therefore kept by object ID, and a replacement installs its own wrapper.

A test file that calls `vi.resetModules()` gets its own copy of this module,
and so does the test worker when it loads after the reset. All copies use the
state that is stored on `globalThis`, so the shared hooks and the Durable
Objects see the same fences, stopped objects and test generation.
*/

interface AlarmControls {
	readonly fenceDepths: Map<string, number>;
	readonly ignoredDeliveries: Set<string>;
	readonly stoppedObjects: Set<string>;
	readonly armedObjects: Map<string, DurableObjectId>;
	readonly controlledStorage: WeakSet<DurableObjectStorage>;
	/**
	Contains the test generation in which the running call started. The
	generation is in the context of each call and not in the state of the
	object, so a call that workerd aborts leaves nothing behind.
	*/
	readonly callGenerations: AsyncLocalStorage<number>;
	/**
	Counts the tests that have ended.
	*/
	generation: number;
}

function createControls(): AlarmControls {
	return {
		fenceDepths: new Map(),
		ignoredDeliveries: new Set(),
		stoppedObjects: new Set(),
		armedObjects: new Map(),
		controlledStorage: new WeakSet(),
		callGenerations: new AsyncLocalStorage(),
		generation: 0
	};
}

// The state can come from another copy of this module, so the check looks at
// the fields.
function isAlarmControls(value: unknown): value is AlarmControls {
	return (
		typeof value === 'object' &&
		value !== null &&
		'fenceDepths' in value &&
		value.fenceDepths instanceof Map &&
		'ignoredDeliveries' in value &&
		value.ignoredDeliveries instanceof Set &&
		'stoppedObjects' in value &&
		value.stoppedObjects instanceof Set &&
		'armedObjects' in value &&
		value.armedObjects instanceof Map &&
		'controlledStorage' in value &&
		value.controlledStorage instanceof WeakSet &&
		'callGenerations' in value &&
		value.callGenerations instanceof AsyncLocalStorage &&
		'generation' in value &&
		typeof value.generation === 'number'
	);
}

const controlsKey = Symbol.for('cupboard.test.alarm-controls');

function sharedControls(): AlarmControls {
	const existing: unknown = Reflect.get(globalThis, controlsKey);

	if (isAlarmControls(existing)) {
		return existing;
	}

	const created = createControls();
	Reflect.set(globalThis, controlsKey, created);

	return created;
}

const controls = sharedControls();

function isArmingAllowed(id: string): boolean {
	if (controls.fenceDepths.has(id) || controls.stoppedObjects.has(id)) {
		return false;
	}

	const callGeneration = controls.callGenerations.getStore();

	return callGeneration === undefined || callGeneration === controls.generation;
}

/**
Installs the alarm controls on an instance's storage, once. Call it before the
instance's constructor runs so that alarms armed during construction are
controlled too.
*/
export function controlAlarms(state: DurableObjectState): void {
	const { storage } = state;

	if (controls.controlledStorage.has(storage)) {
		return;
	}

	controls.controlledStorage.add(storage);
	const id = state.id.toString();
	const armAlarm = storage.setAlarm.bind(storage);

	storage.setAlarm = (time, options) => {
		if (!isArmingAllowed(id)) {
			return Promise.resolve();
		}

		controls.armedObjects.set(id, state.id);

		return armAlarm(time, options);
	};
}

export class AlarmFenceNotOpenError extends Error {
	constructor(public readonly objectId: string) {
		super('An alarm fence was closed without an open fence for the object');
		this.name = 'AlarmFenceNotOpenError';
	}
}

export function isAlarmFenceOpen(state: DurableObjectState): boolean {
	return controls.fenceDepths.has(state.id.toString());
}

/**
Opens a fence for the object. Overlapping fences share a count, and arming
stays disabled until the last of them closes.
*/
export function openAlarmFence(state: DurableObjectState): void {
	const id = state.id.toString();

	controlAlarms(state);
	controls.fenceDepths.set(id, (controls.fenceDepths.get(id) ?? 0) + 1);
}

export function closeAlarmFence(state: DurableObjectState): void {
	const id = state.id.toString();
	const depth = controls.fenceDepths.get(id);

	if (depth === undefined) {
		throw new AlarmFenceNotOpenError(id);
	}

	if (depth > 1) {
		controls.fenceDepths.set(id, depth - 1);

		return;
	}

	controls.fenceDepths.delete(id);
}

/**
Makes the test worker's `CupboardServer` ignore alarms that workerd delivers
to the object, until {@link deliverAlarms} is called. A test then runs each
pass itself with `runAlarmPass`.

Workerd delivers an alarm that is already due even after `deleteAlarm`, and
an alarm fence only stops new arming. The set is kept by object ID, so it
also applies to an instance that replaces the object.
*/
export function ignoreAlarmDeliveries(id: DurableObjectId): void {
	controls.ignoredDeliveries.add(id.toString());
}

export function deliverAlarms(id: DurableObjectId): void {
	controls.ignoredDeliveries.delete(id.toString());
}

/**
Runs `call` in the current test generation, unless a generation already
applies. A `setAlarm` call that `call` makes, directly or after an await, is
refused once a later test has started.
*/
export function runInTestGeneration<T>(call: () => T): T {
	if (controls.callGenerations.getStore() !== undefined) {
		return call();
	}

	return controls.callGenerations.run(controls.generation, call);
}

/**
Runs the object's alarm handler unless a test has ignored deliveries to the
object or stopped its alarms. A skipped handler returns at once. The handler
runs in the current test generation.
*/
export function runAlarmHandler(
	state: DurableObjectState,
	handler: () => Promise<void>
): Promise<void> {
	const id = state.id.toString();

	if (controls.ignoredDeliveries.has(id) || controls.stoppedObjects.has(id)) {
		return Promise.resolve();
	}

	return runInTestGeneration(handler);
}

/**
Stops alarms at the end of a test on `used` and on every object that armed an
alarm during the test. A stopped object does not arm alarms, and its alarm
handler returns at once. The caller deletes the armed alarms of the returned
objects.

Deleting an armed alarm is not enough. A handler that is already running can
arm another alarm after the deletion, and workerd still delivers an alarm that
was already due when `deleteAlarm` ran. This function covers deliveries until
the next test starts. A call that is still running after its test has ended,
such as a request, an RPC call or an alarm handler, cannot arm alarms, because
its call context contains an earlier test generation. Work that an earlier
test started keeps that generation even when a later call waits for it, for
example the migration promise that an object shares between calls. The retry
alarm of that migration is refused without a log. An alarm that workerd
delivers after the next test has started runs normally, because a call from
the test itself cannot be told apart from it.

A test file that calls `vi.resetModules()` still gets this behaviour, because
every copy of the module uses the same state.
*/
export function stopAlarms(used: Iterable<DurableObjectId>): DurableObjectId[] {
	const objects = new Map(controls.armedObjects);

	for (const id of used) {
		objects.set(id.toString(), id);
	}

	for (const id of objects.keys()) {
		controls.stoppedObjects.add(id);
	}

	controls.armedObjects.clear();
	controls.generation += 1;

	return objects.values().toArray();
}

/**
Lets every object that {@link stopAlarms} stopped arm and run alarms again.
The shared `beforeEach` calls it at the start of each test.
*/
export function resumeAlarms(): void {
	controls.stoppedObjects.clear();
}
