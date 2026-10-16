import { admitBoundParameters } from './statement-admission.ts';

type AnyCursor = SqlStorageCursor<Record<string, SqlStorageValue>>;

/**
 * Adds up the rows that Durable Object SQLite reads and writes, which is how
 * Cloudflare bills it.
 *
 * A cursor's totals cover one statement. `sql.exec` accepts a query string
 * holding several statements and returns the cursor of the last one, so the
 * totals for such a string omit every statement before the last. The binding
 * cannot refuse such a string: a semicolon can sit inside one statement, as it
 * does in a `CREATE TRIGGER` body, and `SqlStorage` has no way to report how
 * many statements a string holds. The row budget is debited from these
 * totals, so a multi-statement string is charged only for its last statement.
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

interface CursorTracker {
	track(cursor: AnyCursor): unknown;
}

/**
 * Returns the tracker for the scope that is open when a statement runs, or
 * undefined when no such scope is open.
 */
type ScopedMeter = () => CursorTracker | undefined;

// Keep the platform cursor unchanged. Drizzle consumes it before the next
// statement, which is when the lifetime and scoped meters record it.
function meteredSql(
	sql: SqlStorage,
	cumulative: DatabaseCostMeter,
	scoped: readonly ScopedMeter[]
): SqlStorage {
	return {
		exec<T extends Record<string, SqlStorageValue>>(
			query: string,
			...bindings: unknown[]
		): SqlStorageCursor<T> {
			// Only the parameter rule is shared with the D1 binding. Durable Object
			// SQLite operations do not consume internal-service subrequests.
			admitBoundParameters(bindings.length);

			const cursor = sql.exec<T>(query, ...bindings);
			cumulative.track(cursor);

			for (const meter of scoped) {
				meter()?.track(cursor);
			}

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
// Each `scoped` accessor is called per statement because its meter belongs to
// the scope that is open when the statement runs, not to the storage wrapper.
export function meteredStorage(
	storage: DurableObjectStorage,
	meter: DatabaseCostMeter,
	scoped: readonly ScopedMeter[] = []
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
