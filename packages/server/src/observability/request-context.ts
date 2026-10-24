import { withContext } from '@cupboard/logger';
import { StatusCodes } from 'http-status-codes';

import { requestCorrelation } from './correlation.ts';
import { requestLogger } from './logging.ts';
import { type SpanAttributes, withSpan } from './span.ts';
import { upstreamTraceAttributes } from './trace-context.ts';

const serverErrorStatus: number = StatusCodes.INTERNAL_SERVER_ERROR;

const requestIdHeader = 'x-request-id';
const clientTraceHeader = 'x-cupboard-client-trace-id';
const clientSpanHeader = 'x-cupboard-client-span-id';
const internalHeaders = [requestIdHeader, clientTraceHeader, clientSpanHeader];
const correlationHeaders = [
	...internalHeaders,
	'traceparent',
	'tracestate',
	'baggage'
];

/**
Copies correlation fields between requests dispatched through trusted bindings.
*/
export function internalCorrelationHeaders(headers: Headers): Headers {
	const result = new Headers();

	for (const key of [...internalHeaders, 'cf-ray']) {
		const value = headers.get(key);

		if (value !== null) {
			result.set(key, value);
		}
	}

	return result;
}

/**
Establishes request scope before authentication, routing or DO initialisation.
*/
export function withInternalRequest(
	request: Request,
	run: () => Promise<Response>
): Promise<Response> {
	const fields = requestCorrelation(request);
	const attributes: SpanAttributes = {
		'cupboard.request_id': fields.requestId,
		'cloudflare.ray_id': fields.cfRay,
		'cupboard.upstream.trace_id': fields.clientTraceId,
		'cupboard.upstream.span_id': fields.clientSpanId,
		'cupboard.upstream.untrusted':
			fields.clientTraceId !== undefined || undefined,
		'http.request.method': request.method,
		'url.path': new URL(request.url).pathname
	};

	return withContext(fields, () =>
		withSpan('cupboard.request', attributes, async (span) => {
			const logger = requestLogger(request);
			const started = performance.now();

			logger.debug('request started');

			try {
				const response = await run();

				span.setAttribute('http.response.status_code', response.status);

				if (response.status >= serverErrorStatus) {
					span.setAttribute('error.type', String(response.status));
				}
				logger.debug('request completed', {
					status: response.status,
					elapsedMs: performance.now() - started
				});

				return response;
			} catch (error) {
				span.setAttribute(
					'error.type',
					error instanceof Error ? error.name : 'Error'
				);
				logger.error('request failed', {
					elapsedMs: performance.now() - started,
					error
				});
				throw error;
			}
		})
	);
}

/**
Replaces public correlation headers and returns a fresh server request ID.
*/
export async function withPublicRequest(
	request: Request,
	run: (request: Request) => Response | Promise<Response>
): Promise<Response> {
	const headers = new Headers(request.headers);

	for (const header of internalHeaders) {
		headers.delete(header);
	}

	const upstream = upstreamTraceAttributes(headers);

	for (const key of [
		...internalHeaders,
		'traceparent',
		'tracestate',
		'baggage'
	]) {
		headers.delete(key);
	}

	const requestId = crypto.randomUUID();
	headers.set(requestIdHeader, requestId);

	const clientTraceId = upstream['cupboard.upstream.trace_id'];
	const clientSpanId = upstream['cupboard.upstream.span_id'];

	if (typeof clientTraceId === 'string' && typeof clientSpanId === 'string') {
		headers.set(clientTraceHeader, clientTraceId);
		headers.set(clientSpanHeader, clientSpanId);
	}

	const internal = new Request(request, { headers });
	const response = await withInternalRequest(internal, () =>
		Promise.resolve(run(internal))
	);
	const responseHeaders = new Headers(response.headers);

	for (const key of [...correlationHeaders, 'cf-ray']) {
		responseHeaders.delete(key);
	}

	responseHeaders.set(requestIdHeader, requestId);

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
		...(response.webSocket !== null && { webSocket: response.webSocket }),
		encodeBody: 'manual'
	});
}

/**
Removes per-request response context before the tenant Worker caches content.
*/
export function withoutCachedCorrelation(response: Response): Response {
	const headers = new Headers(response.headers);

	for (const key of [...correlationHeaders, 'cf-ray']) {
		headers.delete(key);
	}

	const vary = headers.get('vary');

	if (vary !== null) {
		const fields = vary
			.split(',')
			.map((field) => field.trim())
			.filter(
				(field) =>
					![...correlationHeaders, 'cf-ray'].includes(field.toLowerCase())
			);

		if (fields.length === 0) {
			headers.delete('vary');
		} else {
			headers.set('vary', fields.join(', '));
		}
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
		encodeBody: 'manual'
	});
}
