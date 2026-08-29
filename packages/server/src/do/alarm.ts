/**
 * The delay before arming another alarm after a pass makes no progress.
 *
 * A pass that makes progress arms the next alarm immediately. A stalled pass
 * uses this delay to prevent a persistent fault from running alarms back to
 * back.
 */
export const noProgressRetryMs = 30_000;

/**
 * Durable Object storage has one alarm, and `setAlarm` overwrites its current
 * deadline. Keep an earlier deadline when scheduling future work so a later
 * deadline cannot postpone it. Immediate continuations call
 * `setAlarm(Date.now())` directly because no earlier firing is possible.
 */
export async function armAlarmNoLaterThan(
	storage: DurableObjectStorage,
	at: number
): Promise<void> {
	const existing = await storage.getAlarm();

	if (existing === null || existing > at) {
		await storage.setAlarm(at);
	}
}

/**
 * Whether a maintenance pass finished any of the work it tried.
 */
export type MaintenanceProgress = 'progressed' | 'stalled';

// Each pass has its own key and retry deadline. A stalled pass therefore does
// not make another stalled pass due. The keys sit outside every queue prefix.
const maintenanceRetryPrefix = 'maintenance:retry:';

/**
 * Where one maintenance pass records the time before which it must not run
 * again.
 */
export function maintenanceRetryKey(pass: string): string {
	return `${maintenanceRetryPrefix}${pass}`;
}

/**
 * When each maintenance pass may next run.
 *
 * A pass that finished none of its work records a deadline here, and the alarm
 * neither runs it nor treats it as due until that deadline passes. Without the
 * deadline, one stalled pass would report its backlog to the scheduler, the
 * scheduler would arm an immediate alarm for it, and two stalled passes would
 * keep waking each other.
 */
export class MaintenanceRetrySchedule {
	constructor(private readonly storage: DurableObjectStorage) {}

	/**
	 * The time before which the pass must not run again, or `undefined` when it
	 * may run now.
	 */
	async notBefore(key: string): Promise<number | undefined> {
		return this.storage.get<number>(maintenanceRetryKey(key));
	}

	/**
	 * Updates the retry deadline after a pass. Progress clears the deadline, while
	 * a stall delays the pass by {@link noProgressRetryMs}.
	 */
	async record(
		key: string,
		progress: MaintenanceProgress,
		now: number
	): Promise<void> {
		const storageKey = maintenanceRetryKey(key);

		await (progress === 'progressed'
			? this.storage.delete(storageKey)
			: this.storage.put(storageKey, now + noProgressRetryMs));
	}
}
