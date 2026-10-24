import { StatusCodes } from 'http-status-codes';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { captureLogs } from './log-capture.test-support.ts';
import { initialiseTracing, stopTracing } from './node-tracing.ts';
import { readResponseBytes, readResponseJson } from './response-body.ts';
import { retryingFetcher } from './retry.ts';

initialiseTracing();

afterAll(stopTracing);

describe('HTTP attempt observation', () => {
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
			await fetcher(url);

			expect({
				propagated: /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u.test(
					headers.get('traceparent') ?? ''
				),
				redirect
			}).toStrictEqual({
				propagated: shouldPropagate,
				redirect: shouldPropagate ? 'manual' : undefined
			});
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
