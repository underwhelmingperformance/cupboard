import { UnboundableIoError } from '../errors.ts';

import { boundedSubrequest, unboundedCapMs } from './deadline.ts';
import { admitBoundParameters } from './statement-admission.ts';
import { spendSubrequests } from './subrequest-slice.ts';

// Declare the call against the dispatch's subrequest slice before making it.
// The slice refuses nothing; a pass asks `hasSubrequestsFor` before a unit of
// work and defers when the answer is no.
function bounded<A extends unknown[], R>(
	method: (...arguments_: A) => Promise<R>,
	subrequest: string,
	capMs?: number
): (...arguments_: A) => Promise<R> {
	return (...arguments_: A) => {
		spendSubrequests(1, subrequest);

		return boundedSubrequest(() => method(...arguments_), subrequest, capMs);
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
 * Wraps a Worker's D1 and R2 bindings with the deadlines and subrequest
 * accounting used by Durable Objects. R2 `get` and `put` can transfer NAR
 * bytes, so they have no per-call deadline; an enclosing deadline still
 * applies. Other bindings receive no deadline or accounting wrapper.
 */
export function boundedWorkerEnv<
	T extends { readonly BLOBS: R2Bucket; readonly CUPBOARD_DB: D1Database }
>(env: T): T {
	// A proxy, not a spread: tests supply a service binding through a `get`
	// trap, which a spread would not copy.
	return new Proxy(env, {
		get(target, property) {
			switch (property) {
				case 'BLOBS': {
					return boundedBlobs(target.BLOBS);
				}
				case 'CUPBOARD_DB': {
					return boundedD1(target.CUPBOARD_DB);
				}
				default: {
					return passThrough(target, property);
				}
			}
		}
	});
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
						admitBoundParameters(values.length);

						return boundedStatement(target.bind(...values));
					};
				}
				case 'run': {
					return bounded(target.run.bind(target), 'd1.run');
				}
				case 'all': {
					return bounded(target.all.bind(target), 'd1.all');
				}
				case 'first': {
					return bounded(target.first.bind(target), 'd1.first');
				}
				case 'raw': {
					return bounded(target.raw.bind(target), 'd1.raw');
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
 * Wraps a {@link D1Database} with deadlines and subrequest accounting. Each
 * terminal statement method, batch, or exec call consumes one subrequest. A D1
 * batch remains atomic and consumes one call regardless of its member count.
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
						spendSubrequests(1, 'd1.batch');

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
					return bounded(target.exec.bind(target), 'd1.exec');
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
