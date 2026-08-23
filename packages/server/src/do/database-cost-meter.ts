import { AsyncLocalStorage } from 'node:async_hooks';

type AnyCursor = SqlStorageCursor<Record<string, SqlStorageValue>>;

export interface DatabaseCost {
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

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
// statement, which is when both the lifetime and request meters record it.
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

// Bind pass-through methods to the platform storage. These host methods depend
// on their receiver and fail when invoked through an ordinary proxy receiver.
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
