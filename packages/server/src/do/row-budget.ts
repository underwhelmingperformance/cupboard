import { AsyncLocalStorage } from 'node:async_hooks';

import { MissingRowBudgetError } from '../errors.ts';

import { DatabaseCostMeter } from './database-cost-meter.ts';
import { currentDeadlineSignal } from './deadline.ts';
import { wrapDispatchedMethods } from './dispatch-scope.ts';

/**
 * How many Durable Object SQLite rows one invocation reads and writes before a
 * pass defers the rest of its work.
 *
 * This is a work-unit size and it is chosen, not derived. Durable Object SQLite
 * caps neither statements nor rows per invocation, so it stands in for no
 * platform limit. What it decides is how much a pass does before it stops and
 * leaves the rest for the next invocation: too small spends extra invocations
 * on the same work, too large makes one pass take longer to finish.
 *
 * Rows are the unit because they are the one quantity a pass can watch itself
 * spend as it runs, and the storage binding already counts them for billing.
 * Every Durable Object request logs its `rowsRead` and `rowsWritten`, so
 * production traces are the evidence for changing this number.
 *
 * A row is not a fixed amount of work. A statement that binds its list as one
 * JSON parameter reads it through `json_each`, and SQLite counts every element
 * as a row read, so a lookup of N values costs N row reads; `json-list.ts`
 * states that fact where the binding happens. How many rows a pass spends
 * therefore depends on how its statements bind their lists, which is why a row
 * count measured against different statements does not transfer to this
 * number.
 */
const rowsPerInvocation = 25_000;

/**
 * One invocation's remaining Durable Object row allowance.
 *
 * The storage binding debits the budget as statements run, so a pass cannot
 * spend rows the budget does not see.
 */
class RowBudget {
	readonly meter = new DatabaseCostMeter();

	constructor(private readonly rows: number) {}

	get spent(): number {
		// A cursor's totals are final only once Drizzle has consumed it, so settle
		// the outstanding one before reporting.
		this.meter.recordOutstanding();

		return this.meter.rowsRead + this.meter.rowsWritten;
	}

	get remaining(): number {
		// A pass must not begin another step in a scope that has already been
		// aborted, however many rows it has left to spend.
		if (currentDeadlineSignal()?.aborted === true) {
			return 0;
		}

		return Math.max(0, this.rows - this.spent);
	}
}

const budgetScope = new AsyncLocalStorage<RowBudget>();

/**
 * Runs `body` under one invocation's row budget.
 *
 * A nested call reuses the enclosing budget, so a method that calls another
 * method of the same object shares the one budget for the invocation.
 *
 * The body may be synchronous or asynchronous. `sql.exec` is synchronous, so a
 * pass that never awaits still spends and observes the budget.
 */
export function withRowBudget<T>(
	body: () => T,
	rows: number = rowsPerInvocation
): T {
	if (budgetScope.getStore() !== undefined) {
		return body();
	}

	return budgetScope.run(new RowBudget(rows), body);
}

/**
 * The meter the storage binding debits for the current budget. Outside a
 * budget this is undefined and the binding tracks nothing extra.
 */
export function currentRowBudgetMeter(): DatabaseCostMeter | undefined {
	return budgetScope.getStore()?.meter;
}

/**
 * How many rows the current invocation may still read and write.
 *
 * This reaches zero once the rows are spent, and also once an enclosing
 * deadline scope has been aborted, because a pass must not begin another step
 * there.
 *
 * Callers must run under a dispatched Durable Object method. This throws
 * outside a budget rather than reporting an allowance nothing is debiting.
 */
export function rowsRemaining(): number {
	const budget = budgetScope.getStore();

	if (budget === undefined) {
		throw new MissingRowBudgetError();
	}

	return budget.remaining;
}

/**
 * Whether the current invocation has spent its work unit.
 *
 * Ask this *after* completing a unit of work, never before starting one.
 * Unlike the D1 statement allowance, a row budget cannot refuse work in
 * advance, because a statement's row count is known only once it has run. So a
 * pass runs a unit, asks this, and stops before starting another.
 *
 * Asking afterwards is also what guarantees forward progress: the first unit
 * always runs, so a pass makes progress however little budget it inherits and
 * can never spin without doing work.
 */
export function isRowBudgetExhausted(): boolean {
	return rowsRemaining() === 0;
}

/**
 * Wraps every method on `prototype` so each dispatch enters the invocation's
 * row budget, and so each dispatch shares one budget.
 */
export function enterRowBudgetOnDispatch(prototype: object): void {
	wrapDispatchedMethods(prototype, withRowBudget);
}
