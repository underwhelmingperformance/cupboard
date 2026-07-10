import { describe, expect, it, vi } from 'vitest';

import { CliAbortError } from '../errors.ts';

import { isTransientResponse, retryingFetcher } from './retry.ts';

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

const ok = () => new Response('ok', { status: 200 });
const status = (code: number) => () => new Response('', { status: code });

describe('isTransientResponse', () => {
	it.each([
		{ code: 429, transient: true },
		{ code: 502, transient: true },
		{ code: 503, transient: true },
		{ code: 504, transient: true },
		{ code: 500, transient: false },
		{ code: 507, transient: false },
		{ code: 400, transient: false },
		{ code: 404, transient: false },
		{ code: 200, transient: false }
	])('treats $code as transient=$transient', ({ code, transient }) => {
		expect(isTransientResponse(new Response('', { status: code }))).toBe(
			transient
		);
	});
});

describe('retryingFetcher', () => {
	it.each([429, 502, 503, 504])(
		'retries a %i and returns the eventual success',
		async (code) => {
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

				expect({ status: response.status, attempts: attempts() }).toStrictEqual(
					{ status: 200, attempts: 3 }
				);
			} finally {
				vi.useRealTimers();
			}
		}
	);

	it.each([400, 404, 500, 507])(
		'does not retry a %i, returning it at once',
		async (code) => {
			const { fetcher, attempts } = scriptedFetcher([status(code)]);

			const response = await retryingFetcher(fetcher)('https://x.test');

			expect({ status: response.status, attempts: attempts() }).toStrictEqual({
				status: code,
				attempts: 1
			});
		}
	);

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
				status: 200,
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
				Array.from({ length: 5 }, () => status(503))
			);

			const pending = retryingFetcher(fetcher)('https://x.test');
			await vi.advanceTimersByTimeAsync(60_000);
			const response = await pending;

			expect({ status: response.status, attempts: attempts() }).toStrictEqual({
				status: 503,
				attempts: 5
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('clones a Request so a retried body is re-sent', async () => {
		vi.useFakeTimers();

		try {
			const { fetcher, attempts, bodies } = scriptedFetcher([status(503), ok]);
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
					new Response('', { status: 503, headers: { 'retry-after': '2' } }),
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
					new Response('', { status: 503, headers: { 'retry-after': '3600' } }),
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
			const { fetcher, attempts } = scriptedFetcher([status(503), ok]);

			const pending = rejectedBy(() =>
				retryingFetcher(fetcher)('https://x.test', {
					signal: controller.signal
				})
			);
			controller.abort(new CliAbortError());
			await vi.advanceTimersByTimeAsync(60_000);

			expect(await pending).toBeInstanceOf(CliAbortError);
			expect(attempts()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
