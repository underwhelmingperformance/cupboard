import { vi } from 'vitest';

import { currentOperationCost } from './do/operation-cost.ts';

export interface D1StatementLog {
	/**
	 * Returns the SQL of a statement, or `undefined` for a statement prepared
	 * before the log started recording.
	 */
	sql(statement: D1PreparedStatement): string | undefined;
	/**
	 * Returns the values bound to a statement, or `[]` for an unbound one.
	 */
	values(statement: D1PreparedStatement): readonly unknown[];
	restore(): void;
}

/**
 * Labels a statement by its verb and table, such as `update tenant_usage`. A
 * statement that does not write a table is labelled by its first word.
 */
export function describeStatement(query: string): string {
	const [, verb, table] =
		/^(insert into|update|delete from) "(\w+)"/.exec(query) ?? [];

	if (verb === undefined || table === undefined) {
		return /^\S+/.exec(query)?.[0] ?? query;
	}

	return `${verb} ${table}`;
}

/**
 * Records the SQL of every statement prepared on `database` until `restore`
 * is called. A batch receives the statements that `bind` returns, so the log
 * records each bound statement and its values as well as the prepared one.
 */
export function recordD1Statements(database: D1Database): D1StatementLog {
	const prepare = database.prepare.bind(database);
	const queries = new WeakMap<D1PreparedStatement, string>();
	const bindings = new WeakMap<D1PreparedStatement, readonly unknown[]>();
	const prepareSpy = vi
		.spyOn(database, 'prepare')
		.mockImplementation((query) => {
			const statement = prepare(query);
			const bind = statement.bind.bind(statement);
			statement.bind = (...values: unknown[]) => {
				const bound = bind(...values);
				queries.set(bound, query);
				bindings.set(bound, values);

				return bound;
			};
			queries.set(statement, query);

			return statement;
		});

	return {
		sql: (statement) => queries.get(statement),
		values: (statement) => bindings.get(statement) ?? [],
		restore: () => {
			prepareSpy.mockRestore();
		}
	};
}

/**
 * One statement of a D1 batch, as `batchCosts` passes it to `beforeBatch`.
 */
export interface BatchStatement {
	readonly label: string;
	readonly sql: string;
	readonly values: readonly unknown[];
}

/**
 * The rows that one statement of a batch wrote, and with `reads` the rows that
 * it read. D1 bills each table row and each index entry that a statement
 * writes, and reports the total as `meta.rows_written`.
 */
export interface StatementCost {
	readonly statement: string;
	readonly written: number;
	readonly read?: number;
}

/**
 * Runs `body` and returns the cost of each statement in every D1 batch that
 * it sends to `database`. `beforeBatch` runs before each batch reaches D1.
 */
export async function batchCosts(
	database: D1Database,
	body: () => Promise<unknown>,
	options: {
		readonly beforeBatch?: (
			statements: readonly BatchStatement[]
		) => Promise<void>;
		readonly reads?: boolean;
	} = {}
): Promise<StatementCost[][]> {
	const batch = database.batch.bind(database);
	const batches: StatementCost[][] = [];
	const log = recordD1Statements(database);
	const batchSpy = vi
		.spyOn(database, 'batch')
		.mockImplementation(async <T>(statements: D1PreparedStatement[]) => {
			const recorded = statements.map((statement) => {
				const sql = log.sql(statement) ?? '';

				return {
					label: describeStatement(sql),
					sql,
					values: log.values(statement)
				};
			});
			await options.beforeBatch?.(recorded);
			const results = await batch<T>(statements);
			batches.push(
				results.map((result, index) => {
					const cost = {
						statement: recorded[index]?.label ?? '',
						written: result.meta.rows_written
					};

					return options.reads === true
						? { ...cost, read: result.meta.rows_read }
						: cost;
				})
			);

			return results;
		});

	try {
		await body();
	} finally {
		log.restore();
		batchSpy.mockRestore();
	}

	return batches;
}

export interface TableWrite {
	/**
	 * The label of the cost scope that ran the statement.
	 */
	readonly scope: string | undefined;
	readonly statement: string;
	readonly written: number;
}

/**
 * Runs `body` and returns, in order, every statement on `table` that ran
 * through `run`, with the number of rows that D1 reports it wrote.
 *
 * The test pool freezes `Date`, so every statement would otherwise see the
 * same instant. In production the clock moves on across each D1 call, so
 * here it advances by one millisecond for every statement prepared on
 * `database`.
 */
export async function recordTableWrites(
	database: D1Database,
	table: string,
	body: () => Promise<unknown>
): Promise<TableWrite[]> {
	const prepare = database.prepare.bind(database);
	const writes: TableWrite[] = [];
	const recordRun = (
		statement: D1PreparedStatement,
		query: string
	): D1PreparedStatement => {
		const run = statement.run.bind(statement);
		const bind = statement.bind.bind(statement);
		statement.run = async <T>() => {
			const result = await run<T>();

			if (query.includes(`"${table}"`)) {
				writes.push({
					scope: currentOperationCost()?.label,
					statement: describeStatement(query),
					written: result.meta.rows_written
				});
			}

			return result;
		};
		statement.bind = (...values: unknown[]) =>
			recordRun(bind(...values), query);

		return statement;
	};
	const prepareSpy = vi
		.spyOn(database, 'prepare')
		.mockImplementation((query) => {
			vi.setSystemTime(Date.now() + 1);

			return recordRun(prepare(query), query);
		});

	try {
		await body();
	} finally {
		prepareSpy.mockRestore();
	}

	return writes;
}
