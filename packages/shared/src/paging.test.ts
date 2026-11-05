import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	destroyAfterHeaders,
	loopbackServer
} from '../../../tests/support/loopback-server.ts';
import { stalledResponse } from '../../../tests/support/stalled-request.ts';

import { collectProgressively } from './collections.ts';
import {
	type CapturedRecord,
	captureLogs
} from './log-capture.test-support.ts';
import {
	type CursorPage,
	cursorPages,
	fetchWithProbeRetries,
	lookupInPages,
	lookupPage,
	maxProbeAttempts,
	PageResultCountError,
	requestWithDeadline
} from './paging.ts';
import { readResponseText } from './response-body.ts';
import { probeDeadlineMs, ProbeTimeoutError } from './timeout.ts';

class TestFailure extends Error {
	constructor(options?: ErrorOptions) {
		super('test failure', options);
		this.name = 'TestFailure';
	}
}

const maximumBackoffMs = 5000;
const target = { url: 'https://cache.test/a' };

function probeLog(
	message: string,
	properties: Record<string, unknown>
): CapturedRecord {
	return {
		level: 'debug',
		category: ['cupboard', 'probe'],
		message,
		properties
	};
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
	try {
		await pending;
	} catch (error) {
		return error;
	}

	throw new Error('Expected the promise to reject');
}

async function stalled(signal: AbortSignal): Promise<string> {
	await stalledResponse(signal);
	return 'never';
}

const replaySafe = { target, replaySafety: 'replay-safe' } as const;

function timeoutFields(failure: unknown): unknown {
	return failure instanceof ProbeTimeoutError
		? { name: failure.name, target: failure.target }
		: failure;
}

describe('requestWithDeadline', () => {
	it.each(['recovered', 'exhausted', 'cancelled'] as const)(
		'records one logical %s outcome across attempts',
		async (outcome) => {
			const records = captureLogs();
			const controller = new AbortController();
			let attempts = 0;
			vi.useFakeTimers();
			try {
				const pending = requestWithDeadline(
					(signal) => {
						attempts += 1;
						return outcome === 'recovered' && attempts === 2
							? Promise.resolve('ok')
							: stalled(signal);
					},
					{ ...replaySafe, signal: controller.signal }
				);
				const settled =
					outcome === 'recovered'
						? expect(pending).resolves.toBe('ok')
						: expect(pending).rejects.toBeInstanceOf(
								outcome === 'exhausted' ? ProbeTimeoutError : TestFailure
							);
				if (outcome === 'cancelled') {
					controller.abort(new TestFailure());
				}
				await vi.runAllTimersAsync();
				await settled;
				expect(
					records
						.filter((record) => record.message === 'logical probe finished')
						.map(({ properties }) => ({
							attempts: properties.attempts,
							disposition: properties.disposition
						}))
				).toStrictEqual([
					{
						attempts:
							outcome === 'recovered' ? 2 : outcome === 'exhausted' ? 3 : 1,
						disposition: outcome
					}
				]);
			} finally {
				vi.useRealTimers();
			}
		}
	);

	it('starts a fresh attempt after its deadline expires and returns its result', async () => {
		let attempts = 0;

		vi.useFakeTimers();
		try {
			const pending = requestWithDeadline((signal) => {
				attempts += 1;
				return attempts === 1 ? stalled(signal) : Promise.resolve('response');
			}, replaySafe);
			const settled = expect(pending).resolves.toBe('response');
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + maximumBackoffMs);
			await settled;
		} finally {
			vi.useRealTimers();
		}

		expect(attempts).toBe(2);
	});

	it.each([
		{ replaySafety: 'replay-safe', attempts: maxProbeAttempts },
		{ replaySafety: 'replay-unsafe', attempts: 1 }
	] as const)(
		'makes $attempts attempts at a $replaySafety request that never answers',
		async ({ replaySafety, attempts }) => {
			let started = 0;

			vi.useFakeTimers();
			try {
				const failure = rejectionOf(
					requestWithDeadline(
						(signal) => {
							started += 1;
							return stalled(signal);
						},
						{ target, replaySafety }
					)
				);
				await vi.advanceTimersByTimeAsync(
					maxProbeAttempts * (probeDeadlineMs + maximumBackoffMs)
				);

				expect({
					failure: timeoutFields(await failure),
					started
				}).toStrictEqual({
					failure: { name: 'ProbeTimeoutError', target: target.url },
					started: attempts
				});
			} finally {
				vi.useRealTimers();
			}
		}
	);

	it.each([
		{ name: 'an ordinary error', error: new TestFailure() },
		{ name: 'a network error', error: new TypeError('fetch failed') },
		{
			name: 'an abort',
			error: new DOMException('This operation was aborted', 'AbortError')
		},
		{
			name: 'a ProbeTimeoutError that the request raises',
			error: new ProbeTimeoutError('https://cache.test/inner')
		}
	])('rejects with $name without another attempt', async ({ error }) => {
		let attempts = 0;

		const failure = await rejectionOf(
			requestWithDeadline(() => {
				attempts += 1;
				return Promise.reject(error);
			}, replaySafe)
		);

		expect({ failure, attempts }).toStrictEqual({
			failure: error,
			attempts: 1
		});
	});

	it('does not start another attempt after the caller has aborted', async () => {
		const controller = new AbortController();
		const reason = new TestFailure();
		let attempts = 0;

		const failure = await rejectionOf(
			requestWithDeadline(
				(signal) => {
					attempts += 1;
					const pending = stalled(signal);
					controller.abort(reason);
					return pending;
				},
				{ ...replaySafe, signal: controller.signal }
			)
		);

		expect({ failure, attempts }).toStrictEqual({
			failure: reason,
			attempts: 1
		});
	});

	it('rejects with the abort reason at once when the request ignores its signal', async () => {
		const controller = new AbortController();
		const reason = new TestFailure();

		vi.useFakeTimers();
		try {
			const failure = rejectionOf(
				requestWithDeadline(() => Promise.race<never>([]), {
					...replaySafe,
					signal: controller.signal
				})
			);
			await vi.advanceTimersByTimeAsync(0);
			controller.abort(reason);
			await vi.advanceTimersByTimeAsync(0);

			expect({
				failure: await failure,
				timers: vi.getTimerCount()
			}).toStrictEqual({ failure: reason, timers: 0 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops with the abort reason when the caller aborts during the backoff', async () => {
		const controller = new AbortController();
		const reason = new TestFailure();
		let attempts = 0;

		vi.useFakeTimers();
		try {
			const pending = requestWithDeadline(
				(signal) => {
					attempts += 1;
					return stalled(signal);
				},
				{ ...replaySafe, signal: controller.signal }
			);
			const settled = expect(pending).rejects.toBe(reason);
			// Expire the first attempt without firing the backoff timer. Node
			// rounds every timer delay up to at least one millisecond.
			await vi.advanceTimersByTimeAsync(probeDeadlineMs);
			controller.abort(reason);
			await vi.advanceTimersByTimeAsync(maximumBackoffMs);
			await settled;
		} finally {
			vi.useRealTimers();
		}

		expect(attempts).toBe(1);
	});
	it('identifies a procedure in its deadline expiry and its debug logs', async () => {
		const records = captureLogs();

		vi.useFakeTimers();
		try {
			const failure = rejectionOf(
				requestWithDeadline(stalled, {
					target: { procedure: 'caches.list' },
					replaySafety: 'replay-unsafe'
				})
			);
			await vi.advanceTimersByTimeAsync(probeDeadlineMs);

			expect({
				failure: timeoutFields(await failure),
				records
			}).toStrictEqual({
				failure: {
					name: 'ProbeTimeoutError',
					target: 'the caches.list procedure'
				},
				records: [
					probeLog('probe attempt finished', {
						procedure: 'caches.list',
						probeId: expect.any(String),
						attempt: 1,
						outcome: 'timed out',
						elapsedMs: probeDeadlineMs
					}),
					probeLog('logical probe finished', {
						procedure: 'caches.list',
						probeId: expect.any(String),
						attempts: 1,
						disposition: 'exhausted',
						elapsedMs: probeDeadlineMs
					})
				]
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('cursorPages', () => {
	it('follows each cursor and retries a page that hangs past its deadline', async () => {
		const requests: (string | undefined)[] = [];
		const pages = new Map<string | undefined, CursorPage<number, string>>([
			[undefined, { items: [1, 2], next: 'second' }],
			['second', { items: [3] }]
		]);

		vi.useFakeTimers();
		try {
			const collect = async (): Promise<number[]> =>
				collectProgressively(
					await cursorPages<number, string>(async (cursor, signal) => {
						requests.push(cursor);
						if (cursor === 'second' && requests.length === 2) {
							await stalled(signal);
						}
						return pages.get(cursor) ?? { items: [] };
					}, replaySafe),
					{ description: 'test listing', maximumItems: 3, maximumPages: 2 }
				);
			const pending = collect();
			const settled = expect(pending).resolves.toStrictEqual([1, 2, 3]);
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + maximumBackoffMs);
			await settled;
		} finally {
			vi.useRealTimers();
		}

		expect(requests).toStrictEqual([undefined, 'second', 'second']);
	});
});

describe('fetchWithProbeRetries', () => {
	it('sends a request again when the first attempt hangs past the deadline', async () => {
		const requests: string[] = [];
		const fetcher: typeof fetch = (input, init) => {
			requests.push(input instanceof Request ? input.url : input.toString());
			return requests.length === 1
				? stalledResponse(init?.signal)
				: Promise.resolve(new Response('response body'));
		};

		vi.useFakeTimers();
		try {
			const pending = fetchWithProbeRetries(
				fetcher,
				'https://cache.test/a.narinfo',
				undefined,
				(response) => response.text()
			);
			const settled = expect(pending).resolves.toBe('response body');
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + maximumBackoffMs);
			await settled;
		} finally {
			vi.useRealTimers();
		}

		expect(requests).toStrictEqual([
			'https://cache.test/a.narinfo',
			'https://cache.test/a.narinfo'
		]);
	});

	it.each(['before the headers', 'during the body'])(
		'opens a new connection for the attempt after a response stalls %s',
		async (stage) => {
			const connections: number[] = [];
			const requests: { path: string; connection: number }[] = [];
			const firstProbe = Promise.withResolvers<undefined>();
			const server = createServer((request, response) => {
				const connection = connections.indexOf(request.socket.remotePort ?? -1);
				requests.push({ path: request.url ?? '', connection });
				if (request.url === '/warm' || requests.length > 2) {
					response.end('response body');
					return;
				}
				if (stage === 'during the body') {
					response.writeHead(200, { 'content-length': '100' });
					response.write('partial');
				}
				firstProbe.resolve(undefined);
			});
			server.on('connection', (socket) => {
				connections.push(socket.remotePort ?? -1);
			});
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');

			try {
				const address = server.address();
				if (address === null || typeof address === 'string') {
					throw new TypeError('Expected a TCP address');
				}
				const base = `http://127.0.0.1:${String(address.port)}`;
				const warm = await fetch(`${base}/warm`);
				await warm.text();
				// Let the warm-up connection return to the idle pool, so the probe
				// reuses it as a kept-alive connection.
				await new Promise((resolve) => setTimeout(resolve, 50));

				// Only the deadline and backoff timers are fake, so the requests
				// still use real sockets. The second attempt's deadline never
				// expires, however long the server takes to answer it.
				vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
				const pending = fetchWithProbeRetries(
					fetch,
					`${base}/probe`,
					undefined,
					(response) => response.text()
				);
				await firstProbe.promise;
				await vi.advanceTimersByTimeAsync(probeDeadlineMs + maximumBackoffMs);

				expect({
					body: await pending,
					requests: requests.map(({ path, connection }) => ({
						path,
						connection: connection === 0 ? 'warm-up' : 'another'
					}))
				}).toStrictEqual({
					body: 'response body',
					requests: [
						{ path: '/warm', connection: 'warm-up' },
						{ path: '/probe', connection: 'warm-up' },
						{ path: '/probe', connection: 'another' }
					]
				});
			} finally {
				vi.useRealTimers();
				server.closeAllConnections();
				server.close();
				await once(server, 'close');
			}
		}
	);
});

interface ProbeServer {
	readonly url: string;
	requests(): number;
	/**
	Releases a response that waits for the client to receive its headers.
	*/
	headersReceived(): void;
	close(): Promise<void>;
}

type Misbehaviour = (
	response: ServerResponse,
	headersReceived: Promise<void>
) => void;

/**
Starts a local HTTP server whose first `failingRequests` requests receive
`misbehave`. Every later request receives `response body`.
*/
async function probeServer(
	failingRequests: number,
	misbehave: Misbehaviour
): Promise<ProbeServer> {
	let requests = 0;
	const headers = Promise.withResolvers<undefined>();
	const server = await loopbackServer((_request, response) => {
		requests += 1;
		if (requests > failingRequests) {
			response.end('response body');
			return;
		}
		misbehave(response, headers.promise);
	});

	return {
		url: `${server.origin}/probe`,
		requests: () => requests,
		headersReceived: () => {
			headers.resolve(undefined);
		},
		close: () => server.close()
	};
}

const bodyFailures = [
	{
		name: 'destroys the socket after the headers',
		code: 'UND_ERR_SOCKET',
		misbehave: destroyAfterHeaders()
	},
	{
		name: 'ends a Connection: close response before its Content-Length',
		code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
		misbehave: (response: ServerResponse) => {
			response.socket?.end(
				'HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial'
			);
		}
	},
	{
		name: 'resets the connection after the headers',
		code: 'ECONNRESET',
		misbehave: (response: ServerResponse, headersReceived: Promise<void>) => {
			response.writeHead(200, { 'content-length': '100' });
			response.write('partial');
			// The client's kernel can discard unread data when the reset
			// arrives, so reset only after the client has the headers.
			void headersReceived.then(() => response.socket?.resetAndDestroy());
		}
	}
] as const;

/**
Sends a gzip-encoded response whose bytes are not gzip, so decoding the
body fails after the headers.
*/
const corruptGzip: Misbehaviour = (response) => {
	response.writeHead(200, {
		'content-encoding': 'gzip',
		'content-length': '20'
	});
	response.end(Buffer.alloc(20, 7));
};

/**
Lists the name and code of `error` and of each error in its cause chain.
*/
function errorChain(error: unknown): { name: string; code: unknown }[] {
	const chain: { name: string; code: unknown }[] = [];
	for (
		let current: unknown = error;
		current instanceof Error;
		current = current.cause
	) {
		chain.push({
			name: current.name,
			code: 'code' in current ? current.code : undefined
		});
	}
	return chain;
}

function untimed(record: CapturedRecord): CapturedRecord {
	const { elapsedMs: _elapsedMs, ...properties } = record.properties;
	return { ...record, properties };
}

function bodyFailureFields(failure: unknown): unknown {
	return failure instanceof TypeError &&
		failure.cause instanceof Error &&
		'code' in failure.cause
		? { name: failure.name, causeCode: failure.cause.code }
		: failure;
}

describe('response body failures', () => {
	it.each(bodyFailures)(
		'sends a replay-safe probe again when the server $name',
		async ({ code, misbehave }) => {
			const records = captureLogs();
			const server = await probeServer(1, misbehave);
			try {
				const body = await fetchWithProbeRetries(
					fetch,
					server.url,
					undefined,
					(response) => {
						server.headersReceived();
						return response.text();
					},
					{ random: () => 0 }
				);
				const probe: Record<string, unknown> = {
					url: server.url,
					probeId: expect.any(String)
				};

				expect({
					body,
					requests: server.requests(),
					records: records.map((record) => untimed(record))
				}).toStrictEqual({
					body: 'response body',
					requests: 2,
					records: [
						probeLog('probe attempt finished', {
							...probe,
							attempt: 1,
							outcome: 'body failed',
							code
						}),
						probeLog('retrying probe after its response body failed', {
							...probe,
							nextAttempt: 2,
							delayMs: 0
						}),
						probeLog('probe attempt finished', {
							...probe,
							attempt: 2,
							outcome: 'succeeded'
						}),
						probeLog('logical probe finished', {
							...probe,
							attempts: 2,
							disposition: 'recovered'
						})
					]
				});
			} finally {
				await server.close();
			}
		}
	);

	it('sends a probe again when consume reports the body failure as the cause of its own error', async () => {
		const server = await probeServer(1, destroyAfterHeaders());
		try {
			const body = await fetchWithProbeRetries(
				fetch,
				server.url,
				undefined,
				async (response) => {
					try {
						return await response.text();
					} catch (error) {
						throw new Error('The response is invalid', { cause: error });
					}
				},
				{ random: () => 0 }
			);

			expect({ body, requests: server.requests() }).toStrictEqual({
				body: 'response body',
				requests: 2
			});
		} finally {
			await server.close();
		}
	});

	it.each([
		{
			name: 'a parse error that consume raises',
			misbehave: (response: ServerResponse) => {
				response.end('not json');
			},
			consume: (response: Response): Promise<unknown> => response.json(),
			failure: [{ name: 'SyntaxError', code: undefined }]
		},
		{
			name: 'a size limit that consume raises',
			misbehave: (response: ServerResponse) => {
				response.end('response body');
			},
			consume: (response: Response): Promise<unknown> =>
				readResponseText(response, {
					description: 'probe response',
					maximumBytes: 1
				}),
			failure: [{ name: 'RemoteBodyTooLargeError', code: undefined }]
		},
		{
			name: 'a connection closed before the headers',
			misbehave: (response: ServerResponse) => {
				response.socket?.destroy();
			},
			consume: (response: Response): Promise<unknown> => response.text(),
			failure: [
				{ name: 'TypeError', code: undefined },
				{ name: 'SocketError', code: 'UND_ERR_SOCKET' }
			]
		},
		{
			name: 'a corrupt gzip body',
			misbehave: corruptGzip,
			consume: (response: Response): Promise<unknown> => response.text(),
			failure: [
				{ name: 'TypeError', code: undefined },
				{ name: 'Error', code: 'Z_DATA_ERROR' }
			]
		},
		{
			name: 'a corrupt gzip body that consume wraps',
			misbehave: corruptGzip,
			consume: async (response: Response): Promise<unknown> => {
				try {
					return await response.text();
				} catch (error) {
					throw new TestFailure({ cause: error });
				}
			},
			failure: [
				{ name: 'TestFailure', code: undefined },
				{ name: 'TypeError', code: undefined },
				{ name: 'Error', code: 'Z_DATA_ERROR' }
			]
		}
	])(
		'rejects with $name without another attempt',
		async ({ misbehave, consume, failure }) => {
			const server = await probeServer(Infinity, misbehave);
			try {
				const error = await rejectionOf(
					fetchWithProbeRetries(fetch, server.url, undefined, consume)
				);

				expect({
					failure: errorChain(error),
					requests: server.requests()
				}).toStrictEqual({ failure, requests: 1 });
			} finally {
				await server.close();
			}
		}
	);

	it.each([
		{ replaySafety: 'replay-safe', attempts: maxProbeAttempts },
		{ replaySafety: 'replay-unsafe', attempts: 1 }
	] as const)(
		'makes $attempts attempts at a $replaySafety request whose body always fails',
		async ({ replaySafety, attempts }) => {
			const records = captureLogs();
			const server = await probeServer(Infinity, destroyAfterHeaders());
			try {
				const failure = await rejectionOf(
					requestWithDeadline(
						async (signal) => {
							const response = await fetch(server.url, { signal });
							return response.text();
						},
						{ target: { url: server.url }, replaySafety, random: () => 0 }
					)
				);

				expect({
					failure: bodyFailureFields(failure),
					requests: server.requests(),
					logical: records
						.filter((record) => record.message === 'logical probe finished')
						.map(({ properties }) => ({
							attempts: properties.attempts,
							disposition: properties.disposition
						}))
				}).toStrictEqual({
					failure: { name: 'TypeError', causeCode: 'UND_ERR_SOCKET' },
					requests: attempts,
					logical: [{ attempts, disposition: 'exhausted' }]
				});
			} finally {
				await server.close();
			}
		}
	);
});

describe('lookupInPages', () => {
	it('follows continuations within each page and returns results in input order', async () => {
		const requests: number[][] = [];
		const releases = new Map<number, () => void>();

		const pending = lookupInPages([1, 2, 3, 4, 5, 6, 7], {
			pageSize: 3,
			concurrency: 3,
			deadline: replaySafe,
			request: async (inputs) => {
				requests.push([...inputs]);
				const { promise, resolve } = Promise.withResolvers<undefined>();
				releases.set(inputs[0] ?? 0, () => {
					resolve(undefined);
				});
				await promise;
				return inputs.slice(0, 2).map((input) => input * 10);
			}
		});

		await vi.waitFor(() => {
			expect(releases.size).toBe(3);
		});
		for (const first of [7, 4, 1]) {
			releases.get(first)?.();
		}
		await vi.waitFor(() => {
			expect(releases.size).toBe(5);
		});
		for (const first of [6, 3]) {
			releases.get(first)?.();
		}

		expect({ results: await pending, requests }).toStrictEqual({
			results: [10, 20, 30, 40, 50, 60, 70],
			requests: [[1, 2, 3], [4, 5, 6], [7], [6], [3]]
		});
	});

	it('runs no more than the given number of requests at once', async () => {
		let inFlight = 0;
		let peak = 0;

		const results = await lookupInPages([1, 2, 3, 4, 5, 6], {
			pageSize: 1,
			concurrency: 2,
			deadline: replaySafe,
			request: async (inputs) => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 1));
				inFlight -= 1;
				return inputs;
			}
		});

		expect({ results, peak }).toStrictEqual({
			results: [1, 2, 3, 4, 5, 6],
			peak: 2
		});
	});

	it('finishes the first page before it starts the others when asked to', async () => {
		const events: string[] = [];

		const results = await lookupInPages(['a', 'b', 'c', 'd', 'e'], {
			pageSize: 2,
			concurrency: 2,
			finishFirstPage: true,
			deadline: replaySafe,
			request: async (inputs) => {
				events.push(`start ${inputs.join('')}`);
				await new Promise((resolve) => setTimeout(resolve, 1));
				events.push(`end ${inputs.join('')}`);
				return inputs.map((input) => input.toUpperCase());
			}
		});

		expect({ results, events: events.slice(0, 2) }).toStrictEqual({
			results: ['A', 'B', 'C', 'D', 'E'],
			events: ['start ab', 'end ab']
		});
	});

	it.each([
		{ name: 'no results', results: [] },
		{ name: 'more results than inputs', results: [1, 2, 3] }
	])('rejects a request that returns $name', async ({ results }) => {
		let requests = 0;

		const failure = await rejectionOf(
			lookupInPages([1, 2], {
				pageSize: 2,
				concurrency: 1,
				deadline: replaySafe,
				request: () => {
					requests += 1;
					return Promise.resolve(results);
				}
			})
		);

		expect({
			failure:
				failure instanceof PageResultCountError
					? { requested: failure.requested, returned: failure.returned }
					: failure,
			requests
		}).toStrictEqual({
			failure: { requested: 2, returned: results.length },
			requests: 1
		});
	});

	it('retries a page whose first attempt hangs past the deadline and keeps the input order', async () => {
		const requests: string[] = [];
		let hasHung = false;
		const fetcher: typeof fetch = (_input, init) => {
			const body = typeof init?.body === 'string' ? init.body : '';
			requests.push(body);
			if (body === '3,4' && !hasHung) {
				hasHung = true;
				return stalledResponse(init?.signal);
			}
			return Promise.resolve(Response.json(body.split(',').map(Number)));
		};

		vi.useFakeTimers();
		try {
			const pending = lookupInPages([1, 2, 3, 4, 5], {
				pageSize: 2,
				concurrency: 3,
				deadline: replaySafe,
				request: async (inputs, signal) => {
					const response = await fetcher(
						'https://cache.test/api/v1/path-info',
						{ method: 'POST', body: inputs.join(','), signal }
					);
					return z.array(z.number()).parse(await response.json());
				}
			});
			const settled = expect(pending).resolves.toStrictEqual([1, 2, 3, 4, 5]);
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + maximumBackoffMs);
			await settled;
		} finally {
			vi.useRealTimers();
		}

		expect(requests).toStrictEqual(['1,2', '3,4', '5', '3,4']);
	});

	it('sends a hung page of a replay-unsafe lookup once', async () => {
		const requests: number[][] = [];

		vi.useFakeTimers();
		try {
			const failure = rejectionOf(
				lookupInPages([1, 2, 3], {
					pageSize: 2,
					concurrency: 1,
					deadline: { target, replaySafety: 'replay-unsafe' },
					request: async (inputs, signal) => {
						requests.push([...inputs]);
						await stalled(signal);
						return inputs;
					}
				})
			);
			await vi.advanceTimersByTimeAsync(
				maxProbeAttempts * (probeDeadlineMs + maximumBackoffMs)
			);

			expect({
				failure: timeoutFields(await failure),
				requests
			}).toStrictEqual({
				failure: { name: 'ProbeTimeoutError', target: target.url },
				requests: [[1, 2]]
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('aborts the pages in progress when one page fails and rejects at once', async () => {
		const requests: number[][] = [];
		const failure = new TestFailure();

		vi.useFakeTimers();
		try {
			const rejection = rejectionOf(
				lookupInPages([1, 2], {
					pageSize: 1,
					concurrency: 2,
					deadline: replaySafe,
					request: async (inputs, signal) => {
						requests.push([...inputs]);
						if (inputs[0] === 2) {
							throw failure;
						}
						await stalled(signal);
						return inputs;
					}
				})
			);
			await vi.advanceTimersByTimeAsync(1);

			expect({ failure: await rejection, requests }).toStrictEqual({
				failure,
				requests: [[1], [2]]
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('halves a page that is too large and gives each smaller request its own deadline', async () => {
		const requests: number[][] = [];
		let hasHung = false;

		vi.useFakeTimers();
		try {
			const pending = lookupInPages([1, 2, 3, 4, 5], {
				pageSize: 5,
				concurrency: 1,
				deadline: replaySafe,
				isPageTooLarge: (error) => error instanceof TestFailure,
				request: async (inputs, signal) => {
					requests.push([...inputs]);
					if (inputs.length > 2) {
						throw new TestFailure();
					}
					if (!hasHung && inputs[0] === 3) {
						hasHung = true;
						await stalled(signal);
					}
					return inputs.map((input) => input * 10);
				}
			});
			const settled = expect(pending).resolves.toStrictEqual([
				10, 20, 30, 40, 50
			]);
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + maximumBackoffMs);
			await settled;
		} finally {
			vi.useRealTimers();
		}

		expect(requests).toStrictEqual([
			[1, 2, 3, 4, 5],
			[1, 2, 3],
			[1, 2],
			[3],
			[3],
			[4, 5]
		]);
	});
});

describe('lookupPage', () => {
	it('sends at most the request size that it reads before each request', async () => {
		const requests: number[][] = [];
		let requestSize = 3;

		const results = await lookupPage([1, 2, 3, 4, 5, 6], {
			deadline: replaySafe,
			requestSize: () => requestSize,
			request: (inputs) => {
				requests.push([...inputs]);
				requestSize = 2;
				return Promise.resolve(inputs);
			}
		});

		expect({ results, requests }).toStrictEqual({
			results: [1, 2, 3, 4, 5, 6],
			requests: [[1, 2, 3], [4, 5], [6]]
		});
	});
});

describe('probe debug logs', () => {
	it('records each attempt and the deadline retry without credentials or a query', async () => {
		const records = captureLogs();
		let requests = 0;
		const fetcher: typeof fetch = (_input, init) => {
			requests += 1;
			return requests === 1
				? stalledResponse(init?.signal)
				: Promise.resolve(new Response('response body'));
		};

		vi.useFakeTimers();
		try {
			const pending = fetchWithProbeRetries(
				fetcher,
				'https://reader:secret@cache.test/api/v1/path-info?token=secret',
				{ method: 'POST', body: 'paths' },
				(response) => response.text(),
				{ random: () => 0.5 }
			);
			const settled = expect(pending).resolves.toBe('response body');
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + maximumBackoffMs);
			await settled;
		} finally {
			vi.useRealTimers();
		}

		const probe = {
			url: 'https://cache.test/api/v1/path-info',
			probeId: records[0]?.properties.probeId
		};
		expect(probe.probeId).toEqual(expect.any(String));
		expect(records).toStrictEqual([
			probeLog('probe attempt finished', {
				...probe,
				attempt: 1,
				outcome: 'timed out',
				elapsedMs: probeDeadlineMs
			}),
			probeLog('retrying probe after its deadline expired', {
				...probe,
				nextAttempt: 2,
				delayMs: 125
			}),
			probeLog('probe attempt finished', {
				...probe,
				attempt: 2,
				outcome: 'succeeded',
				elapsedMs: 0
			}),
			probeLog('logical probe finished', {
				...probe,
				attempts: 2,
				disposition: 'recovered',
				elapsedMs: probeDeadlineMs + 125
			})
		]);
	});

	it('records the number of inputs in each page request', async () => {
		const records = captureLogs();

		await lookupInPages([1, 2, 3], {
			pageSize: 2,
			concurrency: 1,
			deadline: replaySafe,
			request: (inputs) => Promise.resolve(inputs)
		});

		expect(
			records
				.filter((record) => record.message === 'probe attempt finished')
				.map(({ properties }) => ({
					inputs: properties.inputs,
					outcome: properties.outcome
				}))
		).toStrictEqual([
			{ inputs: 2, outcome: 'succeeded' },
			{ inputs: 1, outcome: 'succeeded' }
		]);
	});

	it('records a failed attempt by its error name and does not retry it', async () => {
		const records = captureLogs();

		vi.useFakeTimers();
		let failure: unknown;
		try {
			failure = await rejectionOf(
				fetchWithProbeRetries(
					() => Promise.reject(new TestFailure()),
					'https://cache.test/a.narinfo',
					undefined,
					(response) => response.text()
				)
			);
		} finally {
			vi.useRealTimers();
		}

		expect({
			isTestFailure: failure instanceof TestFailure,
			records
		}).toStrictEqual({
			isTestFailure: true,
			records: [
				probeLog('probe attempt finished', {
					probeId: expect.any(String),
					url: 'https://cache.test/a.narinfo',
					attempt: 1,
					outcome: 'failed',
					errorName: 'TestFailure',
					elapsedMs: 0
				}),
				probeLog('logical probe finished', {
					probeId: expect.any(String),
					url: 'https://cache.test/a.narinfo',
					attempts: 1,
					disposition: 'failed',
					elapsedMs: 0
				})
			]
		});
	});
});
