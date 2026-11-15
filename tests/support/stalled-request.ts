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
