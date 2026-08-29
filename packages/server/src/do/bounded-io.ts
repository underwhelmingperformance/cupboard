import {
	StatementParameterLimitError,
	UnboundableIoError,
	UncountableStatementError
} from '../errors.ts';

import { maxBoundParameters } from './bulk.ts';
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
	subrequest: string
): (...arguments_: A) => Promise<R> {
	const run = bounded(method, subrequest);

	return (...arguments_: A) => {
		spendStatements(1, subrequest);

		return run(...arguments_);
	};
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
					return bounded(target.head.bind(target), 'r2.head');
				}
				case 'get': {
					return bounded(target.get.bind(target), 'r2.get', unboundedCapMs);
				}
				case 'put': {
					return bounded(target.put.bind(target), 'r2.put', unboundedCapMs);
				}
				case 'delete': {
					return bounded(target.delete.bind(target), 'r2.delete');
				}
				case 'list': {
					return bounded(target.list.bind(target), 'r2.list');
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

function boundedStatement(statement: D1PreparedStatement): D1PreparedStatement {
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

						return boundedStatement(target.bind(...values));
					};
				}
				case 'run': {
					return charged(target.run.bind(target), 'd1.run');
				}
				case 'all': {
					return charged(target.all.bind(target), 'd1.all');
				}
				case 'first': {
					return charged(target.first.bind(target), 'd1.first');
				}
				case 'raw': {
					return charged(target.raw.bind(target), 'd1.raw');
				}
				default: {
					return passThrough(target, property);
				}
			}
		}
	});

	realStatement.set(proxy, statement);

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
					return (statements: D1PreparedStatement[]) => {
						spendStatements(statements.length, 'd1.batch');

						return boundedSubrequest(
							() =>
								target.batch(
									statements.map(
										(statement) => realStatement.get(statement) ?? statement
									)
								),
							'd1.batch'
						);
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
