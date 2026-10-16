import { UnboundableIoError } from '../errors.ts';

import { boundedSubrequest, unboundedCapMs } from './deadline.ts';
import {
	currentOperationCost,
	type OperationCost,
	type R2Operation
} from './operation-cost.ts';
import { admitBoundParameters } from './statement-admission.ts';
import { spendSubrequests } from './subrequest-slice.ts';

interface CallCost<R> {
	readonly start: (cost: OperationCost) => void;
	readonly finish?: (cost: OperationCost, result: R) => void;
}

function r2Call(operation: R2Operation): CallCost<unknown> {
	return {
		start: (cost) => {
			cost.recordR2Call(operation);
		}
	};
}

const d1CallWithRows: CallCost<D1Response> = {
	start: (cost) => {
		cost.recordD1Call(true);
	},
	finish: (cost, result) => {
		cost.recordD1Rows([result]);
	}
};

const d1Batch: CallCost<readonly D1Response[]> = {
	start: (cost) => {
		cost.recordD1Call(true);
	},
	finish: (cost, results) => {
		cost.recordD1Rows(results);
	}
};

const d1CallWithoutRows: CallCost<unknown> = {
	start: (cost) => {
		cost.recordD1Call(false);
	}
};

// Declare the call against the dispatch's subrequest slice before making it.
// The slice refuses nothing; a pass asks `hasSubrequestsFor` before a unit of
// work and defers when the answer is no.
//
// The cost goes to the scope that made the call, even when the result arrives
// after another scope has opened. A call that the deadline refuses is never
// sent, so it is not counted. A call that outlives its deadline still
// completes and is billed, so its result is read from the binding's own
// promise.
function bounded<A extends unknown[], R>(
	method: (...arguments_: A) => Promise<R>,
	subrequest: string,
	callCost: CallCost<R>,
	capMs?: number
): (...arguments_: A) => Promise<R> {
	return (...arguments_: A) => {
		spendSubrequests(1, subrequest);
		const cost = currentOperationCost();

		return boundedSubrequest(
			() => {
				const call = method(...arguments_);

				if (cost === undefined) {
					return call;
				}

				callCost.start(cost);
				const { finish } = callCost;

				if (finish !== undefined) {
					void recordWhenFulfilled(call, (result) => {
						finish(cost, result);
					});
				}

				return call;
			},
			subrequest,
			capMs
		);
	};
}

// The caller receives a rejection from the call itself.
async function recordWhenFulfilled<R>(
	call: Promise<R>,
	record: (result: R) => void
): Promise<void> {
	let result: R;

	try {
		result = await call;
	} catch {
		return;
	}

	record(result);
}

// A multipart handle issues requests outside these per-call proxies.
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
	T extends {
		readonly BLOBS: R2Bucket;
		readonly CUPBOARD_DB: D1Database;
		readonly CONTROL_DB?: D1Database;
	}
>(env: T): T {
	// A proxy, not a spread: tests supply a service binding through a `get`
	// trap, which a spread would not copy.
	return new Proxy(env, {
		get(target, property) {
			switch (property) {
				case 'BLOBS': {
					return boundedBlobs(target.BLOBS);
				}
				case 'CONTROL_DB': {
					return target.CONTROL_DB === undefined
						? undefined
						: boundedD1(target.CONTROL_DB);
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
					return bounded(target.head.bind(target), 'r2.head', r2Call('head'));
				}
				case 'get': {
					return bounded(
						target.get.bind(target),
						'r2.get',
						r2Call('get'),
						unboundedCapMs
					);
				}
				case 'put': {
					return bounded(
						target.put.bind(target),
						'r2.put',
						r2Call('put'),
						unboundedCapMs
					);
				}
				case 'delete': {
					return bounded(
						target.delete.bind(target),
						'r2.delete',
						r2Call('delete')
					);
				}
				case 'list': {
					return bounded(target.list.bind(target), 'r2.list', r2Call('list'));
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
					return bounded(target.run.bind(target), 'd1.run', d1CallWithRows);
				}
				case 'all': {
					return bounded(target.all.bind(target), 'd1.all', d1CallWithRows);
				}
				case 'first': {
					return bounded(
						target.first.bind(target),
						'd1.first',
						d1CallWithoutRows
					);
				}
				case 'raw': {
					return bounded(target.raw.bind(target), 'd1.raw', d1CallWithoutRows);
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

function boundedD1Client<T extends D1Database | D1DatabaseSession>(
	database: T
): T {
	return new Proxy(database, {
		get(target, property) {
			switch (property) {
				case 'prepare': {
					return (query: string): D1PreparedStatement =>
						boundedStatement(target.prepare(query));
				}
				case 'batch': {
					return bounded(
						(statements: D1PreparedStatement[]) =>
							target.batch(
								statements.map(
									(statement) => realStatement.get(statement) ?? statement
								)
							),
						'd1.batch',
						d1Batch
					);
				}
				default: {
					return passThrough(target, property);
				}
			}
		}
	});
}

/**
 * Wraps a {@link D1Database} and its sessions with deadlines and subrequest
 * accounting. Each terminal statement method, batch, or exec call consumes
 * one subrequest. A batch remains atomic and consumes one call regardless
 * of its member count.
 */
export function boundedD1(database: D1Database): D1Database {
	const client = boundedD1Client(database);

	return new Proxy(client, {
		get(target, property) {
			if (property === 'exec') {
				return bounded(
					database.exec.bind(database),
					'd1.exec',
					d1CallWithoutRows
				);
			}

			if (property === 'withSession') {
				return (constraint?: D1SessionBookmark): D1DatabaseSession =>
					boundedD1Client(database.withSession(constraint));
			}

			if (property === 'dump') {
				return unboundable('d1.dump');
			}

			return passThrough(target, property);
		}
	});
}
