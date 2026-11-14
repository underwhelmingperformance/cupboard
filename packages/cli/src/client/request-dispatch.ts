import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe } from 'node:diagnostics_channel';

/**
What undici reported about the HTTP requests that one operation started.
undici publishes `undici:request:create` when it creates a request, in the
asynchronous context of the `fetch` call, and `undici:client:sendHeaders`
when it writes the request's headers to the connection. Node's `fetch` and
the `undici` package both publish them.
*/
export interface RequestDispatch {
	/**
	Whether a server may have received a request. It is false only when
	undici reported creating a request and never reported writing its
	headers. Without any report, for example from a fetcher that does not use
	undici, the request counts as possibly sent.
	*/
	readonly mayHaveBeenSent: boolean;
}

class RecordedDispatch implements RequestDispatch {
	#hasCreatedRequest = false;
	#hasSentHeaders = false;

	get mayHaveBeenSent(): boolean {
		return !this.#hasCreatedRequest || this.#hasSentHeaders;
	}

	recordCreated(): void {
		this.#hasCreatedRequest = true;
	}

	recordHeadersSent(): void {
		this.#hasSentHeaders = true;
	}
}

function requestOf(message: unknown): object | undefined {
	if (typeof message !== 'object' || message === null) {
		return undefined;
	}

	const request: unknown = Reflect.get(message, 'request');

	return typeof request === 'object' && request !== null ? request : undefined;
}

// Subscribes to undici's channels on first use, and attributes each request
// to the operation in whose context undici created it.
class DispatchObserver {
	readonly #current = new AsyncLocalStorage<RecordedDispatch>();
	readonly #dispatches = new WeakMap<object, RecordedDispatch>();
	#isSubscribed = false;

	#subscribe(): void {
		if (this.#isSubscribed) {
			return;
		}

		this.#isSubscribed = true;
		subscribe('undici:request:create', (message) => {
			const dispatch = this.#current.getStore();
			const request = requestOf(message);

			if (dispatch === undefined || request === undefined) {
				return;
			}

			this.#dispatches.set(request, dispatch);
			dispatch.recordCreated();
		});
		subscribe('undici:client:sendHeaders', (message) => {
			const request = requestOf(message);

			if (request !== undefined) {
				this.#dispatches.get(request)?.recordHeadersSent();
			}
		});
	}

	observe<T>(operation: () => Promise<T>): {
		readonly dispatch: RequestDispatch;
		readonly result: Promise<T>;
	} {
		this.#subscribe();

		const dispatch = new RecordedDispatch();

		return { dispatch, result: this.#current.run(dispatch, operation) };
	}
}

const observer = new DispatchObserver();

/**
Runs `operation` and records what undici reports about the requests that it
starts.
*/
export function observeDispatch<T>(operation: () => Promise<T>): {
	readonly dispatch: RequestDispatch;
	readonly result: Promise<T>;
} {
	return observer.observe(operation);
}
