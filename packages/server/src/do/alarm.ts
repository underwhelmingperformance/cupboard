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
