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

interface DeadlineScope {
	readonly deadline: number;
	readonly signal: AbortSignal;
}

const deadlineScope = new AsyncLocalStorage<DeadlineScope>();
const deadlineExpired = Symbol('deadline-expired');

/**
 * Runs `body` within a deadline that cannot extend an enclosing deadline.
 */
export async function withDeadlineBudget<T>(
	budgetMs: number,
	body: () => Promise<T>,
	subrequest = 'deadline.scope'
): Promise<T> {
	const proposed = Date.now() + budgetMs;
	const outer = deadlineScope.getStore();

	if (outer !== undefined && outer.deadline <= proposed) {
		return deadlineScope.run(outer, body);
	}

	const controller = new AbortController();
	const deadline =
		outer === undefined ? proposed : Math.min(outer.deadline, proposed);
	const onOuterAbort = (): void => {
		if (outer !== undefined) {
			controller.abort(outer.signal.reason);
		}
	};

	if (outer?.signal.aborted === true) {
		onOuterAbort();
	} else {
		outer?.signal.addEventListener('abort', onOuterAbort, { once: true });
	}

	const expire = (): void => {
		controller.abort(deadlineExpired);
	};
	const remaining = deadline - Date.now();
	const timer = remaining <= 0 ? undefined : setTimeout(expire, remaining);

	if (remaining <= 0) {
		expire();
	}

	let result: T;

	try {
		result = await deadlineScope.run(
			{ deadline, signal: controller.signal },
			body
		);
	} catch (error) {
		if (
			controller.signal.aborted &&
			!(error instanceof SubrequestTimeoutError)
		) {
			throw new SubrequestTimeoutError(subrequest);
		}

		throw error;
	} finally {
		clearTimeout(timer);
		outer?.signal.removeEventListener('abort', onOuterAbort);
	}

	if (controller.signal.aborted) {
		throw new SubrequestTimeoutError(subrequest);
	}

	return result;
}

/**
 * Returns the signal for the current deadline scope. Callers use this signal
 * as a control-flow boundary before state changes that follow awaited work.
 */
export function currentDeadlineSignal(): AbortSignal | undefined {
	return deadlineScope.getStore()?.signal;
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
	const remaining =
		deadline === undefined ? Infinity : deadline.deadline - Date.now();
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
