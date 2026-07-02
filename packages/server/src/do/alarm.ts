/**
 * Arms the Durable Object alarm for `at` unless one is already set to fire
 * sooner. A DO carries a single alarm and `setAlarm` overwrites it, so a
 * far-out deadline must never push back an imminent firing. Immediate
 * continuations (`setAlarm(Date.now())`) stay as bare calls, since nothing can
 * be sooner; any deadline in the future arms through here.
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
