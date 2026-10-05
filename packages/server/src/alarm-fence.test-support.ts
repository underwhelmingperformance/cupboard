/**
 * Alarm fences for the Workers test pool. A fence disables `setAlarm` on a
 * Durable Object while it is open.
 *
 * Workerd replaces an instance of a Durable Object when it evicts or resets
 * the object, and the replacement has its own storage object. The fence depth
 * is therefore kept by object ID. The test worker's `CupboardServer` calls
 * {@link applyAlarmFence} in its constructor, so a replacement constructed
 * while a fence is open also has alarm arming disabled.
 */

const fenceDepths = new Map<string, number>();

const savedArming = new WeakMap<
	DurableObjectStorage,
	DurableObjectStorage['setAlarm']
>();

function suspendArming(storage: DurableObjectStorage): void {
	if (savedArming.has(storage)) {
		return;
	}

	savedArming.set(storage, storage.setAlarm.bind(storage));
	storage.setAlarm = () => Promise.resolve();
}

function restoreArming(storage: DurableObjectStorage): void {
	const armAlarm = savedArming.get(storage);

	if (armAlarm === undefined) {
		return;
	}

	storage.setAlarm = armAlarm;
	savedArming.delete(storage);
}

export class AlarmFenceNotOpenError extends Error {
	constructor(public readonly objectId: string) {
		super('An alarm fence was closed without an open fence for the object');
		this.name = 'AlarmFenceNotOpenError';
	}
}

/**
Disables alarm arming on a new instance if a fence is open for its object.
*/
export function applyAlarmFence(state: DurableObjectState): void {
	if (fenceDepths.has(state.id.toString())) {
		suspendArming(state.storage);
	}
}

export function isAlarmFenceOpen(state: DurableObjectState): boolean {
	return fenceDepths.has(state.id.toString());
}

/**
 * Opens a fence for the object. Overlapping fences share a count, and arming
 * stays disabled until the last of them closes.
 */
export function openAlarmFence(state: DurableObjectState): void {
	const id = state.id.toString();

	fenceDepths.set(id, (fenceDepths.get(id) ?? 0) + 1);
	suspendArming(state.storage);
}

export function closeAlarmFence(state: DurableObjectState): void {
	const id = state.id.toString();
	const depth = fenceDepths.get(id);

	if (depth === undefined) {
		throw new AlarmFenceNotOpenError(id);
	}

	if (depth > 1) {
		fenceDepths.set(id, depth - 1);

		return;
	}

	fenceDepths.delete(id);
	restoreArming(state.storage);
}
