import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	withoutCachedCorrelation,
	withPublicRequest
} from './request-context.ts';

const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const spanId = '00f067aa0ba902b7';

describe('public request correlation', () => {
	it('discards forged internal identifiers without a W3C parent', async () => {
		let forwarded:
			{ traceId: string | undefined; spanId: string | undefined } | undefined;
		await withPublicRequest(
			new Request('https://cache.example.test/t/acme', {
				headers: {
					'x-cupboard-client-trace-id': traceId,
					'x-cupboard-client-span-id': spanId
				}
			}),
			(request) => {
				forwarded = {
					traceId:
						request.headers.get('x-cupboard-client-trace-id') ?? undefined,
					spanId: request.headers.get('x-cupboard-client-span-id') ?? undefined
				};
				return Promise.resolve(new Response('ok'));
			}
		);

		expect(forwarded).toStrictEqual({ traceId: undefined, spanId: undefined });
	});

	it('replaces caller identifiers and strips parent context before dispatch', async () => {
		let headers: Headers | undefined;
		const response = await withPublicRequest(
			new Request('https://cache.example.test/t/acme', {
				headers: {
					'x-request-id': 'spoofed',
					'x-cupboard-client-trace-id': 'spoofed',
					traceparent: `00-${traceId}-${spanId}-01`,
					tracestate: 'vendor=secret',
					baggage: 'secret=value'
				}
			}),
			(request) => {
				headers = request.headers;

				return Promise.resolve(
					new Response('refused', { status: StatusCodes.UNAUTHORIZED })
				);
			}
		);
		const requestId = response.headers.get('x-request-id');

		expect({
			status: response.status,
			fresh: requestId !== null && requestId !== 'spoofed',
			dispatchedId: headers?.get('x-request-id'),
			parent: headers?.has('traceparent'),
			state: headers?.has('tracestate'),
			baggage: headers?.has('baggage'),
			clientTraceId: headers?.get('x-cupboard-client-trace-id'),
			clientSpanId: headers?.get('x-cupboard-client-span-id')
		}).toStrictEqual({
			status: StatusCodes.UNAUTHORIZED,
			fresh: true,
			dispatchedId: requestId,
			parent: false,
			state: false,
			baggage: false,
			clientTraceId: traceId,
			clientSpanId: spanId
		});
	});

	it('removes correlation headers before a response enters Workers Cache', async () => {
		const response = withoutCachedCorrelation(
			new Response('cache content', {
				headers: {
					'cache-control': 'public, max-age=3600',
					'content-type': 'text/plain',
					'x-request-id': 'old',
					'x-cupboard-client-trace-id': traceId,
					'x-cupboard-client-span-id': spanId,
					traceparent: `00-${traceId}-${spanId}-01`,
					tracestate: 'vendor=value',
					baggage: 'key=value',
					'cf-ray': 'old-ray',
					vary: 'Accept-Encoding, X-Request-ID, Traceparent, CF-Ray'
				}
			})
		);

		expect({
			headers: Object.fromEntries(response.headers),
			body: await response.text()
		}).toStrictEqual({
			headers: {
				'cache-control': 'public, max-age=3600',
				'content-type': 'text/plain',
				vary: 'Accept-Encoding'
			},
			body: 'cache content'
		});
	});

	it('adds a fresh identifier to each cached response', async () => {
		const cached = new Response('cached', {
			headers: { 'x-request-id': 'old' }
		});
		const respond = (): Promise<Response> => Promise.resolve(cached.clone());
		const responses = await Promise.all([
			withPublicRequest(new Request('https://cache.example.test/'), respond),
			withPublicRequest(new Request('https://cache.example.test/'), respond)
		]);
		const ids = responses.map((response) =>
			response.headers.get('x-request-id')
		);

		expect({
			unique: new Set(ids).size,
			stale: ids.includes('old'),
			valid: ids.every(
				(id) => typeof id === 'string' && /^[0-9a-f-]{36}$/u.test(id)
			)
		}).toStrictEqual({ unique: 2, stale: false, valid: true });
	});
});
