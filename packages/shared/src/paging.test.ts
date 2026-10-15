import { once } from 'node:events';
import { createServer } from 'node:http';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { stalledResponse } from '../../../tests/support/stalled-request.ts';

import {
	type CapturedRecord,
	captureLogs
} from './log-capture.test-support.ts';
import {
	fetchWithProbeRetries,
	lookupInPages,
	maxProbeAttempts,
	PageResultCountError,
	requestWithDeadline
} from './paging.ts';
import { probeDeadlineMs, ProbeTimeoutError } from './timeout.ts';

class TestFailure extends Error {
	constructor() {
		super('test failure');
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
		? { name: failure.name, url: failure.url }
		: failure;
}

describe('requestWithDeadline', () => {
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
					failure: { name: 'ProbeTimeoutError', url: target.url },
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
				failure: { name: 'ProbeTimeoutError', url: target.url },
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

describe('probe debug logs', () => {
	it('records each attempt and the deadline retry without credentials or a query', async () => {
		const records = captureLogs();
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
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
				(response) => response.text()
			);
			const settled = expect(pending).resolves.toBe('response body');
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + maximumBackoffMs);
			await settled;
		} finally {
			vi.useRealTimers();
			random.mockRestore();
		}

		const probe = { url: 'https://cache.test/api/v1/path-info' };
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
			records.map(({ properties }) => ({
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
					url: 'https://cache.test/a.narinfo',
					attempt: 1,
					outcome: 'failed',
					errorName: 'TestFailure',
					elapsedMs: 0
				})
			]
		});
	});
});
