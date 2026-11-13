import { getLogger } from '@cupboard/logger';
import { abortableSleep } from '@cupboard/shared/retry';

import { SubrequestTimeoutError, TenantObjectTimeoutError } from '../errors.ts';
import { tenantOperationBudgetMs } from '../policy/streaming.ts';

import { currentForwardDeadline } from './deadline.ts';
import { passThrough } from './pass-through.ts';

/**
Waits `ms` milliseconds, or until `signal` aborts. Code that sets a deadline
takes a `Delay`, so a test decides when the deadline passes.
*/
export type Delay = (ms: number, signal: AbortSignal) => Promise<void>;

/**
The clock that the deadlines of forwarded requests use: `now` for the
start of a deadline and `delay` to wait for its end.
*/
export interface DeadlineClock {
	readonly now: () => number;
	readonly delay: Delay;
}

export const systemClock: DeadlineClock = {
	now: () => Date.now(),
	delay: abortableSleep
};

const logger = getLogger(['cupboard', 'tenant-object']);
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
		throw new SubrequestTimeoutError('tenant-object.fetch');
	}

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

	if (result !== expiry) {
		return result;
	}

	// Aborting the signal cancels the subrequest, and the runtime rejects
	// `pending`, so the Worker never receives an answer that the object sends
	// later. The object can still complete the request. A response that
	// arrives between the deadline and this abort is dropped unread, and the
	// runtime releases it when the invocation ends.
	logger.warn('tenant object response deadline passed', fields);
	cancel.abort(new SubrequestTimeoutError('tenant-object.fetch'));

	if (read === undefined) {
		throw new TenantObjectTimeoutError();
	}

	throw new SubrequestTimeoutError('tenant-object.fetch');
}
