import { setImmediate } from 'node:timers/promises';

/**
Calls the global `fetch` after the event loop has run its pending
`setImmediate` callbacks. When a response ends, undici returns its keep-alive
connection to the pool in a `setImmediate` callback. A request sent before that
callback finds the connection busy and opens another one, so without this wait
a request that directly follows another to the same origin opens a second
connection.
*/
export const keepAliveFetch: typeof fetch = async (input, init) => {
	await setImmediate();

	return fetch(input, init);
};
