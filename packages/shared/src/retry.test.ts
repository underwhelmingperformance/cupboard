import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import {
	backoffDelay,
	isTransientResponse,
	reachableFetcher,
	retryingFetcher as makeRetryingFetcher
} from './retry.ts';

function retryingFetcher(fetcher: typeof fetch): typeof fetch {
	return makeRetryingFetcher(fetcher, 'replay-safe');
}

function networkFailure(): TypeError {
	return new TypeError('fetch failed', {
		cause: { code: 'ECONNRESET' }
	});
}

// Stands in for a caller's typed abort reason (the CLI aborts with its own
// error class); the wrapper must surface it unchanged.
class TestAbortError extends Error {
	constructor() {
		super('aborted');
		this.name = 'TestAbortError';
	}
}

function scriptedFetcher(outcomes: (() => Response | Promise<Response>)[]): {
	readonly fetcher: typeof fetch;
	readonly attempts: () => number;
	readonly bodies: readonly string[];
} {
	let attempts = 0;
	const bodies: string[] = [];

	const fetcher: typeof fetch = async (input) => {
		attempts += 1;

		if (input instanceof Request) {
			bodies.push(await input.text());
		}

		const next = outcomes[attempts - 1];

		if (next === undefined) {
			throw new Error('fetch script exhausted');
		}

		return next();
	};

	return { fetcher, attempts: () => attempts, bodies };
}

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}

	return undefined;
}

const ok = () => new Response('ok', { status: StatusCodes.OK });
const status = (code: number) => () => new Response('', { status: code });

describe('isTransientResponse', () => {
	it.each([
		{ code: StatusCodes.TOO_MANY_REQUESTS, transient: true },
		{ code: StatusCodes.BAD_GATEWAY, transient: true },
		{ code: StatusCodes.SERVICE_UNAVAILABLE, transient: true },
		{ code: StatusCodes.GATEWAY_TIMEOUT, transient: true },
		{ code: StatusCodes.INTERNAL_SERVER_ERROR, transient: false },
		{ code: StatusCodes.INSUFFICIENT_STORAGE, transient: false },
		{ code: StatusCodes.BAD_REQUEST, transient: false },
		{ code: StatusCodes.NOT_FOUND, transient: false },
		{ code: StatusCodes.OK, transient: false }
	])('treats $code as transient=$transient', ({ code, transient }) => {
		expect(isTransientResponse(new Response('', { status: code }))).toBe(
			transient
		);
	});
});

describe('backoffDelay', () => {
	it('uses full jitter from zero to the exponential ceiling', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0);

		try {
			const pending = backoffDelay(1);
			await vi.advanceTimersByTimeAsync(0);

			await expect(pending).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('removes its abort listener after the delay completes', async () => {
		vi.useFakeTimers();

		try {
			const controller = new AbortController();
			const add = vi.spyOn(controller.signal, 'addEventListener');
			const remove = vi.spyOn(controller.signal, 'removeEventListener');
			const pending = backoffDelay(1, controller.signal);

			await vi.advanceTimersByTimeAsync(60_000);
			await pending;

			const listener = add.mock.calls[0]?.[1];
			expect({
				added: add.mock.calls.length,
				removed: remove.mock.calls
			}).toStrictEqual({
				added: 1,
				removed: [['abort', listener]]
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('retryingFetcher', () => {
	it.each([
		StatusCodes.TOO_MANY_REQUESTS,
		StatusCodes.BAD_GATEWAY,
		StatusCodes.SERVICE_UNAVAILABLE,
		StatusCodes.GATEWAY_TIMEOUT
	])('retries a %i and returns the eventual success', async (code) => {
		vi.useFakeTimers();

		try {
			const { fetcher, attempts } = scriptedFetcher([
				status(code),
				status(code),
				ok
			]);

			const pending = retryingFetcher(fetcher)('https://x.test');
			await vi.advanceTimersByTimeAsync(60_000);
			const response = await pending;

			expect({ status: response.status, attempts: attempts() }).toStrictEqual({
				status: StatusCodes.OK,
				attempts: 3
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('cancels every transient response body discarded for a retry', async () => {
		vi.useFakeTimers();

		try {
			const cancelled: number[] = [];
			const transient =
				(attempt: number): (() => Response) =>
				() =>
					new Response(
						new ReadableStream({
							cancel: () => {
								cancelled.push(attempt);
							}
						}),
						{ status: StatusCodes.SERVICE_UNAVAILABLE }
					);
			const { fetcher } = scriptedFetcher([transient(1), transient(2), ok]);

			const pending = retryingFetcher(fetcher)('https://x.test');
			await vi.advanceTimersByTimeAsync(60_000);
			await pending;

			expect(cancelled).toStrictEqual([1, 2]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		StatusCodes.BAD_REQUEST,
		StatusCodes.NOT_FOUND,
		StatusCodes.INTERNAL_SERVER_ERROR,
		StatusCodes.INSUFFICIENT_STORAGE
	])('does not retry a %i, returning it at once', async (code) => {
		const { fetcher, attempts } = scriptedFetcher([status(code)]);

		const response = await retryingFetcher(fetcher)('https://x.test');

		expect({ status: response.status, attempts: attempts() }).toStrictEqual({
			status: code,
			attempts: 1
		});
	});

	it('retries a network fault and returns the eventual success', async () => {
		vi.useFakeTimers();

		try {
			const { fetcher, attempts } = scriptedFetcher([
				() => Promise.reject(networkFailure()),
				ok
			]);

			const pending = retryingFetcher(fetcher)('https://x.test');
			await vi.advanceTimersByTimeAsync(60_000);
			const response = await pending;

			expect({ status: response.status, attempts: attempts() }).toStrictEqual({
				status: StatusCodes.OK,
				attempts: 2
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not retry an unrelated TypeError from a fetch wrapper', async () => {
		const failure = new TypeError('wrapper failed');
		const { fetcher, attempts } = scriptedFetcher([
			() => Promise.reject(failure),
			ok
		]);

		await expect(retryingFetcher(fetcher)('https://x.test')).rejects.toBe(
			failure
		);
		expect(attempts()).toBe(1);
	});

	it('does not replay an operation declared unsafe', async () => {
		const { fetcher, attempts } = scriptedFetcher([
			status(StatusCodes.SERVICE_UNAVAILABLE),
			ok
		]);

		const response = await makeRetryingFetcher(
			fetcher,
			'replay-unsafe'
		)('https://x.test');

		expect({ status: response.status, attempts: attempts() }).toStrictEqual({
			status: StatusCodes.SERVICE_UNAVAILABLE,
			attempts: 1
		});
	});

	it('returns the last transient response once the retry budget is spent', async () => {
		vi.useFakeTimers();

		try {
			const { fetcher, attempts } = scriptedFetcher(
				Array.from({ length: 5 }, () => status(StatusCodes.SERVICE_UNAVAILABLE))
			);

			const pending = retryingFetcher(fetcher)('https://x.test');
			await vi.advanceTimersByTimeAsync(60_000);
			const response = await pending;

			expect({ status: response.status, attempts: attempts() }).toStrictEqual({
				status: StatusCodes.SERVICE_UNAVAILABLE,
				attempts: 5
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('clones a Request so a retried body is re-sent', async () => {
		vi.useFakeTimers();

		try {
			const { fetcher, attempts, bodies } = scriptedFetcher([
				status(StatusCodes.SERVICE_UNAVAILABLE),
				ok
			]);
			const request = new Request('https://x.test', {
				method: 'POST',
				body: 'payload'
			});

			const pending = retryingFetcher(fetcher)(request);
			await vi.advanceTimersByTimeAsync(60_000);
			await pending;

			expect({ attempts: attempts(), bodies }).toStrictEqual({
				attempts: 2,
				bodies: ['payload', 'payload']
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('honours a Retry-After under the cap before retrying', async () => {
		vi.useFakeTimers();

		try {
			const { fetcher, attempts } = scriptedFetcher([
				() =>
					new Response('', {
						status: StatusCodes.SERVICE_UNAVAILABLE,
						headers: { 'retry-after': '2' }
					}),
				ok
			]);

			const pending = retryingFetcher(fetcher)('https://x.test');

			await vi.advanceTimersByTimeAsync(1999);
			expect(attempts()).toBe(1);

			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(attempts()).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('honours an HTTP-date Retry-After before retrying', async () => {
		vi.useFakeTimers();
		const now = Date.UTC(2026, 7, 22, 22, 0, 0);
		vi.setSystemTime(now);

		try {
			const { fetcher, attempts } = scriptedFetcher([
				() =>
					new Response('', {
						status: StatusCodes.SERVICE_UNAVAILABLE,
						headers: {
							'retry-after': new Date(now + 2000).toUTCString()
						}
					}),
				ok
			]);
			const pending = retryingFetcher(fetcher)('https://x.test');

			await vi.advanceTimersByTimeAsync(1999);
			expect(attempts()).toBe(1);

			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(attempts()).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('treats a decimal Retry-After as invalid', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0.999);

		try {
			const { fetcher, attempts } = scriptedFetcher([
				() =>
					new Response('', {
						status: StatusCodes.SERVICE_UNAVAILABLE,
						headers: { 'retry-after': '1.5' }
					}),
				ok
			]);
			const pending = retryingFetcher(fetcher)('https://x.test');

			await vi.advanceTimersByTimeAsync(250);
			await pending;

			expect(attempts()).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('caps a Retry-After far larger than the ceiling', async () => {
		vi.useFakeTimers();

		try {
			const { fetcher, attempts } = scriptedFetcher([
				() =>
					new Response('', {
						status: StatusCodes.SERVICE_UNAVAILABLE,
						headers: { 'retry-after': '3600' }
					}),
				ok
			]);

			const pending = retryingFetcher(fetcher)('https://x.test');

			await vi.advanceTimersByTimeAsync(5000);
			await pending;

			expect(attempts()).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops retrying when the signal aborts during the wait', async () => {
		vi.useFakeTimers();

		try {
			const controller = new AbortController();
			const { fetcher, attempts } = scriptedFetcher([
				status(StatusCodes.SERVICE_UNAVAILABLE),
				ok
			]);

			const pending = rejectedBy(() =>
				retryingFetcher(fetcher)('https://x.test', {
					signal: controller.signal
				})
			);
			controller.abort(new TestAbortError());
			await vi.advanceTimersByTimeAsync(60_000);

			expect(await pending).toBeInstanceOf(TestAbortError);
			expect(attempts()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops retrying when the input Request aborts during the wait', async () => {
		vi.useFakeTimers();

		try {
			const controller = new AbortController();
			const request = new Request('https://x.test', {
				signal: controller.signal
			});
			const { fetcher, attempts } = scriptedFetcher([
				status(StatusCodes.SERVICE_UNAVAILABLE),
				ok
			]);

			const pending = rejectedBy(() => retryingFetcher(fetcher)(request));
			controller.abort(new TestAbortError());
			await vi.advanceTimersByTimeAsync(60_000);

			expect(await pending).toBeInstanceOf(TestAbortError);
			expect(attempts()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('uses an init signal instead of the input Request signal', async () => {
		const input = new AbortController();
		const init = new AbortController();
		input.abort(new TestAbortError());
		const { fetcher, attempts } = scriptedFetcher([ok]);

		const response = await retryingFetcher(fetcher)(
			new Request('https://x.test', { signal: input.signal }),
			{ signal: init.signal }
		);

		expect({ status: response.status, attempts: attempts() }).toStrictEqual({
			status: StatusCodes.OK,
			attempts: 1
		});
	});
});

class HostDownError extends Error {
	constructor(
		public readonly host: string,
		public override readonly cause: TypeError
	) {
		super('host down');
		this.name = 'HostDownError';
	}
}

const failing: typeof fetch = () => Promise.reject(networkFailure());

describe('reachableFetcher', () => {
	it('translates a network fault through the supplied error factory', async () => {
		const fetcher = reachableFetcher(
			failing,
			(host, cause) => new HostDownError(host, cause)
		);

		let failure: unknown;
		try {
			await fetcher('https://cache.example.test/nix-cache-info');
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(HostDownError);
		expect(failure instanceof HostDownError ? failure.host : undefined).toBe(
			'cache.example.test'
		);
	});

	it('lets a non-network failure propagate unchanged', async () => {
		const abort = new DOMException('aborted', 'AbortError');
		const fetcher = reachableFetcher(
			() => Promise.reject(abort),
			(host, cause) => new HostDownError(host, cause)
		);

		await expect(fetcher('https://cache.example.test/')).rejects.toBe(abort);
	});

	it('lets an unrelated TypeError propagate unchanged', async () => {
		const failure = new TypeError('response decoder failed');
		const fetcher = reachableFetcher(
			() => Promise.reject(failure),
			(host, cause) => new HostDownError(host, cause)
		);

		await expect(fetcher('https://cache.example.test/')).rejects.toBe(failure);
	});
});
