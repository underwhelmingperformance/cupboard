import { AsyncLocalStorage } from 'node:async_hooks';

import { getLogger } from '@cupboard/logger';
import { abortableSleep } from '@cupboard/shared/retry';
import { withDeadline } from '@cupboard/shared/timeout';

import { SubrequestTimeoutError } from '../errors.ts';

// A `blockConcurrencyWhile` callback that runs for about 30 seconds resets the
// Durable Object. Keep the collective critical-section budget below that limit
// so a stalled subrequest returns a retryable error before the reset.
export const criticalSectionBudgetMs = 25_000;

export const perCallCapMs = 15_000;

/**
Waits `ms` milliseconds, or until `signal` aborts, and then resolves. Code
that sets a deadline takes a `Delay`, so a test decides when the deadline
passes.
*/
export type Delay = (ms: number, signal: AbortSignal) => Promise<void>;

/**
The clock of a deadline: `now` for its start and the time that remains of
it, and `delay` to wait for its end. It drives the deadlines of the requests
that a Worker forwards, the deadline scopes of this module, and the bounded
subrequests within those scopes.
*/
export interface DeadlineClock {
	readonly now: () => number;
	readonly delay: Delay;
}

export const systemClock: DeadlineClock = {
	now: () => Date.now(),
	delay: abortableSleep
};

interface DeadlineScope {
	readonly deadline: number;
	readonly signal: AbortSignal;
	readonly clock: DeadlineClock;
}

const deadlineScope = new AsyncLocalStorage<DeadlineScope>();
const deadlineExpired = Symbol('deadline-expired');
const logger = getLogger(['cupboard', 'storage']);

/**
Runs `body` within a deadline that cannot extend an enclosing deadline.

`clock` starts and waits out the deadline of an outermost scope. A nested
scope always uses the clock of the enclosing scope and ignores `clock`, so
the deadlines of nested scopes and of the bounded subrequests within them
are compared on one clock. Without a clock, an outermost scope uses the
system clock.
*/
export async function withDeadlineBudget<T>(
	budgetMs: number,
	body: () => Promise<T>,
	subrequest = 'deadline.scope',
	clock?: DeadlineClock
): Promise<T> {
	const outer = deadlineScope.getStore();
	const scopeClock = outer?.clock ?? clock ?? systemClock;
	const proposed = scopeClock.now() + budgetMs;

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
	const settled = new AbortController();
	const remaining = deadline - scopeClock.now();

	if (remaining <= 0) {
		expire();
	} else {
		void scopeClock.delay(remaining, settled.signal).then(() => {
			if (!settled.signal.aborted) {
				expire();
			}
		});
	}

	let result: T;

	try {
		result = await deadlineScope.run(
			{ deadline, signal: controller.signal, clock: scopeClock },
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
		settled.abort();
		outer?.signal.removeEventListener('abort', onOuterAbort);
	}

	if (controller.signal.aborted) {
		throw new SubrequestTimeoutError(subrequest);
	}

	return result;
}

/**
A deadline fixed when it is created. Each call of {@link run} gets only what
remains of it, so steps that run apart, with other work between them, share
one budget.
*/
export class SharedDeadline {
	private readonly deadline: number;

	/**
	@param now The clock that the deadline starts and ends on.
	*/
	constructor(
		budgetMs: number,
		private readonly now: () => number = Date.now
	) {
		this.deadline = now() + budgetMs;
	}

	/**
	Runs `body` within what remains of this deadline, or within an enclosing
	deadline that ends sooner.
	*/
	run<T>(body: () => Promise<T>, subrequest?: string): Promise<T> {
		return withDeadlineBudget(this.remainingMs(), body, subrequest);
	}

	remainingMs(): number {
		return Math.max(0, this.deadline - this.now());
	}
}

/**
How long a request forwarded to the tenant object may wait for its response
headers, when the request does not have the default operation deadline.
*/
export type ForwardDeadline =
	| { readonly kind: 'read'; readonly deadline: SharedDeadline }
	| { readonly kind: 'unbounded' };

const forwardDeadlineScope = new AsyncLocalStorage<ForwardDeadline>();

/**
Runs `body` with `deadline` as the current read deadline. A forwarded request
to the tenant object that `body` sends must return its response headers
within what remains of it. Unlike {@link SharedDeadline.run}, the deadline
does not abort the scope: the code that waits for the response applies it.
*/
export function withinReadDeadline<T>(
	deadline: SharedDeadline,
	body: () => Promise<T>
): Promise<T> {
	return forwardDeadlineScope.run({ kind: 'read', deadline }, body);
}

/**
Runs `body` so that a request that it forwards to the tenant object waits
for the response without a deadline. Use it only for a route where the
object does not bound the time of its work, because any fixed deadline could
then end a healthy request.
*/
export function withoutForwardDeadline<T>(body: () => Promise<T>): Promise<T> {
	return forwardDeadlineScope.run({ kind: 'unbounded' }, body);
}

/**
Returns the deadline that {@link withinReadDeadline} or
{@link withoutForwardDeadline} set for the current scope, if any.
*/
export function currentForwardDeadline(): ForwardDeadline | undefined {
	return forwardDeadlineScope.getStore();
}

/**
A read that the control Worker sends to the tenant Worker: a narinfo, one of
the narinfo reads of a `path-info` probe, or a NAR.
*/
export type TenantWorkerRead = 'narinfo' | 'path-info-narinfo' | 'nar';

/**
The read that a fetch on the tenant Worker's service binding sends, and the
deadline for its response headers.
*/
export interface TenantWorkerReadDeadline {
	readonly read: TenantWorkerRead;
	readonly deadline: SharedDeadline;
}

const tenantWorkerReadScope = new AsyncLocalStorage<TenantWorkerReadDeadline>();

/**
Runs `body` with `read` as the current read on the tenant Worker's service
binding. A fetch on the binding that `body` sends must return its response
headers within what remains of `read.deadline`.
*/
export function withinTenantWorkerRead<T>(
	read: TenantWorkerReadDeadline,
	body: () => Promise<T>
): Promise<T> {
	return tenantWorkerReadScope.run(read, body);
}

/**
Returns the read that {@link withinTenantWorkerRead} set for the current
scope, if any.
*/
export function currentTenantWorkerRead():
	TenantWorkerReadDeadline | undefined {
	return tenantWorkerReadScope.getStore();
}

/**
Runs `body` outside every deadline scope.

Work that continues after a handler returns, such as a response body, must
start its own scope here. The handler's scope stops its timer when the
handler returns, and a scope nested inside it can never outlast it.
*/
export function withoutDeadline<T>(body: () => T): T {
	return deadlineScope.exit(body);
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
		: Math.max(0, scope.deadline - scope.clock.now());
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
		deadline === undefined
			? Infinity
			: deadline.deadline - deadline.clock.now();
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
