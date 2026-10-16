import { AsyncLocalStorage } from 'node:async_hooks';

import { DatabaseCostMeter } from './database-cost-meter.ts';
import { wrapDispatchedMethods } from './dispatch-scope.ts';

export type R2Operation = 'head' | 'get' | 'put' | 'delete' | 'list';

/**
 * What one request or pass spent on billed storage.
 *
 * `rowsRead` and `rowsWritten` count Durable Object SQLite rows. The D1 row
 * fields count only the calls whose results include `meta`: `run`, `all` and
 * `batch`. `raw`, `first` and `exec` results have no row counts, so those calls
 * are counted in `d1CallsWithoutRows`. Drizzle runs selects through `raw`.
 */
export interface OperationCostRecord {
	readonly rowsRead: number;
	readonly rowsWritten: number;
	readonly d1Calls: number;
	readonly d1RowsRead: number;
	readonly d1RowsWritten: number;
	readonly d1CallsWithoutRows: number;
	readonly r2Head: number;
	readonly r2Get: number;
	readonly r2Put: number;
	readonly r2Delete: number;
	readonly r2List: number;
}

/**
 * The cost of one scope. Counts go to the innermost open scope only, so every
 * binding call and SQLite row appears in at most one scope.
 */
export class OperationCost {
	private d1Calls = 0;
	private d1RowsRead = 0;
	private d1RowsWritten = 0;
	private d1CallsWithoutRows = 0;
	private readonly r2Calls: Record<R2Operation, number> = {
		head: 0,
		get: 0,
		put: 0,
		delete: 0,
		list: 0
	};

	readonly sqlite = new DatabaseCostMeter();

	/**
	 * The route template of the request that this scope measures, when a router
	 * more specific than the request middleware matched it.
	 */
	route: string | undefined;

	constructor(readonly label: string) {}

	recordR2Call(operation: R2Operation): void {
		this.r2Calls[operation] += 1;
	}

	recordD1Call(hasRowCounts: boolean): void {
		this.d1Calls += 1;

		if (!hasRowCounts) {
			this.d1CallsWithoutRows += 1;
		}
	}

	recordD1Rows(results: readonly D1Response[]): void {
		for (const { meta } of results) {
			this.d1RowsRead += meta.rows_read;
			this.d1RowsWritten += meta.rows_written;
		}
	}

	settle(): OperationCostRecord {
		this.sqlite.recordOutstanding();

		return {
			rowsRead: this.sqlite.rowsRead,
			rowsWritten: this.sqlite.rowsWritten,
			d1Calls: this.d1Calls,
			d1RowsRead: this.d1RowsRead,
			d1RowsWritten: this.d1RowsWritten,
			d1CallsWithoutRows: this.d1CallsWithoutRows,
			r2Head: this.r2Calls.head,
			r2Get: this.r2Calls.get,
			r2Put: this.r2Calls.put,
			r2Delete: this.r2Calls.delete,
			r2List: this.r2Calls.list
		};
	}
}

// Requests and passes interleave at await points. Async-local storage keeps
// each one's counts apart.
const scope = new AsyncLocalStorage<OperationCost>();

export function currentOperationCost(): OperationCost | undefined {
	return scope.getStore();
}

/**
 * Whether any counter in `cost` is above zero. A scope that touched no billed
 * storage is not logged.
 */
export function hasCost(cost: OperationCostRecord): boolean {
	return Object.values(cost).some((count) => count > 0);
}

/**
 * Runs `body` in a new scope labelled `label` and reports the scope's cost when
 * `body` resolves or rejects.
 */
export async function withOperationCost<T>(
	label: string,
	body: () => Promise<T>,
	report: (cost: OperationCostRecord) => void
): Promise<T> {
	const cost = new OperationCost(label);

	return scope.run(cost, async () => {
		try {
			return await body();
		} finally {
			report(cost.settle());
		}
	});
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'then' in value &&
		typeof value.then === 'function'
	);
}

/**
 * Runs a dispatched method in a scope labelled `label`, or in the enclosing
 * scope when one is open. A dispatched method may be synchronous: Durable
 * Object SQLite runs synchronously, so a method that never awaits still spends
 * rows.
 */
function withDispatchOperationCost(
	label: string,
	body: () => unknown,
	report: (cost: OperationCostRecord) => void
): unknown {
	if (scope.getStore() !== undefined) {
		return body();
	}

	const cost = new OperationCost(label);

	return scope.run(cost, () => {
		let result: unknown;

		try {
			result = body();
		} catch (error) {
			report(cost.settle());
			throw error;
		}

		if (!isPromiseLike(result)) {
			report(cost.settle());

			return result;
		}

		return reportWhenSettled(result, () => {
			report(cost.settle());
		});
	});
}

async function reportWhenSettled(
	result: PromiseLike<unknown>,
	report: () => void
): Promise<unknown> {
	try {
		return await result;
	} finally {
		report();
	}
}

/**
 * Wraps every method on `prototype` so each dispatch opens a scope labelled with
 * the dispatched method. Costs that no narrower scope claims are reported
 * there.
 */
export function enterOperationCostOnDispatch(
	prototype: object,
	report: (method: string, cost: OperationCostRecord) => void
): void {
	wrapDispatchedMethods(prototype, (body, _receiver, method) =>
		withDispatchOperationCost(method, body, (cost) => {
			report(method, cost);
		})
	);
}

/**
 * Records the route template that the current request matched. A router that
 * dispatches below the request middleware calls this, because `routePath`
 * returns only the catch-all pattern of the middleware that runs the router.
 */
export function recordRoute(route: string): void {
	const cost = scope.getStore();

	if (cost !== undefined) {
		cost.route = route;
	}
}
