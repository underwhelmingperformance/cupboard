import { AsyncLocalStorage } from 'node:async_hooks';

import { admitBoundParameters } from './statement-admission.ts';

type AnyCursor = SqlStorageCursor<Record<string, SqlStorageValue>>;

export interface DatabaseCost {
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

/**
 * Adds up the rows that Durable Object SQLite reads and writes, which is how
 * Cloudflare bills it.
 *
 * A cursor's totals cover one statement. `sql.exec` accepts a query string
 * holding several, and the runtime returns a cursor for only one of them, so
 * the totals for such a string come out short: a two-statement string reading
 * 25 rows reports 20, and `UPDATE ...; SELECT 1` over 20 rows reports nothing
 * written. A count lower than the work suggests is the sign of one.
 *
 * The binding cannot refuse a string like that. A semicolon can sit inside a
 * single statement, as it does in a `CREATE TRIGGER` body, and `SqlStorage`
 * offers no way to ask how many statements a string holds. workerd rejects a
 * multi-statement string that binds parameters, so only one with no bindings
 * reaches this case. These totals are logged and nothing reads them back, so
 * the effect is confined to those logs.
 */
export class DatabaseCostMeter {
	private outstanding: AnyCursor | undefined;
	rowsRead = 0;
	rowsWritten = 0;

	// A cursor's row totals become final only after Drizzle consumes it. Account
	// for the preceding cursor when the next statement starts.
	track<T extends Record<string, SqlStorageValue>>(
		cursor: SqlStorageCursor<T>
	): SqlStorageCursor<T> {
		this.recordOutstanding();
		this.outstanding = cursor;

		return cursor;
	}

	recordOutstanding(): void {
		if (this.outstanding === undefined) {
			return;
		}

		this.rowsRead += this.outstanding.rowsRead;
		this.rowsWritten += this.outstanding.rowsWritten;
		this.outstanding = undefined;
	}
}

// Requests can interleave at await points. Async-local storage prevents one
// request from including another request's database rows.
const requestMeter = new AsyncLocalStorage<DatabaseCostMeter>();

/**
 * Isolates the row count for `body` from interleaved requests and reports the
 * final count whether `body` returns or throws.
 */
export async function withRequestCost<T>(
	body: () => Promise<T>,
	report: (cost: DatabaseCost) => void
): Promise<T> {
	const meter = new DatabaseCostMeter();

	return requestMeter.run(meter, async () => {
		try {
			return await body();
		} finally {
			meter.recordOutstanding();
			report({ rowsRead: meter.rowsRead, rowsWritten: meter.rowsWritten });
		}
	});
}

// Keep the platform cursor unchanged. Drizzle consumes it before the next
// statement, which is when the lifetime, request and scoped meters record it.
function meteredSql(
	sql: SqlStorage,
	cumulative: DatabaseCostMeter,
	scoped: () => DatabaseCostMeter | undefined
): SqlStorage {
	return {
		exec<T extends Record<string, SqlStorageValue>>(
			query: string,
			...bindings: unknown[]
		): SqlStorageCursor<T> {
			admitBoundParameters(bindings.length);

			const cursor = sql.exec<T>(query, ...bindings);
			cumulative.track(cursor);
			requestMeter.getStore()?.track(cursor);
			scoped()?.track(cursor);

			return cursor;
		},
		get databaseSize() {
			return sql.databaseSize;
		},
		Cursor: sql.Cursor,
		Statement: sql.Statement
	};
}

// Bind pass-through methods to the platform storage. These host methods depend
// on their receiver and fail when invoked through an ordinary proxy receiver.
//
// `scoped` is looked up per statement rather than passed as a meter, because
// the meter it returns belongs to whichever budget scope is open when the
// statement runs, not to the storage wrapper's lifetime.
export function meteredStorage(
	storage: DurableObjectStorage,
	meter: DatabaseCostMeter,
	scoped: () => DatabaseCostMeter | undefined = (): undefined => undefined
): DurableObjectStorage {
	const sql = meteredSql(storage.sql, meter, scoped);
	const boundMethods = new Map<PropertyKey, unknown>();

	return new Proxy(storage, {
		get(target, property) {
			if (property === 'sql') {
				return sql;
			}

			const value: unknown = Reflect.get(target, property, target);

			if (typeof value !== 'function') {
				return value;
			}

			const cached = boundMethods.get(property);
			if (cached !== undefined) {
				return cached;
			}

			const bound: unknown = value.bind(target);
			boundMethods.set(property, bound);

			return bound;
		}
	});
}
