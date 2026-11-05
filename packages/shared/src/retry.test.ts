import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import {
	createServer as createNetServer,
	type Server as NetServer
} from 'node:net';

import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import { type RandomSource } from './backoff.ts';
import { captureLogs } from './log-capture.test-support.ts';
import {
	backoffDelay,
	isTransientResponse,
	reachableFetcher,
	retryingFetcher as makeRetryingFetcher,
	transientRetryBackoff
} from './retry.ts';

function retryingFetcher(
	fetcher: typeof fetch,
	random?: RandomSource
): typeof fetch {
	return makeRetryingFetcher(fetcher, 'replay-safe', { random });
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

describe('transientRetryBackoff', () => {
	it.each([
		{ attempt: 1, random: 0, expected: 0 },
		{ attempt: 1, random: 0.5, expected: 125 },
		{ attempt: 3, random: 0.5, expected: 500 },
		{ attempt: 3, random: 0.999, expected: 999 },
		{ attempt: 6, random: 0.5, expected: 2500 },
		{ attempt: 40, random: 0.5, expected: 2500 }
	])(
		'scales attempt $attempt with random $random to $expected',
		({ attempt, random, expected }) => {
			expect(transientRetryBackoff(() => random).delayMs(attempt)).toBe(
				expected
			);
		}
	);
});

describe('backoffDelay', () => {
	it('uses full jitter from zero to the exponential ceiling', async () => {
		vi.useFakeTimers();

		try {
			const pending = backoffDelay(
				1,
				undefined,
				transientRetryBackoff(() => 0)
			);
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

		try {
			const { fetcher, attempts } = scriptedFetcher([
				() =>
					new Response('', {
						status: StatusCodes.SERVICE_UNAVAILABLE,
						headers: { 'retry-after': '1.5' }
					}),
				ok
			]);
			const pending = retryingFetcher(fetcher, () => 0.999)('https://x.test');

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

function systemError(code: string, syscall: string): Error {
	return Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
}

// Node's error when every address of a host failed or timed out.
function everyAddressFailed(...errors: readonly Error[]): AggregateError {
	return new AggregateError(errors, 'every address failed');
}

// The shape of undici's `ConnectTimeoutError` for a host with IPv4 and IPv6
// addresses on a machine without IPv6.
class ConnectTimeoutError extends Error {
	readonly code = 'UND_ERR_CONNECT_TIMEOUT';

	constructor() {
		const timedOut = systemError('ETIMEDOUT', 'connect');
		const unreachable = systemError('ENETUNREACH', 'connect');

		super('Connect Timeout Error', {
			cause: everyAddressFailed(timedOut, unreachable)
		});
		this.name = 'ConnectTimeoutError';
	}
}

function fetchFailure(cause: unknown): TypeError {
	return new TypeError('fetch failed', { cause });
}

function rejection(error: Error): () => Promise<Response> {
	return () => Promise.reject(error);
}

function causeCode(error: unknown): unknown {
	if (!(error instanceof Error) || !(error.cause instanceof Error)) {
		return undefined;
	}

	return 'code' in error.cause ? error.cause.code : undefined;
}

async function listening(server: Server | NetServer): Promise<string> {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();

	if (address === null || typeof address === 'string') {
		throw new TypeError('Expected a TCP address');
	}

	return `http://127.0.0.1:${String(address.port)}`;
}

async function closed(server: Server | NetServer): Promise<void> {
	server.close();
	await once(server, 'close');
}

describe('retryingFetcher for a replay-unsafe request', () => {
	it.each([
		{
			failure: 'a connect timeout',
			error: () => fetchFailure(new ConnectTimeoutError())
		},
		{
			failure: 'a refused connection',
			error: () => fetchFailure(systemError('ECONNREFUSED', 'connect'))
		},
		{
			failure: 'an unreachable network',
			error: () => fetchFailure(systemError('ENETUNREACH', 'connect'))
		},
		{
			failure: 'an unreachable host',
			error: () => fetchFailure(systemError('EHOSTUNREACH', 'connect'))
		},
		{
			failure: 'every address failing',
			error: () =>
				fetchFailure(
					everyAddressFailed(
						systemError('ETIMEDOUT', 'connect'),
						systemError('ENETUNREACH', 'connect')
					)
				)
		},
		{
			failure: 'a missing DNS name',
			error: () => fetchFailure(systemError('ENOTFOUND', 'getaddrinfo'))
		},
		{
			failure: 'a temporary DNS failure',
			error: () => fetchFailure(systemError('EAI_AGAIN', 'getaddrinfo'))
		}
	])(
		'retries after $failure and returns the eventual success',
		async ({ error }) => {
			vi.useFakeTimers();

			try {
				const { fetcher, attempts, bodies } = scriptedFetcher([
					rejection(error()),
					ok
				]);

				const pending = makeRetryingFetcher(
					fetcher,
					'replay-unsafe'
				)(
					new Request('https://x.test/token', {
						method: 'POST',
						body: 'payload',
						redirect: 'manual'
					})
				);
				await vi.advanceTimersByTimeAsync(60_000);
				const response = await pending;

				expect({
					status: response.status,
					attempts: attempts(),
					bodies
				}).toStrictEqual({
					status: StatusCodes.OK,
					attempts: 2,
					bodies: ['payload', 'payload']
				});
			} finally {
				vi.useRealTimers();
			}
		}
	);

	// With redirects followed, the connection failure can come from the redirect
	// target after the server completed the original request, for example a POST
	// that returned 303.
	it.each([
		{
			redirect: 'followed by default',
			request: () => new Request('https://x.test/token', { method: 'POST' }),
			init: undefined,
			attempts: 1
		},
		{
			redirect: 'followed by default with an init',
			request: () => 'https://x.test/token',
			init: { method: 'POST' },
			attempts: 1
		},
		{
			redirect: 'followed explicitly',
			request: () => 'https://x.test/token',
			init: { method: 'POST', redirect: 'follow' },
			attempts: 1
		},
		{
			redirect: 'refused',
			request: () => 'https://x.test/token',
			init: { method: 'POST', redirect: 'error' },
			attempts: 2
		},
		{
			redirect: 'returned on the Request',
			request: () =>
				new Request('https://x.test/token', {
					method: 'POST',
					redirect: 'manual'
				}),
			init: undefined,
			attempts: 2
		}
	] satisfies {
		redirect: string;
		request: () => Request | string;
		init: RequestInit | undefined;
		attempts: number;
	}[])(
		'retries a connection failure only when redirects are not followed: $redirect',
		async ({ request, init, attempts: expectedAttempts }) => {
			vi.useFakeTimers();

			try {
				const failure = fetchFailure(systemError('ECONNREFUSED', 'connect'));
				const { fetcher, attempts } = scriptedFetcher([rejection(failure), ok]);

				const pending = rejectedBy(() =>
					makeRetryingFetcher(fetcher, 'replay-unsafe')(request(), init)
				);
				await vi.advanceTimersByTimeAsync(60_000);

				expect({
					error: await pending,
					attempts: attempts()
				}).toStrictEqual({
					error: expectedAttempts === 1 ? failure : undefined,
					attempts: expectedAttempts
				});
			} finally {
				vi.useRealTimers();
			}
		}
	);

	it.each([
		{ failure: 'a reset', cause: systemError('ECONNRESET', 'read') },
		{ failure: 'a closed socket', cause: { code: 'UND_ERR_SOCKET' } },
		{
			failure: 'an unreachable host after connecting',
			cause: systemError('EHOSTUNREACH', 'read')
		},
		{
			failure: 'a timeout after connecting',
			cause: systemError('ETIMEDOUT', 'read')
		},
		{
			failure: 'a mix of connect and socket failures',
			cause: everyAddressFailed(
				systemError('ECONNREFUSED', 'connect'),
				systemError('ECONNRESET', 'read')
			)
		}
	])('makes one attempt after $failure', async ({ cause }) => {
		const failure = fetchFailure(cause);
		const { fetcher, attempts } = scriptedFetcher([rejection(failure), ok]);

		const error = await rejectedBy(() =>
			makeRetryingFetcher(fetcher, 'replay-unsafe')('https://x.test/token', {
				method: 'POST',
				body: 'payload',
				redirect: 'manual'
			})
		);

		expect({ error, attempts: attempts() }).toStrictEqual({
			error: failure,
			attempts: 1
		});
	});

	it.each([
		{
			failure: 'the server closes the connection',
			server: () =>
				createServer((request) => {
					request.socket.destroy();
				}),
			code: 'UND_ERR_SOCKET'
		},
		{
			failure: 'the server resets the connection',
			server: () =>
				createNetServer((socket) => {
					socket.once('data', () => {
						socket.resetAndDestroy();
					});
				}),
			code: 'ECONNRESET'
		}
	])(
		'does not resend a request after $failure',
		async ({ server: makeServer, code }) => {
			let requests = 0;
			const server = makeServer();
			server.on('connection', () => {
				requests += 1;
			});
			const origin = await listening(server);

			try {
				const error = await rejectedBy(() =>
					makeRetryingFetcher(fetch, 'replay-unsafe')(`${origin}/token`, {
						method: 'POST',
						body: 'payload',
						redirect: 'manual'
					})
				);

				expect({ requests, code: causeCode(error) }).toStrictEqual({
					requests: 1,
					code
				});
			} finally {
				await closed(server);
			}
		}
	);

	it('gives up after the retry budget when the connection keeps failing', async () => {
		vi.useFakeTimers();

		try {
			const failure = fetchFailure(new ConnectTimeoutError());
			const { fetcher, attempts } = scriptedFetcher(
				Array.from({ length: 6 }, () => rejection(failure))
			);

			const pending = rejectedBy(() =>
				makeRetryingFetcher(fetcher, 'replay-unsafe')('https://x.test/token', {
					method: 'POST',
					redirect: 'manual'
				})
			);
			await vi.advanceTimersByTimeAsync(60_000);

			expect({ error: await pending, attempts: attempts() }).toStrictEqual({
				error: failure,
				attempts: 5
			});
		} finally {
			vi.useRealTimers();
		}
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

describe('retryingFetcher debug logs', () => {
	it('records each transport retry with its status or error code, ray and delay', async () => {
		const records = captureLogs();
		const { fetcher } = scriptedFetcher([
			() =>
				new Response('', {
					status: StatusCodes.SERVICE_UNAVAILABLE,
					headers: { 'cf-ray': '8f0e1d2c3b4a5968-LHR' }
				}),
			() => {
				throw networkFailure();
			},
			ok
		]);

		vi.useFakeTimers();
		try {
			const pending = retryingFetcher(fetcher, () => 0.5)(
				'https://reader:secret@cache.test/api/v1/path-info?token=secret',
				{ method: 'POST', body: 'paths' }
			);
			const settled = expect(pending).resolves.toBeInstanceOf(Response);
			await vi.advanceTimersByTimeAsync(10_000);
			await settled;
		} finally {
			vi.useRealTimers();
		}

		const request = {
			method: 'POST',
			url: 'https://cache.test/api/v1/path-info'
		};
		expect(
			records.filter((record) => record.category[1] === 'fetch')
		).toStrictEqual([
			{
				level: 'debug',
				category: ['cupboard', 'fetch'],
				message: 'retrying after a transient response',
				properties: {
					...request,
					retry: 1,
					status: StatusCodes.SERVICE_UNAVAILABLE,
					cfRay: '8f0e1d2c3b4a5968-LHR',
					delayMs: 125
				}
			},
			{
				level: 'debug',
				category: ['cupboard', 'fetch'],
				message: 'retrying after a network error',
				properties: {
					...request,
					retry: 2,
					code: 'ECONNRESET',
					delayMs: 250
				}
			}
		]);
	});
});
