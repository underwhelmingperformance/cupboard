import { AsyncLocalStorage } from 'node:async_hooks';

import { withDeadline } from '@cupboard/shared/timeout';

import { SubrequestTimeoutError } from '../errors.ts';

// A critical section holds the Durable Object's input gate; the runtime resets
// the whole object if a `blockConcurrencyWhile` callback runs past ~30s. This
// budget bounds the gated subrequests collectively so a stall surfaces as a
// clean retryable refusal well before that reset.
export const criticalSectionBudgetMs = 25_000;

// No single metadata subrequest may outlast this, even outside a critical
// section, so a stalled call on an ungated path cannot silently consume a whole
// invocation. Byte-transfer calls (R2 get/put) pass an unbounded cap instead:
// off the gate a large blob legitimately takes longer, and on the gate the
// section budget already bounds them.
const perCallCapMs = 15_000;

// The absolute epoch-millisecond deadline for the current scope. A nested scope
// only ever tightens it (see {@link withDeadlineBudget}), so the innermost
// deadline is the one every subrequest reads.
const deadlineScope = new AsyncLocalStorage<number>();

// Runs `body` under a deadline `budgetMs` from now, never looser than any
// deadline already in force: a section nested inside a request budget cannot
// extend past the request's own deadline.
export function withDeadlineBudget<T>(
	budgetMs: number,
	body: () => Promise<T>
): Promise<T> {
	const proposed = Date.now() + budgetMs;
	const outer = deadlineScope.getStore();
	const deadline = outer === undefined ? proposed : Math.min(outer, proposed);

	return deadlineScope.run(deadline, body);
}

// Bounds one subrequest by the time left on the scope's deadline, capped at
// `capMs` (default {@link perCallCapMs}). Byte-transfer calls pass an unbounded
// cap so only an enclosing deadline bounds them; outside any scope those run
// unbounded by this layer. A timeout rejects with a retryable
// {@link SubrequestTimeoutError}; the underlying call is abandoned, so
// `operation` must be idempotent.
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

// The unbounded cap for byte-transfer calls: only an enclosing critical-section
// deadline bounds them.
export const unboundedCapMs = Infinity;
