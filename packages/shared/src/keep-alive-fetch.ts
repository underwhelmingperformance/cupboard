import { setImmediate } from 'node:timers/promises';

/**
Wraps a fetcher so that it runs after the event loop has run its pending
`setImmediate` callbacks. When a response ends, undici returns its keep-alive
connection to the pool in a `setImmediate` callback. A request sent before that
callback finds the connection busy and opens another one, so without this wait
a request that directly follows another to the same origin opens a second
connection.
*/
export function afterPendingCallbacks<Input, Init, Result>(
	fetcher: (input: Input, init?: Init) => Promise<Result>
): (input: Input, init?: Init) => Promise<Result> {
	return async (input, init) => {
		await setImmediate();

		return fetcher(input, init);
	};
}

/**
Calls the global `fetch` after the event loop has run its pending
`setImmediate` callbacks, as `afterPendingCallbacks` does for any fetcher.
*/
export const keepAliveFetch: typeof fetch = afterPendingCallbacks(
	(input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init)
);
