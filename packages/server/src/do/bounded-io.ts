import { UnboundableIoError } from '../errors.ts';

import { boundedSubrequest, unboundedCapMs } from './deadline.ts';

// Wraps one async client method so every call is bounded (see
// {@link boundedSubrequest}). The method is pre-bound to its receiver by the
// caller. Byte-transfer methods pass `unboundedCapMs` so only an enclosing
// critical-section deadline bounds them.
function bounded<A extends unknown[], R>(
	method: (...arguments_: A) => Promise<R>,
	subrequest: string,
	capMs?: number
): (...arguments_: A) => Promise<R> {
	return (...arguments_: A) =>
		boundedSubrequest(() => method(...arguments_), subrequest, capMs);
}

// Refuses a member whose network calls the bound cannot reach: a session or
// multipart handle issues its own requests outside these proxies, so reaching
// for one through a bounded wrapper would be a silent bypass.
function unboundable(member: string): () => never {
	return () => {
		throw new UnboundableIoError(member);
	};
}

// Passes through a non-intercepted member, binding methods to the real target so
// their internal state survives, exactly as {@link meteredStorage} does.
function passThrough(target: object, property: PropertyKey): unknown {
	const value: unknown = Reflect.get(target, property, target);

	if (typeof value !== 'function') {
		return value;
	}

	const bound: unknown = value.bind(target);

	return bound;
}

/**
 * An {@link R2Bucket} whose network calls are bounded. `head`/`delete`/`list`
 * are metadata calls capped at the per-call limit; `get`/`put` carry blob bytes,
 * so they are bounded only by an enclosing critical-section deadline and run
 * unbounded off the gate.
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

/** A {@link Cache} whose match/put/delete calls are bounded. */
export function boundedCache(cache: Cache): Cache {
	return new Proxy(cache, {
		get(target, property) {
			switch (property) {
				case 'match': {
					return bounded(target.match.bind(target), 'cache.match');
				}
				case 'put': {
					return bounded(target.put.bind(target), 'cache.put');
				}
				case 'delete': {
					return bounded(target.delete.bind(target), 'cache.delete');
				}
				default: {
					return passThrough(target, property);
				}
			}
		}
	});
}

// The real statement behind each bounded proxy, so `batch` hands D1 the native
// statements the driver built rather than the proxies.
const realStatement = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

function boundedStatement(statement: D1PreparedStatement): D1PreparedStatement {
	const proxy = new Proxy(statement, {
		get(target, property) {
			switch (property) {
				case 'bind': {
					return (...values: unknown[]): D1PreparedStatement =>
						boundedStatement(target.bind(...values));
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
 * A {@link D1Database} whose network calls are bounded. `prepare` returns a
 * bounded statement whose terminal `run`/`all`/`first`/`raw` are capped;
 * `batch` is bounded as one call (D1 batches are atomic, so it must never be
 * decomposed) and receives the native statements via {@link realStatement}.
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
					return (statements: D1PreparedStatement[]) =>
						boundedSubrequest(
							() =>
								target.batch(
									statements.map(
										(statement) => realStatement.get(statement) ?? statement
									)
								),
							'd1.batch'
						);
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
