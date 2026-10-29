import { AsyncLocalStorage } from 'node:async_hooks';

import { getLogger } from '@cupboard/logger';
import { withDeadline } from '@cupboard/shared/timeout';

import { SubrequestTimeoutError } from '../errors.ts';

// A `blockConcurrencyWhile` callback that runs for about 30 seconds resets the
// Durable Object. Keep the collective critical-section budget below that limit
// so a stalled subrequest returns a retryable error before the reset.
export const criticalSectionBudgetMs = 25_000;

const perCallCapMs = 15_000;

interface DeadlineScope {
	readonly deadline: number;
	readonly signal: AbortSignal;
}

const deadlineScope = new AsyncLocalStorage<DeadlineScope>();
const deadlineExpired = Symbol('deadline-expired');
const logger = getLogger(['cupboard', 'storage']);

/**
Runs `body` within a deadline that cannot extend an enclosing deadline.
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
Returns the signal for the current deadline scope. Callers use this signal
as a control-flow boundary before state changes that follow awaited work.

A deadline bounds a scope by aborting it, and an abort takes effect only
where the code awaits. Work that runs to completion without awaiting is
therefore bounded by no deadline, however long it takes, and a clock
cannot be substituted for the signal to bound it. In production neither
`Date.now()` nor `performance.now()` advances during synchronous work; in
the local runtime both do. A bound built on either passes its local tests
and never fires in production. Bound synchronous work by what it consumes
instead.
*/
export function currentDeadlineSignal(): AbortSignal | undefined {
	return deadlineScope.getStore()?.signal;
}

export function remainingDeadlineMs(): number | undefined {
	const scope = deadlineScope.getStore();

	return scope === undefined
		? undefined
		: Math.max(0, scope.deadline - Date.now());
}

export interface PendingSubrequestRecord {
	readonly operation: string;
	readonly elapsedMs: number;
}

interface PendingSubrequest {
	readonly operation: string;
	readonly startedAt: number;
}

/**
The bounded subrequests that one critical section has started and that have
not yet resolved or rejected. A subrequest stays here after its deadline
abandons it, until the binding's own call finishes.
*/
export class SectionSubrequests {
	private readonly pending = new Set<PendingSubrequest>();
	private deadlineWatch:
		| { readonly deadline: AbortSignal; readonly onReached: () => void }
		| undefined;

	/**
	Calls `onReached` when a bounded subrequest of the section times out at
	`deadline`. The subrequest's timer and the deadline's own timer are due at
	the same instant, and either can fire first.
	*/
	watchDeadline(deadline: AbortSignal, onReached: () => void): void {
		this.deadlineWatch = { deadline, onReached };
	}

	/**
	Stops calling the watch's callback. A subrequest that the section left
	running can time out after the section has ended.
	*/
	unwatchDeadline(): void {
		this.deadlineWatch = undefined;
	}

	timedOutAt(deadline: AbortSignal): void {
		if (this.deadlineWatch?.deadline === deadline) {
			this.deadlineWatch.onReached();
		}
	}

	track(operation: string, call: Promise<unknown>): void {
		const entry = { operation, startedAt: Date.now() };
		const remove = (): void => {
			this.pending.delete(entry);
		};

		this.pending.add(entry);
		void call.then(remove).catch(remove);
	}

	snapshot(now: number): PendingSubrequestRecord[] {
		return [...this.pending].map(({ operation, startedAt }) => ({
			operation,
			elapsedMs: now - startedAt
		}));
	}

	/**
	Runs `body` and tracks each bounded subrequest that `body` starts.
	*/
	run<T>(body: () => Promise<T>): Promise<T> {
		return sectionScope.run(this, body);
	}
}

const sectionScope = new AsyncLocalStorage<SectionSubrequests>();

/**
Bounds one subrequest by the remaining scope budget and `capMs`. Uploads
pass an infinite cap, so this layer limits them only inside a deadline
scope. A timed-out operation can still finish and must be safe to retry.
The optional cleanup receives only abandoned results, never a result
returned to the caller.
*/
export async function boundedSubrequest<T>(
	operation: () => Promise<T>,
	subrequest: string,
	capMs: number = perCallCapMs,
	onLateResult?: (result: T) => Promise<void>
): Promise<T> {
	const deadline = deadlineScope.getStore();
	const remaining =
		deadline === undefined ? Infinity : deadline.deadline - Date.now();
	const ms = Math.min(remaining, capMs);
	const started = performance.now();
	const fields = {
		operation: subrequest,
		capMs: Number.isFinite(capMs) ? capMs : undefined,
		remainingBudgetMs: Number.isFinite(remaining)
			? Math.max(0, remaining)
			: undefined,
		deadlineMs: Number.isFinite(ms) ? ms : undefined
	};

	if (ms <= 0 || currentDeadlineSignal()?.aborted === true) {
		logger.debug('storage request refused', {
			...fields,
			disposition: 'budget-exhausted'
		});
		throw new SubrequestTimeoutError(subrequest);
	}

	const completion = { hasTimedOut: false };

	const recordLateCompletion = async (pending: Promise<T>): Promise<void> => {
		let result: T;
		try {
			result = await pending;
		} catch (error) {
			if (completion.hasTimedOut) {
				logger.debug('storage request failed after timeout', {
					...fields,
					elapsedMs: performance.now() - started,
					error
				});
			}
			return;
		}

		if (!completion.hasTimedOut && deadline?.signal.aborted !== true) {
			return;
		}

		logger.debug('storage request completed after timeout', {
			...fields,
			elapsedMs: performance.now() - started
		});

		try {
			await onLateResult?.(result);
		} catch (error) {
			logger.debug('storage late-result cleanup failed', { ...fields, error });
		}
	};
	const execute = (): Promise<T> => {
		logger.trace('storage request started', fields);
		const pending = operation();
		sectionScope.getStore()?.track(subrequest, pending);
		void recordLateCompletion(pending);

		return pending;
	};

	try {
		const result = await (Number.isFinite(ms)
			? withDeadline(execute, ms, (abandoned) => {
					completion.hasTimedOut = true;

					if (deadline !== undefined && remaining <= capMs) {
						sectionScope.getStore()?.timedOutAt(deadline.signal);
					}

					return new SubrequestTimeoutError(subrequest, abandoned);
				})
			: execute());

		if (deadline?.signal.aborted === true) {
			throw new SubrequestTimeoutError(subrequest);
		}

		logger.trace('storage request completed', {
			...fields,
			elapsedMs: performance.now() - started
		});

		return result;
	} catch (error) {
		const failure =
			deadline?.signal.aborted === true &&
			!(error instanceof SubrequestTimeoutError)
				? new SubrequestTimeoutError(subrequest)
				: error;
		logger.debug('storage request failed', {
			...fields,
			elapsedMs: performance.now() - started,
			disposition:
				failure instanceof SubrequestTimeoutError ? 'timeout' : 'failed',
			error: failure
		});

		throw failure;
	}
}

export const unboundedCapMs = Infinity;
