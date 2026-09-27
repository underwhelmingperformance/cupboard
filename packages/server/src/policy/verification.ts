const initialPendingSettleRetryMs = 30_000;
const maxPendingSettleRetryMs = 10 * 60_000;

export function pendingSettleRetryDelayMs(failures: number): number {
	return Math.min(
		initialPendingSettleRetryMs * 2 ** Math.min(failures - 1, 5),
		maxPendingSettleRetryMs
	);
}
