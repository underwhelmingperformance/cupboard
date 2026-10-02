import { RetryPolicy } from './retry.ts';

export function pendingSettleRetryDelayMs(failures: number): number {
	return new RetryPolicy('verification').delayAfterFailure(failures);
}
