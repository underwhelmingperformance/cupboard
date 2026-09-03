import { AsyncLocalStorage } from 'node:async_hooks';

import type { DataMigrationBudget } from '@cupboard/protocol/deployment-manifest';

interface MigrationUsage {
	statements: number;
	rowsReturned: number;
	reportedD1RowsRead: number;
	rowsWritten: number;
	r2Operations: number;
	r2BytesRead: number;
	r2BytesWritten: number;
}

interface MigrationBudgetScope {
	readonly budget: DataMigrationBudget;
	readonly usage: MigrationUsage;
}

export class DataMigrationBudgetExceededError extends Error {
	constructor(resource: keyof MigrationUsage, used: number, maximum: number) {
		super(
			`The data migration used ${used.toString()} ${resource}, above its declared maximum of ${maximum.toString()}`
		);
		this.name = 'DataMigrationBudgetExceededError';
	}
}

const migrationBudgetScope = new AsyncLocalStorage<MigrationBudgetScope>();

function currentMigrationBudget(): MigrationBudgetScope | undefined {
	return migrationBudgetScope.getStore();
}

export function hasDataMigrationBudget(): boolean {
	return currentMigrationBudget() !== undefined;
}

function addMigrationUsage(
	resource: keyof MigrationUsage,
	amount: number,
	maximum: number
): void {
	const scope = currentMigrationBudget();

	if (scope === undefined || amount === 0) {
		return;
	}

	const used = scope.usage[resource] + amount;

	if (used > maximum) {
		throw new DataMigrationBudgetExceededError(resource, used, maximum);
	}

	scope.usage[resource] = used;
}

export function withDataMigrationBudget<T>(
	budget: DataMigrationBudget,
	body: () => Promise<T>
): Promise<T> {
	if (currentMigrationBudget() !== undefined) {
		return body();
	}

	return migrationBudgetScope.run(
		{
			budget,
			usage: {
				statements: 0,
				rowsReturned: 0,
				reportedD1RowsRead: 0,
				rowsWritten: 0,
				r2Operations: 0,
				r2BytesRead: 0,
				r2BytesWritten: 0
			}
		},
		body
	);
}

export function reserveMigrationStatement(
	parameterCount: number,
	subject: string
): void {
	const scope = currentMigrationBudget();

	if (scope === undefined) {
		return;
	}

	if (parameterCount > scope.budget.maximumParametersPerStatement) {
		throw new DataMigrationBudgetExceededError(
			'statements',
			parameterCount,
			scope.budget.maximumParametersPerStatement
		);
	}

	addMigrationUsage('statements', 1, scope.budget.maximumStatements);

	if (subject.length === 0) {
		throw new TypeError('A migration statement must have a subject');
	}
}

export function recordMigrationRows(input: {
	readonly rowsReturned: number;
	readonly reportedRowsRead: number;
	readonly rowsWritten: number;
}): void {
	const scope = currentMigrationBudget();

	if (scope === undefined) {
		return;
	}

	addMigrationUsage(
		'rowsReturned',
		input.rowsReturned,
		scope.budget.maximumRowsReturned
	);
	addMigrationUsage(
		'reportedD1RowsRead',
		input.reportedRowsRead,
		scope.budget.maximumReportedD1RowsRead
	);
	addMigrationUsage(
		'rowsWritten',
		input.rowsWritten,
		scope.budget.maximumRowsWritten
	);
}

export function reserveMigrationR2Operation(input: {
	readonly bytesRead?: number;
	readonly bytesWritten?: number;
}): void {
	const scope = currentMigrationBudget();

	if (scope === undefined) {
		return;
	}

	addMigrationUsage('r2Operations', 1, scope.budget.maximumR2Operations);
	addMigrationUsage(
		'r2BytesRead',
		input.bytesRead ?? 0,
		scope.budget.maximumR2BytesRead
	);
	addMigrationUsage(
		'r2BytesWritten',
		input.bytesWritten ?? 0,
		scope.budget.maximumR2BytesWritten
	);
}

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
			reserveMigrationStatement(bindings.length, 'durable-object.sql');
			const cursor = sql.exec<T>(query, ...bindings);
			recordMigrationRows({
				rowsReturned: cursor.rowsRead,
				reportedRowsRead: cursor.rowsRead,
				rowsWritten: cursor.rowsWritten
			});
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
