import { vi } from 'vitest';

const maximumYields = 10_000;

/**
Waits until `isSent` reports that a stalled probe request has been sent and
its deadline timer is the only fake timer. Advancing fake time earlier could
expire the deadline of another request that is still reading the netrc file
with real I/O.

The caller must fake only `setTimeout` and `clearTimeout`, so that
`setImmediate` still lets that I/O complete.
*/
export async function untilOnlyStalledRequestPending(
	isSent: () => boolean
): Promise<void> {
	for (let attempt = 0; attempt < maximumYields; attempt += 1) {
		if (isSent() && vi.getTimerCount() === 1) {
			return;
		}

		await new Promise((resolve) => setImmediate(resolve));
	}

	throw new Error(
		'The stalled request did not become the only one with a deadline'
	);
}

/**
Returns a promise that stays pending, as a response on a stalled connection
does, until `signal` aborts. The promise then rejects with the abort reason.
*/
export function stalledResponse(
	signal: AbortSignal | null | undefined
): Promise<Response> {
	const { promise, reject } = Promise.withResolvers<Response>();

	signal?.addEventListener(
		'abort',
		() => {
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error('The request was aborted', { cause: signal.reason })
			);
		},
		{ once: true }
	);

	return promise;
}
