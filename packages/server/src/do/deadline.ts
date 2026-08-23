import { AsyncLocalStorage } from 'node:async_hooks';

import { withDeadline } from '@cupboard/shared/timeout';

import { SubrequestTimeoutError } from '../errors.ts';

// A `blockConcurrencyWhile` callback that runs for about 30 seconds resets the
// Durable Object. Keep the collective critical-section budget below that limit
// so a stalled subrequest returns a retryable error before the reset.
export const criticalSectionBudgetMs = 25_000;

// Metadata calls always use the per-call limit. R2 byte transfers may take
// longer outside a critical section and inherit only the collective budget
// when they run inside one.
const perCallCapMs = 15_000;

const deadlineScope = new AsyncLocalStorage<number>();

/**
A nested budget can shorten, but never extend, the current deadline.
*/
export function withDeadlineBudget<T>(
	budgetMs: number,
	body: () => Promise<T>
): Promise<T> {
	const proposed = Date.now() + budgetMs;
	const outer = deadlineScope.getStore();
	const deadline = outer === undefined ? proposed : Math.min(outer, proposed);

	return deadlineScope.run(deadline, body);
}

/**
 * Bounds one subrequest by the remaining scope budget and `capMs`. Byte
 * transfers pass an infinite cap, so this layer limits them only inside a
 * deadline scope. A timed-out operation can still finish and must be safe to
 * retry.
 */
export function boundedSubrequest<T>(
	operation: () => Promise<T>,
	subrequest: string,
	capMs: number = perCallCapMs
): Promise<T> {
	const deadline = deadlineScope.getStore();
	const remaining = deadline === undefined ? Infinity : deadline - Date.now();
	const ms = Math.min(remaining, capMs);

	if (!Number.isFinite(ms)) {
		return operation();
	}

	if (ms <= 0) {
		return Promise.reject(new SubrequestTimeoutError(subrequest));
	}

	return withDeadline(
		operation,
		ms,
		(abandoned) => new SubrequestTimeoutError(subrequest, abandoned)
	);
}

export const unboundedCapMs = Infinity;
