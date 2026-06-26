import { AsyncLocalStorage } from 'node:async_hooks';

// The Durable Object is billed per row its SQLite reads, and a row-heavy request
// is invisible until it shows up on the daily bill. This meter sums the rows read
// and written across every statement, so the figure can be logged when the
// request ends and asserted on in tests.
//
// A read cursor's `rowsRead` is final only once its rows have been read out, and a
// write reports its `rowsWritten` as it runs. Drizzle's Durable Object session
// drains each cursor to completion inside the fielded `.all()`/`.get()` call that
// issued it, so a statement's totals are settled by the time the next statement
// starts. The meter folds the outstanding cursor's totals in on each new statement
// and settles the last at the request boundary. A write (`run`) does not iterate a
// cursor at all, but `exec` reports its `rowsWritten` as it runs, so the figure is
// final the moment the statement returns. This holds for the query builder; a raw
// fieldless `db.get(sql`...`)`, which streams its cursor lazily, would settle before
// it is drained, but the schema layer issues no such call. The real cursor is never
// wrapped, so the query layer sees the platform object unchanged.
type AnyCursor = SqlStorageCursor<Record<string, SqlStorageValue>>;

export interface DatabaseCost {
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

export class DatabaseCostMeter {
	private outstanding: AnyCursor | undefined;
	rowsRead = 0;
	rowsWritten = 0;

	// Records a statement's cursor and settles the previous one, whose query has
	// since finished consuming it. Returns the cursor untouched for the caller.
	track<T extends Record<string, SqlStorageValue>>(
		cursor: SqlStorageCursor<T>
	): SqlStorageCursor<T> {
		this.settle();
		this.outstanding = cursor;

		return cursor;
	}

	// Folds the outstanding cursor's final totals into the running counts. Called
	// before each new statement and once at the request boundary; a no-op when no
	// cursor is outstanding.
	settle(): void {
		if (this.outstanding === undefined) {
			return;
		}

		this.rowsRead += this.outstanding.rowsRead;
		this.rowsWritten += this.outstanding.rowsWritten;
		this.outstanding = undefined;
	}
}

// The meter scoped to the in-flight request or invocation. The object handles
// requests concurrently (they interleave at await points on the single-threaded
// object), so a single shared per-request delta would fold in another request's
// rows. Each entrypoint runs its body within its own meter here, so the rows it
// attributes are only its own statements'.
//
// Work that runs outside any request boundary has no request meter to attribute
// to: the cold-start migration and seed run before the first request's meter
// opens, so the cumulative meter is the only place their rows are recorded, and
// the object logs that figure once as the cold-start cost.
const requestMeter = new AsyncLocalStorage<DatabaseCostMeter>();

// Runs `body` within a fresh request-scoped meter, settles it at the boundary,
// and reports the exact rows the body's statements read and wrote.
export async function withRequestCost<T>(
	body: () => Promise<T>,
	report: (cost: DatabaseCost) => void
): Promise<T> {
	const meter = new DatabaseCostMeter();

	return requestMeter.run(meter, async () => {
		try {
			return await body();
		} finally {
			meter.settle();
			report({ rowsRead: meter.rowsRead, rowsWritten: meter.rowsWritten });
		}
	});
}

// Wraps a SqlStorage so every statement it runs is tracked. The cumulative meter
// holds the object's lifetime totals (read by tests); the request-scoped meter,
// when one is active, additionally attributes the statement to the in-flight
// request for the per-request cost line. Only `exec` is instrumented; the rest of
// the surface delegates unchanged.
function meteredSql(
	sql: SqlStorage,
	cumulative: DatabaseCostMeter
): SqlStorage {
	return {
		exec<T extends Record<string, SqlStorageValue>>(
			query: string,
			...bindings: unknown[]
		): SqlStorageCursor<T> {
			const cursor = sql.exec<T>(query, ...bindings);
			cumulative.track(cursor);
			requestMeter.getStore()?.track(cursor);

			return cursor;
		},
		get databaseSize() {
			return sql.databaseSize;
		},
		Cursor: sql.Cursor,
		Statement: sql.Statement
	};
}

// Wraps a DurableObjectStorage so its `sql` handle is metered. The query layer
// (Drizzle) reads `sql` and `transactionSync` from this; every other member
// delegates to the real storage with its own receiver, so native methods keep
// their internal state.
export function meteredStorage(
	storage: DurableObjectStorage,
	meter: DatabaseCostMeter
): DurableObjectStorage {
	const sql = meteredSql(storage.sql, meter);
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
