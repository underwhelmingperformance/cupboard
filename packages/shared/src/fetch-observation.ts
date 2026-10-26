import { getLogger, withContext } from '@logtape/logtape';
import {
	type Context,
	context,
	createContextKey,
	isSpanContextValid,
	propagation,
	SpanKind,
	SpanStatusCode,
	trace
} from '@opentelemetry/api';
import { StatusCodes } from 'http-status-codes';

import type { ReplaySafety } from './retry.ts';
import { isDeadlineAbort } from './timeout.ts';

const firstErrorStatus: number = StatusCodes.BAD_REQUEST;

const logger = getLogger(['cupboard', 'http']);
const responses = new WeakMap<object, ResponseObservation>();
const activeAttempts = new Set<symbol>();
const operationContextKey = createContextKey('cupboard.http.operation');
const attemptContextKey = createContextKey('cupboard.http.attempt');

type FetchDisposition =
	'returned' | 'recovered' | 'exhausted' | 'failed' | 'cancelled';

class HttpOperationContext {
	attempts = 0;
	disposition: FetchDisposition | undefined;
}

export function recordFetchOutcome(disposition: FetchDisposition): void {
	const state = context.active().getValue(operationContextKey);

	if (state instanceof HttpOperationContext) {
		state.disposition = disposition;
	}
}

class HttpAttemptContext {
	followPropagation: FollowTracePropagation | undefined;

	constructor(readonly fields: Record<string, unknown>) {}
}

interface FollowTracePropagation {
	readonly trustedOrigin: string;
	readonly headers: Readonly<Record<string, string>>;
}

interface TracedFetchRequest {
	readonly init: Parameters<typeof fetch>[1];
	readonly followPropagation?: FollowTracePropagation;
}

export function currentHttpAttemptFields():
	Record<string, unknown> | undefined {
	const observation = context.active().getValue(attemptContextKey);

	return observation instanceof HttpAttemptContext
		? observation.fields
		: undefined;
}

export function currentHttpAttemptTraceHeaders(
	origin: string
): Readonly<Record<string, string>> | undefined {
	const observation = context.active().getValue(attemptContextKey);

	if (
		!(observation instanceof HttpAttemptContext) ||
		observation.followPropagation?.trustedOrigin !== origin
	) {
		return undefined;
	}

	return observation.followPropagation.headers;
}

export interface FetchObservationOptions {
	readonly operation?: string;
	readonly trustedOrigin?: string;
}

interface ResponseObservation {
	readonly context: Context;
	readonly fields: Record<string, unknown>;
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL | null {
	return URL.parse(input instanceof Request ? input.url : input.toString());
}

function tracedRequest(
	url: URL | null,
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	options: FetchObservationOptions
): TracedFetchRequest {
	const spanContext = trace.getSpanContext(context.active());

	if (
		url === null ||
		spanContext === undefined ||
		url.origin !== options.trustedOrigin ||
		!isSpanContextValid(spanContext)
	) {
		return { init };
	}

	const headers = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined)
	);
	const carrier: Record<string, string> = {};

	propagation.inject(context.active(), carrier);
	const redirect =
		init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');

	if (redirect === 'follow') {
		// Fetch reuses its headers on redirects. Inject only into each dispatch.
		headers.delete('traceparent');
		headers.delete('tracestate');
		return {
			init: { ...init, headers },
			followPropagation: { trustedOrigin: url.origin, headers: carrier }
		};
	}

	for (const [key, value] of Object.entries(carrier)) {
		headers.set(key, value);
	}

	return { init: { ...init, headers } };
}

export async function observeFetchOperation(
	run: () => Promise<Response>,
	details: FetchObservationOptions & {
		readonly replaySafety: ReplaySafety;
		readonly signal?: AbortSignal;
	}
): Promise<Response> {
	const started = performance.now();
	const operation = details.operation ?? 'http.request';
	const state = new HttpOperationContext();

	return trace.getTracer('cupboard.http').startActiveSpan(operation, (span) =>
		context.with(
			context.active().setValue(operationContextKey, state),
			async () => {
				try {
					const response = await run();
					const disposition =
						state.disposition ??
						(state.attempts > 1 && response.status < firstErrorStatus
							? 'recovered'
							: 'returned');
					span.setAttribute('cupboard.attempts', state.attempts);
					span.setAttribute('http.response.status_code', response.status);

					if (response.status >= firstErrorStatus) {
						span.setStatus({ code: SpanStatusCode.ERROR });
					}

					logger.trace('HTTP operation completed', () => ({
						operation,
						attempts: state.attempts,
						disposition,
						replaySafety: details.replaySafety,
						status: response.status,
						requestId: response.headers.get('x-request-id')?.slice(0, 128),
						cfRay: response.headers.get('cf-ray')?.slice(0, 128),
						elapsedMs: performance.now() - started
					}));

					return response;
				} catch (error) {
					span.setStatus({ code: SpanStatusCode.ERROR });
					logger.debug('HTTP operation failed', () => ({
						operation,
						attempts: state.attempts,
						disposition: isDeadlineAbort(details.signal)
							? 'deadline'
							: details.signal?.aborted === true
								? 'cancelled'
								: (state.disposition ?? 'failed'),
						replaySafety: details.replaySafety,
						elapsedMs: performance.now() - started,
						error
					}));

					throw error;
				} finally {
					span.end();
				}
			}
		)
	);
}

/**
Observes one transport attempt without changing its replay policy.
*/
export async function observeFetchAttempt(
	fetcher: typeof fetch,
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	details: FetchObservationOptions & {
		readonly attempt: number;
		readonly replaySafety: ReplaySafety;
	}
): Promise<Response> {
	const operation = context.active().getValue(operationContextKey);

	if (operation instanceof HttpOperationContext) {
		operation.attempts += 1;
	}

	const url = requestUrl(input);
	const method =
		init?.method ?? (input instanceof Request ? input.method : 'GET');
	const fields = {
		operation: details.operation ?? 'http.request',
		method,
		url: url === null ? 'an unparsable URL' : `${url.origin}${url.pathname}`,
		attempt: details.attempt,
		replaySafety: details.replaySafety
	};
	const started = performance.now();
	const attempt = Symbol();

	return trace.getTracer('cupboard.http').startActiveSpan(
		fields.operation,
		{
			kind: SpanKind.CLIENT,
			attributes: {
				'http.request.method': method,
				'server.address': url?.hostname ?? 'unknown',
				'url.full': fields.url,
				'cupboard.attempt': details.attempt,
				'cupboard.replay_safety': details.replaySafety
			}
		},
		async (span) => {
			const observation = new HttpAttemptContext(fields);

			return context.with(
				context.active().setValue(attemptContextKey, observation),
				async () => {
					activeAttempts.add(attempt);
					logger.trace('HTTP attempt started', {
						...fields,
						inFlight: activeAttempts.size
					});

					try {
						const request = tracedRequest(url, input, init, details);
						observation.followPropagation = request.followPropagation;
						const response = await fetcher(input, request.init);
						const requestId = response.headers
							.get('x-request-id')
							?.slice(0, 128);
						const cfRay = response.headers.get('cf-ray')?.slice(0, 128);
						const responseFields = {
							...fields,
							status: response.status,
							...(requestId !== undefined && { requestId }),
							...(cfRay !== undefined && { cfRay })
						};

						span.setAttributes({
							'http.response.status_code': response.status,
							...(requestId !== undefined && {
								'cupboard.request_id': requestId
							}),
							...(cfRay !== undefined && { 'cloudflare.ray_id': cfRay })
						});
						if (response.status >= firstErrorStatus) {
							span.setStatus({ code: SpanStatusCode.ERROR });
						}

						responses.set(response, {
							context: context.active(),
							fields: responseFields
						});
						logger.debug('HTTP response headers received', () => ({
							...responseFields,
							elapsedMs: performance.now() - started
						}));

						return response;
					} catch (error) {
						span.setStatus({ code: SpanStatusCode.ERROR });
						const signal =
							init?.signal ??
							(input instanceof Request ? input.signal : undefined);
						logger.debug('HTTP attempt failed', () => ({
							...fields,
							failureKind: isDeadlineAbort(signal)
								? 'deadline'
								: signal?.aborted === true
									? 'cancelled'
									: 'transport',
							elapsedMs: performance.now() - started,
							error
						}));

						throw error;
					} finally {
						activeAttempts.delete(attempt);
						span.end();
					}
				}
			);
		}
	);
}

/**
Restores attempt correlation while a caller consumes the response body.
*/
export async function observeResponseBody<T>(
	response: object,
	read: () => T | Promise<T>
): Promise<T> {
	const observation = responses.get(response);

	if (observation === undefined) {
		return read();
	}

	const started = performance.now();

	return context.with(observation.context, () =>
		withContext(observation.fields, () =>
			trace
				.getTracer('cupboard.http')
				.startActiveSpan('http.response.body', async (span) => {
					try {
						const result = await read();
						logger.trace('HTTP response body completed', () => ({
							...observation.fields,
							elapsedMs: performance.now() - started
						}));

						return result;
					} catch (error) {
						span.setStatus({ code: SpanStatusCode.ERROR });
						logger.debug('HTTP response body failed', () => ({
							...observation.fields,
							elapsedMs: performance.now() - started,
							error
						}));

						throw error;
					} finally {
						span.end();
					}
				})
		)
	);
}
