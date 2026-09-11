import { UnboundableIoError, UncountableStatementError } from '../errors.ts';

import { boundedSubrequest, perCallCapMs, unboundedCapMs } from './deadline.ts';
import { admitBoundParameters } from './statement-admission.ts';
import { hasStatementAllowance, spendStatements } from './statement-scope.ts';
import { spendSubrequests } from './subrequest-slice.ts';

// Declare the call against the pass's subrequest slice before making it. The
// slice refuses nothing; a pass asks `hasSubrequestsFor` before a granule and
// defers when the answer is no. Durable Object storage is deliberately absent:
// the runtime counts no storage operation, so the row budget measures that work
// instead and the two do not overlap.
function bounded<A extends unknown[], R>(
	method: (...arguments_: A) => Promise<R>,
	subrequest: string,
	capMs?: number
): (...arguments_: A) => Promise<R> {
	return (...arguments_: A) => {
		spendSubrequests(1);

		return boundedSubrequest(() => method(...arguments_), subrequest, capMs);
	};
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
 * The deadline one Worker R2 metadata call gets.
 *
 * Worker code reached R2 through the binding the runtime supplies, so a head
 * that never returned never returned: no deadline, no allowance, nothing. This
 * is a per-call deadline where there was none.
 *
 * No measurement supports the figure. It is chosen clear of anything this path
 * is observed to take, and it matches what a Durable Object already applies to
 * the same kind of call so that the two sides of the service binding behave
 * alike; that is consistency, not derivation. The R2 head latency that would
 * justify it is the same measurement that would justify
 * `cacheAvailabilityMaxPaths`, and neither can be taken here, because the local
 * pool enforces no connection limit and no subrequest ceiling.
 *
 * What it buys is throughput rather than safety. A request has six simultaneous
 * outgoing connections, and the availability probe runs its heads six at a time,
 * so one head that hangs holds a slot and stalls every path queued behind it. A
 * per-call deadline keeps the rest moving. The invocation itself needs no
 * collective budget here: there is no input gate to hold and no Durable Object
 * to reset, which is what the critical-section budget exists for.
 *
 * Where this and the reader part company: Nix abandons a narinfo fetch only
 * after libcurl measures under a byte per second for five minutes, so a head
 * that is slow but progressing would never trouble Nix while this deadline cuts
 * it. The window is narrow, because a few-hundred-byte metadata head still
 * moving after fifteen seconds is stuck rather than slow, but a request that
 * would have succeeded can now fail.
 *
 * A head that rejects fails the probe. It is not read as the path being absent:
 * `missingStorePathHashes` reports a path missing only when the object is null
 * or belongs to another commit, `mapWithConcurrency` rethrows the first failure,
 * and the route does not catch. Catching a timeout there to make the probe
 * resilient would report every timed-out path as missing and have the client
 * upload bytes it already holds, which is the defect the reuse-view candidate
 * limit used to cause.
 */
export const workerMetadataCapMs = perCallCapMs;

/**
 * Wraps the bindings a Worker invocation uses. R2 metadata calls gain the
 * deadline above; byte transfers stay unbounded, because a NAR body legitimately
 * takes as long as it takes.
 *
 * D1 is left alone. The statement allowance and the row budget belong to a
 * Durable Object dispatch, and a Worker holds neither.
 */
export function boundedWorkerEnv<T extends { readonly BLOBS: R2Bucket }>(
	env: T
): T {
	// Wrap through a proxy rather than a copy. A spread would rebuild the
	// environment, and a service binding is identified by the object the runtime
	// supplied: a copy of it dispatches nowhere.
	return new Proxy(env, {
		get(target, property) {
			return property === 'BLOBS'
				? boundedBlobs(target.BLOBS)
				: passThrough(target, property);
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
