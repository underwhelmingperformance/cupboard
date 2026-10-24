import { once } from 'node:events';
import { createServer } from 'node:http';

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { NoopSpanProcessor } from '@opentelemetry/sdk-trace';
import { StatusCodes } from 'http-status-codes';
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import { captureLogs } from './log-capture.test-support.ts';
import { initialiseTracing, stopTracing } from './node-tracing.ts';
import { readResponseBytes, readResponseJson } from './response-body.ts';
import { retryingFetcher } from './retry.ts';

initialiseTracing();

afterAll(stopTracing);

describe('HTTP attempt observation', () => {
	it('ends the attempt span when request preparation fails', async () => {
		const records = captureLogs();
		const completed = vi.spyOn(NoopSpanProcessor.prototype, 'onEnd');
		onTestFinished(() => {
			completed.mockRestore();
		});
		const transport = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response('unexpected request'))
		);
		const fetcher = retryingFetcher(transport, 'replay-unsafe', {
			trustedOrigin: 'https://cupboard.example.test'
		});
		let failure: unknown;

		try {
			await fetcher('https://cupboard.example.test/api', {
				headers: [['bad header', 'value']]
			});
		} catch (error) {
			failure = error;
		}

		expect({
			invalidHeaders: failure instanceof TypeError,
			requests: transport.mock.calls.length,
			completed: completed.mock.calls.map(([span]) => ({
				kind: span.kind,
				status: span.status.code
			})),
			failedAttempts: records
				.filter((record) => record.properties.error instanceof TypeError)
				.map(({ properties }) => properties.attempt)
		}).toStrictEqual({
			invalidHeaders: true,
			requests: 0,
			completed: [
				{ kind: SpanKind.CLIENT, status: SpanStatusCode.ERROR },
				{ kind: SpanKind.INTERNAL, status: SpanStatusCode.ERROR }
			],
			failedAttempts: [1, undefined]
		});
	});

	it.each(['pre-aborted', 'replay-unsafe', 'backoff'] as const)(
		'records cancellation during %s',
		async (phase) => {
			const records = captureLogs();
			const controller = new AbortController();
			const reason = new DOMException('cancelled', 'AbortError');
			const replaySafety =
				phase === 'replay-unsafe' ? 'replay-unsafe' : 'replay-safe';
			let attempts = 0;

			if (phase === 'pre-aborted') {
				controller.abort(reason);
			}

			const fetcher = retryingFetcher(() => {
				attempts += 1;

				if (phase === 'replay-unsafe') {
					controller.abort(reason);
					return Promise.reject(reason);
				}

				setTimeout(() => {
					controller.abort(reason);
				}, 0);

				return Promise.resolve(
					new Response(undefined, {
						status: StatusCodes.SERVICE_UNAVAILABLE,
						headers: { 'retry-after': '60' }
					})
				);
			}, replaySafety);

			await expect(
				fetcher('https://cupboard.example.test/api', {
					signal: controller.signal
				})
			).rejects.toBe(reason);
			expect({
				attempts,
				outcomes: records
					.filter((record) => record.properties.disposition !== undefined)
					.map(({ properties }) => ({
						attempts: properties.attempts,
						disposition: properties.disposition,
						replaySafety: properties.replaySafety
					}))
			}).toStrictEqual({
				attempts: phase === 'pre-aborted' ? 0 : 1,
				outcomes: [
					{
						attempts: phase === 'pre-aborted' ? 0 : 1,
						disposition: 'cancelled',
						replaySafety
					}
				]
			});
		}
	);

	it('correlates JSON decoding failures with the response', async () => {
		const records = captureLogs();
		const fetcher = retryingFetcher(
			() =>
				Promise.resolve(
					new Response('{', {
						headers: { 'x-request-id': 'invalid-json-request' }
					})
				),
			'replay-unsafe'
		);
		const response = await fetcher('https://cache.example.test/invalid-json');

		await expect(
			readResponseJson(response, {
				description: 'invalid JSON',
				maximumBytes: 1024
			})
		).rejects.toBeInstanceOf(SyntaxError);
		expect(
			records
				.filter((record) => record.properties.error instanceof SyntaxError)
				.map((record) => ({
					requestId: record.properties.requestId,
					error: record.properties.error instanceof SyntaxError
				}))
		).toStrictEqual([
			{
				requestId: 'invalid-json-request',
				error: true
			}
		]);
	});

	it('records a replay-unsafe refusal with server correlation identifiers', async () => {
		const records = captureLogs();
		const response = new Response('refused', {
			status: StatusCodes.SERVICE_UNAVAILABLE,
			headers: { 'x-request-id': 'server-request', 'cf-ray': 'ray-LHR' }
		});
		let attempts = 0;
		const fetcher = retryingFetcher(() => {
			attempts += 1;

			return Promise.resolve(response);
		}, 'replay-unsafe');

		expect(await fetcher('https://cache.example.test/roots')).toBe(response);
		expect({
			attempts,
			observations: records
				.filter((record) => record.properties.attempt !== undefined)
				.map(({ properties }) => ({
					attempt: properties.attempt,
					status: properties.status,
					requestId: properties.requestId,
					cfRay: properties.cfRay,
					replaySafety: properties.replaySafety
				}))
		}).toStrictEqual({
			attempts: 1,
			observations: [
				{
					attempt: 1,
					status: undefined,
					requestId: undefined,
					cfRay: undefined,
					replaySafety: 'replay-unsafe'
				},
				{
					attempt: 1,
					status: StatusCodes.SERVICE_UNAVAILABLE,
					requestId: 'server-request',
					cfRay: 'ray-LHR',
					replaySafety: 'replay-unsafe'
				}
			]
		});
	});

	it.each([
		[
			'https://cupboard.example.test/api',
			'https://cupboard.example.test',
			true
		],
		[
			'https://storage.example.test/object',
			'https://cupboard.example.test',
			false
		],
		['https://cupboard.example.test/api', undefined, false]
	])(
		'propagates context only to a recognised origin (%s)',
		async (url, trustedOrigin, shouldPropagate) => {
			let headers = new Headers();
			let redirect: RequestRedirect | undefined;
			const fetcher = retryingFetcher(
				(_input, init) => {
					headers = new Headers(init?.headers);
					redirect = init?.redirect;
					return Promise.resolve(new Response('ok'));
				},
				'replay-unsafe',
				{ trustedOrigin }
			);
			await fetcher(url, { redirect: 'manual' });

			expect({
				propagated: /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u.test(
					headers.get('traceparent') ?? ''
				),
				redirect
			}).toStrictEqual({
				propagated: shouldPropagate,
				redirect: 'manual'
			});
		}
	);

	it.each([
		{ requestRedirect: undefined, redirect: undefined, propagated: false },
		{ requestRedirect: undefined, redirect: 'follow', propagated: false },
		{ requestRedirect: undefined, redirect: 'manual', propagated: true },
		{ requestRedirect: undefined, redirect: 'error', propagated: true },
		{ requestRedirect: 'follow', redirect: undefined, propagated: false },
		{ requestRedirect: 'manual', redirect: undefined, propagated: true },
		{ requestRedirect: 'error', redirect: undefined, propagated: true },
		{ requestRedirect: 'manual', redirect: 'follow', propagated: false },
		{ requestRedirect: 'follow', redirect: 'error', propagated: true }
	] satisfies readonly {
		readonly requestRedirect: RequestRedirect | undefined;
		readonly redirect: RequestRedirect | undefined;
		readonly propagated: boolean;
	}[])(
		'preserves redirect mode for request $requestRedirect and init $redirect',
		async ({ requestRedirect, redirect, propagated }) => {
			const request = new Request('https://cupboard.example.test/api', {
				redirect: requestRedirect
			});
			let observed:
				{ redirect: RequestRedirect; propagated: boolean } | undefined;
			const fetcher = retryingFetcher(
				(input, init) => {
					const current = new Request(input, init);
					observed = {
						redirect: current.redirect,
						propagated: /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u.test(
							current.headers.get('traceparent') ?? ''
						)
					};
					return Promise.resolve(new Response('ok'));
				},
				'replay-unsafe',
				{ trustedOrigin: 'https://cupboard.example.test' }
			);
			await fetcher(request, { redirect });

			expect(observed).toStrictEqual({
				redirect: redirect ?? requestRedirect ?? 'follow',
				propagated
			});
		}
	);

	it.each([false, true])(
		'follows redirects without propagating context across origins: %s',
		async (crossOrigin) => {
			const requests: {
				path: string;
				traceparent: string | string[] | undefined;
				tracestate: string | string[] | undefined;
			}[] = [];
			let location = '';
			const server = createServer((request, response) => {
				requests.push({
					path: request.url ?? '',
					traceparent: request.headers.traceparent,
					tracestate: request.headers.tracestate
				});
				request.resume();

				if (request.url === '/redirect') {
					response.writeHead(StatusCodes.TEMPORARY_REDIRECT, { location });
					response.end();
					return;
				}

				response.end('redirected body');
			});
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');

			try {
				const address = server.address();

				if (address === null || typeof address === 'string') {
					throw new TypeError('Expected a TCP address');
				}

				const origin = `http://127.0.0.1:${String(address.port)}`;
				location = crossOrigin
					? `http://localhost:${String(address.port)}/destination`
					: '/destination';
				const fetcher = retryingFetcher(fetch, 'replay-unsafe', {
					trustedOrigin: origin
				});
				const response = await fetcher(`${origin}/redirect`, {
					headers: { traceparent: 'stale-parent', tracestate: 'client=stale' }
				});

				expect({
					status: response.status,
					redirected: response.redirected,
					body: await response.text(),
					requests: requests.map(({ path, traceparent, tracestate }) => ({
						path,
						tracestate,
						propagated:
							typeof traceparent === 'string' &&
							/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u.test(traceparent),
						sameParent:
							typeof traceparent === 'string' &&
							traceparent === requests[0]?.traceparent
					}))
				}).toStrictEqual({
					status: StatusCodes.OK,
					redirected: true,
					body: 'redirected body',
					requests: [
						{
							path: '/redirect',
							tracestate: undefined,
							propagated: true,
							sameParent: true
						},
						{
							path: '/destination',
							tracestate: undefined,
							propagated: !crossOrigin,
							sameParent: !crossOrigin
						}
					]
				});
			} finally {
				server.closeAllConnections();
				server.close();
				await once(server, 'close');
			}
		}
	);

	it.each([
		['recovered', [StatusCodes.SERVICE_UNAVAILABLE, StatusCodes.OK]],
		[
			'exhausted',
			[
				StatusCodes.SERVICE_UNAVAILABLE,
				StatusCodes.SERVICE_UNAVAILABLE,
				StatusCodes.SERVICE_UNAVAILABLE,
				StatusCodes.SERVICE_UNAVAILABLE,
				StatusCodes.SERVICE_UNAVAILABLE
			]
		]
	] as const)(
		'records the final retry disposition (%s)',
		async (disposition, statuses) => {
			const records = captureLogs();
			const random = vi.spyOn(Math, 'random').mockReturnValue(0);
			let attempts = 0;

			try {
				const fetcher = retryingFetcher(
					() =>
						Promise.resolve(
							new Response(undefined, { status: statuses[attempts++] })
						),
					'replay-safe',
					{ operation: 'probe' }
				);
				await fetcher('https://cupboard.example.test/api');

				expect(
					records
						.filter((record) => record.properties.disposition !== undefined)
						.map((record) => ({
							attempts: record.properties.attempts,
							disposition: record.properties.disposition,
							status: record.properties.status
						}))
				).toStrictEqual([
					{ attempts: statuses.length, disposition, status: statuses.at(-1) }
				]);
			} finally {
				random.mockRestore();
			}
		}
	);

	it('distinguishes a failed body from successful response headers', async () => {
		const records = captureLogs();
		const failure = new Error('connection reset during the body');
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(failure);
			}
		});
		const fetcher = retryingFetcher(
			() =>
				Promise.resolve(
					new Response(body, {
						headers: { 'x-request-id': 'body-request', 'cf-ray': 'body-ray' }
					})
				),
			'replay-unsafe'
		);
		const response = await fetcher('https://cupboard.example.test/api');

		await expect(
			readResponseBytes(response, {
				description: 'test body',
				maximumBytes: 1024
			})
		).rejects.toBe(failure);
		expect(
			records
				.filter((record) => record.properties.error === failure)
				.map(({ properties }) => ({
					requestId: properties.requestId,
					cfRay: properties.cfRay,
					status: properties.status,
					error: properties.error
				}))
		).toStrictEqual([
			{
				requestId: 'body-request',
				cfRay: 'body-ray',
				status: StatusCodes.OK,
				error: failure
			}
		]);
	});
});
