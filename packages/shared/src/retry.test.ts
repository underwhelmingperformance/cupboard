import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import { isTransientResponse, retryingFetcher } from './retry.ts';

// Stands in for a caller's typed abort reason (the CLI aborts with its own
// error class); the wrapper must surface it unchanged.
class TestAbortError extends Error {
	constructor() {
		super('aborted');
		this.name = 'TestAbortError';
	}
}

// A fetcher scripted with a fixed sequence of outcomes, recording every attempt
// so a test can assert how many times it was called and what it received.
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
				() => Promise.reject(new TypeError('fetch failed')),
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

	it('returns the last transient response once the retry budget is spent', async () => {
		vi.useFakeTimers();

		try {
			// One attempt plus the four retries, all refused.
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

			// The cap is 5s, so advancing past it fires the retry despite the hour-long
			// header.
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
});
