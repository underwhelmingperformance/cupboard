import {
	StatementParameterLimitError,
	UnboundableIoError,
	UncountableStatementError
} from '../errors.ts';

import { maxBoundParameters } from './bulk.ts';
import {
	hasDataMigrationBudget,
	recordMigrationRows,
	reserveMigrationR2Operation,
	reserveMigrationStatement
} from './database-cost-meter.ts';
import { boundedSubrequest, unboundedCapMs } from './deadline.ts';
import { hasStatementAllowance, spendStatements } from './statement-scope.ts';

function bounded<A extends unknown[], R>(
	method: (...arguments_: A) => Promise<R>,
	subrequest: string,
	capMs?: number
): (...arguments_: A) => Promise<R> {
	return (...arguments_: A) =>
		boundedSubrequest(() => method(...arguments_), subrequest, capMs);
}

// Decrement the invocation's statement allowance before calling D1. If the call
// would exceed the allowance, throw before D1 receives the statement.
function charged<A extends unknown[], R>(
	method: (...arguments_: A) => Promise<R>,
	subrequest: string,
	parameterCount: number,
	resultKind: 'd1-result' | 'first-row' | 'raw-rows'
): (...arguments_: A) => Promise<R> {
	const run = bounded(method, subrequest);

	return async (...arguments_: A) => {
		spendStatements(1, subrequest);
		reserveMigrationStatement(parameterCount, subrequest);
		const result = await run(...arguments_);
		recordD1MigrationRows(result, resultKind);

		return result;
	};
}

function numericProperty(value: unknown, property: string): number {
	if (value === null || typeof value !== 'object') {
		return 0;
	}

	const propertyValue: unknown = Reflect.get(value, property);

	return typeof propertyValue === 'number' ? propertyValue : 0;
}

function resultRows(result: unknown): number {
	if (result === null || typeof result !== 'object') {
		return 0;
	}

	const rows: unknown = Reflect.get(result, 'results');

	return Array.isArray(rows) ? rows.length : 0;
}

function recordD1MigrationRows(
	result: unknown,
	resultKind: 'd1-result' | 'first-row' | 'raw-rows' = 'd1-result'
): void {
	if (resultKind === 'first-row') {
		recordMigrationRows({
			rowsReturned: result === null ? 0 : 1,
			reportedRowsRead: 0,
			rowsWritten: 0
		});
		return;
	}

	if (resultKind === 'raw-rows' && Array.isArray(result)) {
		recordMigrationRows({
			rowsReturned: result.length,
			reportedRowsRead: 0,
			rowsWritten: 0
		});
		return;
	}

	if (result === null || typeof result !== 'object') {
		return;
	}

	const meta: unknown = Reflect.get(result, 'meta');
	const rowsRead = numericProperty(meta, 'rows_read');

	recordMigrationRows({
		rowsReturned: resultRows(result),
		reportedRowsRead: rowsRead,
		rowsWritten: numericProperty(meta, 'rows_written')
	});
}

async function auditedAll(
	statement: D1PreparedStatement,
	subrequest: string,
	parameterCount: number
): Promise<D1Result<Record<string, unknown>>> {
	spendStatements(1, subrequest);
	reserveMigrationStatement(parameterCount, subrequest);
	const result = await bounded(statement.all.bind(statement), subrequest)();
	recordD1MigrationRows(result);

	return result;
}

function r2BodyLength(value: Parameters<R2Bucket['put']>[1]): number {
	if (typeof value === 'string') {
		return new TextEncoder().encode(value).byteLength;
	}

	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		return value.byteLength;
	}

	if (value instanceof Blob) {
		return value.size;
	}

	throw new UnboundableIoError('migration.r2.put-stream');
}

// A session or multipart handle issues requests outside these per-call proxies.
// Reject the member when the wrapper cannot apply a deadline to those requests.
function unboundable(member: string): () => never {
	return () => {
		throw new UnboundableIoError(member);
	};
}

// Bind pass-through methods to the host object because their implementations
// depend on the receiver.
function passThrough(target: object, property: PropertyKey): unknown {
	const value: unknown = Reflect.get(target, property, target);

	if (typeof value !== 'function') {
		return value;
	}

	const bound: unknown = value.bind(target);

	return bound;
}

/**
 * Wraps an {@link R2Bucket} with deadlines. `head`, `delete` and `list` use the
 * per-call limit. `get` and `put` transfer blob bytes, so they use the enclosing
 * critical-section deadline and can continue without the input gate.
 */
export function boundedBlobs(bucket: R2Bucket): R2Bucket {
	return new Proxy(bucket, {
		get(target, property) {
			switch (property) {
				case 'head': {
					const run = bounded(target.head.bind(target), 'r2.head');

					return (...arguments_: Parameters<R2Bucket['head']>) => {
						reserveMigrationR2Operation({});

						return run(...arguments_);
					};
				}
				case 'get': {
					const run = bounded(
						target.get.bind(target),
						'r2.get',
						unboundedCapMs
					);

					return async (...arguments_: Parameters<R2Bucket['get']>) => {
						const result = await run(...arguments_);
						reserveMigrationR2Operation({ bytesRead: result?.size ?? 0 });

						return result;
					};
				}
				case 'put': {
					const run = bounded(
						target.put.bind(target),
						'r2.put',
						unboundedCapMs
					);

					return (...arguments_: Parameters<R2Bucket['put']>) => {
						if (hasDataMigrationBudget()) {
							reserveMigrationR2Operation({
								bytesWritten: r2BodyLength(arguments_[1])
							});
						}

						return run(...arguments_);
					};
				}
				case 'delete': {
					const run = bounded(target.delete.bind(target), 'r2.delete');

					return (...arguments_: Parameters<R2Bucket['delete']>) => {
						reserveMigrationR2Operation({});

						return run(...arguments_);
					};
				}
				case 'list': {
					const run = bounded(target.list.bind(target), 'r2.list');

					return (...arguments_: Parameters<R2Bucket['list']>) => {
						reserveMigrationR2Operation({});

						return run(...arguments_);
					};
				}
				case 'createMultipartUpload':
				case 'resumeMultipartUpload': {
					return unboundable(`r2.${property}`);
				}
				default: {
					return passThrough(target, property);
				}
			}
		}
	});
}

// Associate each bounded proxy with its native statement. `batch` unwraps its
// arguments before passing them to D1.
const realStatement = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
const statementParameterCounts = new WeakMap<D1PreparedStatement, number>();

function boundedStatement(
	statement: D1PreparedStatement,
	parameterCount = 0
): D1PreparedStatement {
	const proxy = new Proxy(statement, {
		get(target, property) {
			switch (property) {
				case 'bind': {
					return (...values: unknown[]): D1PreparedStatement => {
						if (values.length > maxBoundParameters) {
							throw new StatementParameterLimitError(
								values.length,
								maxBoundParameters
							);
						}

						return boundedStatement(target.bind(...values), values.length);
					};
				}
				case 'run': {
					return charged(
						target.run.bind(target),
						'd1.run',
						parameterCount,
						'd1-result'
					);
				}
				case 'all': {
					return charged(
						target.all.bind(target),
						'd1.all',
						parameterCount,
						'd1-result'
					);
				}
				case 'first': {
					if (hasDataMigrationBudget()) {
						return unboundable('d1.first');
					}

					return charged(
						target.first.bind(target),
						'd1.first',
						parameterCount,
						'first-row'
					);
				}
				case 'raw': {
					if (hasDataMigrationBudget()) {
						return async (options?: { readonly columnNames?: boolean }) => {
							if (options?.columnNames === true) {
								throw new UnboundableIoError('d1.raw.column-names');
							}

							const result = await auditedAll(target, 'd1.raw', parameterCount);

							return result.results.map((row) => Object.values(row));
						};
					}

					return charged(
						target.raw.bind(target),
						'd1.raw',
						parameterCount,
						'raw-rows'
					);
				}
				default: {
					return passThrough(target, property);
				}
			}
		}
	});

	realStatement.set(proxy, statement);
	statementParameterCounts.set(proxy, parameterCount);

	return proxy;
}

/**
 * Wraps a {@link D1Database} with deadlines and statement accounting. `prepare`
 * does not change the invocation's allowance. Each terminal `run`, `all`,
 * `first` or `raw` call decrements the allowance by one. `batch` decrements it
 * by the number of members and sends the corresponding native statements to
 * D1. A D1 batch is atomic, so this wrapper never decomposes one.
 *
 * `exec` can execute an unknown number of statements from one string. An active
 * statement allowance therefore rejects the call before dispatch.
 */
export function boundedD1(database: D1Database): D1Database {
	return new Proxy(database, {
		get(target, property) {
			switch (property) {
				case 'prepare': {
					return (query: string): D1PreparedStatement =>
						boundedStatement(target.prepare(query));
				}
				case 'batch': {
					return async (statements: D1PreparedStatement[]) => {
						spendStatements(statements.length, 'd1.batch');

						for (const statement of statements) {
							reserveMigrationStatement(
								statementParameterCounts.get(statement) ?? 0,
								'd1.batch'
							);
						}

						const results = await boundedSubrequest(
							() =>
								target.batch(
									statements.map(
										(statement) => realStatement.get(statement) ?? statement
									)
								),
							'd1.batch'
						);

						for (const result of results) {
							recordD1MigrationRows(result);
						}

						return results;
					};
				}
				case 'exec': {
					return (query: string): Promise<D1ExecResult> => {
						if (hasStatementAllowance()) {
							throw new UncountableStatementError('d1.exec');
						}

						return bounded(target.exec.bind(target), 'd1.exec')(query);
					};
				}
				case 'withSession':
				case 'dump': {
					return unboundable(`d1.${property}`);
				}
				default: {
					return passThrough(target, property);
				}
			}
		}
	});
}
