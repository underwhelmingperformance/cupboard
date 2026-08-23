import { ProbeTimeoutError } from './errors.ts';

export const probeDeadlineMs = 30_000;

/**
 * Apply one deadline to both the request and response consumption. Timing only
 * `fetch` would let a stalled response body hang the probe indefinitely.
 */
export async function fetchWithProbeDeadline<Result>(
	fetcher: typeof fetch,
	url: string,
	init: RequestInit | undefined,
	consume: (response: Response) => Result | Promise<Result>,
	deadlineMs = probeDeadlineMs
): Promise<Result> {
	const deadlineController = new AbortController();
	const callerSignal = init?.signal ?? undefined;
	const signal =
		callerSignal === undefined
			? deadlineController.signal
			: AbortSignal.any([callerSignal, deadlineController.signal]);

	const pending = (async () => {
		const response = await fetcher(url, { ...init, signal });

		return consume(response);
	})();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new ProbeTimeoutError(url);
			reject(error);
			deadlineController.abort(error);
		}, deadlineMs);
	});

	try {
		return await Promise.race([pending, deadline]);
	} finally {
		clearTimeout(timer);
	}
}
