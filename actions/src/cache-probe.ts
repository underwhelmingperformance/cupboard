import { ProbeTimeoutError } from './errors.ts';

export const probeDeadlineMs = 30_000;

/** Fetch and consume a cache endpoint within the action's probe deadline. */
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
	const result = new Promise<Result>((resolve, reject) => {
		timer = setTimeout(() => {
			const error = new ProbeTimeoutError(url);
			reject(error);
			deadlineController.abort(error);
		}, deadlineMs);

		void pending.then(resolve, reject);
	});

	try {
		return await result;
	} finally {
		clearTimeout(timer);
	}
}
