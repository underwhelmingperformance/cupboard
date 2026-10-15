import { vi } from 'vitest';

export interface D1StatementLog {
	/**
	 * Returns the SQL of a statement, or `undefined` for a statement prepared
	 * before the log started recording.
	 */
	sql(statement: D1PreparedStatement): string | undefined;
	restore(): void;
}

/**
 * Records the SQL of every statement prepared on `database` until `restore`
 * is called. A batch receives the statements that `bind` returns, so the log
 * records each bound statement as well as the prepared one.
 */
export function recordD1Statements(database: D1Database): D1StatementLog {
	const prepare = database.prepare.bind(database);
	const queries = new WeakMap<D1PreparedStatement, string>();
	const prepareSpy = vi
		.spyOn(database, 'prepare')
		.mockImplementation((query) => {
			const statement = prepare(query);
			const bind = statement.bind.bind(statement);
			statement.bind = (...values: unknown[]) => {
				const bound = bind(...values);
				queries.set(bound, query);

				return bound;
			};
			queries.set(statement, query);

			return statement;
		});

	return {
		sql: (statement) => queries.get(statement),
		restore: () => {
			prepareSpy.mockRestore();
		}
	};
}
