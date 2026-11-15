import { getLogger } from '@cupboard/logger';

import {
	ForwardedReadTimeoutError,
	SubrequestTimeoutError,
	TenantObjectTimeoutError,
	TenantWorkerReadUnspecifiedError
} from '../errors.ts';
import { tenantOperationBudgetMs } from '../policy/streaming.ts';

import {
	currentForwardDeadline,
	currentTenantWorkerRead,
	type Delay
} from './deadline.ts';
import { passThrough } from './pass-through.ts';

const logger = getLogger(['cupboard', 'tenant-object']);
const tenantWorkerLogger = getLogger(['cupboard', 'tenant-worker']);
const expiry = Symbol('expiry');

/**
Wraps a tenant object namespace so that every `fetch` on its stubs has a
deadline for the response headers, which `delay` waits out. Inside
`withinReadDeadline` the deadline is what remains of the read's deadline,
and a fetch that misses it fails with the retryable 503 of a timed-out read.
Inside `withoutForwardDeadline` a fetch has no deadline. Every other fetch
has {@link tenantOperationBudgetMs} and fails with a 504 when it misses it.

The deadline ends when the headers arrive, so it does not cover a streamed
body or an upgraded WebSocket. RPC calls pass through unchanged.
*/
export function boundedTenantObjects<
	T extends Rpc.DurableObjectBranded | undefined
>(
	namespace: DurableObjectNamespace<T>,
	delay: Delay
): DurableObjectNamespace<T> {
	return new Proxy(namespace, {
		get(target, property) {
			switch (property) {
				case 'get': {
					return (
						id: DurableObjectId,
						options?: DurableObjectNamespaceGetDurableObjectOptions
					) => boundedStub(target.get(id, options), delay);
				}
				case 'getByName': {
					return (
						name: string,
						options?: DurableObjectNamespaceGetDurableObjectOptions
					) => boundedStub(target.getByName(name, options), delay);
				}
				default: {
					return passThrough(target, property);
				}
			}
		}
	});
}

function boundedStub<T extends Rpc.DurableObjectBranded | undefined>(
	stub: DurableObjectStub<T>,
	delay: Delay
): DurableObjectStub<T> {
	return new Proxy(stub, {
		get(target, property) {
			// An RPC method of a stub is itself a stub, so `bind` on it would be sent
			// to the object as a call of a method named `bind`. Return it unbound.
			if (property !== 'fetch') {
				const value: unknown = Reflect.get(target, property, target);

				return value;
			}

			return (input: RequestInfo | URL, init?: RequestInit) =>
				fetchWithinDeadline(
					(signal) =>
						target.fetch(
							input,
							signal === undefined
								? init
								: { ...init, signal: withCallerSignal(signal, input, init) }
						),
					delay
				);
		}
	});
}

/**
Combines the deadline's `signal` with the caller's signal, from `init` or
from an input `Request`, so that either one cancels the subrequest.
*/
function withCallerSignal(
	signal: AbortSignal,
	input: RequestInfo | URL,
	init: RequestInit | undefined
): AbortSignal {
	const caller =
		init?.signal ?? (input instanceof Request ? input.signal : undefined);

	return caller === undefined ? signal : AbortSignal.any([caller, signal]);
}

async function fetchWithinDeadline(
	send: (signal?: AbortSignal) => Promise<Response>,
	delay: Delay
): Promise<Response> {
	const forward = currentForwardDeadline();

	if (forward?.kind === 'unbounded') {
		return send();
	}

	const read = forward?.deadline;
	const deadlineMs = read?.remainingMs() ?? tenantOperationBudgetMs;
	const fields = {
		kind: read === undefined ? 'operation' : 'read',
		deadlineMs
	};

	if (deadlineMs <= 0) {
		logger.warn('tenant object response deadline passed', fields);
		throw new ForwardedReadTimeoutError('tenant-object.fetch');
	}

	const response = await headersWithin(
		send,
		deadlineMs,
		delay,
		'tenant-object.fetch'
	);

	if (response !== expiry) {
		return response;
	}

	logger.warn('tenant object response deadline passed', fields);

	if (read === undefined) {
		throw new TenantObjectTimeoutError();
	}

	throw new ForwardedReadTimeoutError('tenant-object.fetch');
}

/**
Sends a request with `send` and waits up to `deadlineMs`, which `delay`
waits out, for its response headers. Returns {@link expiry} when the
deadline passes first.
*/
async function headersWithin(
	send: (signal: AbortSignal) => Promise<Response>,
	deadlineMs: number,
	delay: Delay,
	subrequest: string
): Promise<Response | typeof expiry> {
	const settled = new AbortController();
	const cancel = new AbortController();
	const expired = async (): Promise<typeof expiry> => {
		await delay(deadlineMs, settled.signal);

		return expiry;
	};
	const pending = send(cancel.signal);
	let result: Response | typeof expiry;

	try {
		result = await Promise.race([pending, expired()]);
	} finally {
		settled.abort();
	}

	if (result === expiry) {
		// Aborting the signal cancels the subrequest, and the runtime rejects
		// `pending`, so the Worker never receives an answer that arrives later.
		// The receiver can still complete the request. A response that arrives
		// between the deadline and this abort is dropped unread, and the runtime
		// releases it when the invocation ends.
		cancel.abort(new SubrequestTimeoutError(subrequest));
	}

	return result;
}

/**
Wraps the tenant Worker's service binding so that every `fetch` has a
deadline for its response headers, which `delay` waits out. A fetch must run
within `withinTenantWorkerRead`, which specifies the read and its deadline.
Any other fetch is refused without being sent. A fetch that misses its deadline
fails with the retryable 503 of a timed-out read. The deadline ends when the
headers arrive, so it does not cover a streamed NAR body.

Only `fetch` changes. The native `connect` is bound to the binding, and RPC
methods are returned unchanged.
*/
export function boundedTenantService<T extends Fetcher>(
	service: T,
	delay: Delay
): T {
	return new Proxy(service, {
		get(target, property) {
			// workerd rejects a call of a native method whose receiver is the proxy.
			if (property === 'connect') {
				return target.connect.bind(target);
			}

			// The binding's RPC methods are stubs too, so return them unbound, as
			// `boundedStub` does.
			if (property !== 'fetch') {
				const value: unknown = Reflect.get(target, property, target);

				return value;
			}

			return (input: RequestInfo | URL, init?: RequestInit) =>
				tenantWorkerFetchWithinDeadline(
					(signal) =>
						target.fetch(input, {
							...init,
							signal: withCallerSignal(signal, input, init)
						}),
					delay
				);
		}
	});
}

async function tenantWorkerFetchWithinDeadline(
	send: (signal: AbortSignal) => Promise<Response>,
	delay: Delay
): Promise<Response> {
	const read = currentTenantWorkerRead();

	if (read === undefined) {
		throw new TenantWorkerReadUnspecifiedError();
	}

	const deadlineMs = read.deadline.remainingMs();
	const fields = { kind: read.read, deadlineMs };

	if (deadlineMs <= 0) {
		tenantWorkerLogger.warn('tenant Worker response deadline passed', fields);
		throw new ForwardedReadTimeoutError('tenant-worker.fetch');
	}

	const response = await headersWithin(
		send,
		deadlineMs,
		delay,
		'tenant-worker.fetch'
	);

	if (response !== expiry) {
		return response;
	}

	tenantWorkerLogger.warn('tenant Worker response deadline passed', fields);
	throw new ForwardedReadTimeoutError('tenant-worker.fetch');
}
